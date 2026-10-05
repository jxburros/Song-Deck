"""
Command-line plumbing shared by every bridge script.

Common flags (``build_parser``)::

    --host 127.0.0.1          interface to bind (loopback = this machine only)
    --port N                  TCP port (each bridge defaults to its Song Deck preset port; 0 = any free port)
    --token SECRET            require "Authorization: Bearer SECRET" (default: $SONGDECK_BRIDGE_TOKEN)
    --model ID                model to load / report (bridge specific)
    --device auto|cpu|cuda|cuda:N|mps
    --allow-origin URL        CORS origin (repeatable; replaces the Song Deck defaults; '*' = any)
    --allow-host NAME         extra Host name accepted while bound to loopback (DNS-rebinding guard)
    --max-body-mb 512         request size limit
    --max-jobs 1 / --max-queue 8
    --no-disconnect-detection
    --log-level info / --quiet

``serve()`` runs one or more apps (one per port), prints a machine-readable ready line on stdout
(``songdeck-bridge ready {json}``), and shuts down gracefully on SIGINT/SIGTERM: new jobs are
refused, running jobs are cancelled, the listening sockets close and close hooks run. A second
Ctrl+C exits immediately.

Bridges that must run code on the process's main thread (native GUI windows such as plugin
editors: macOS only allows them there) pass a :class:`MainThreadRunner` to ``serve()``, which then
services it while it waits for a signal. Request threads call ``runner.call(fn)``.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import logging
import os
import queue
import signal
import sys
import threading
import time
from typing import Any, Callable, Dict, List, NoReturn, Optional, Sequence, Tuple

from . import __version__
from .server import DEFAULT_CORS_ORIGINS, BridgeApp, is_loopback_host

__all__ = [
    "TOKEN_ENV",
    "build_parser",
    "setup_logging",
    "app_options",
    "check_bind",
    "serve",
    "fail",
    "module_available",
    "require_module",
    "resolve_device",
    "MainThreadRunner",
]

TOKEN_ENV = "SONGDECK_BRIDGE_TOKEN"
log = logging.getLogger("songdeck_bridge")


def build_parser(
    description: str,
    default_port: Optional[int],
    *,
    prog: Optional[str] = None,
    epilog: Optional[str] = None,
    engine_flags: bool = True,
) -> argparse.ArgumentParser:
    """Parser with the common flags. ``default_port=None`` leaves ``--port`` unset (the script picks one)."""
    p = argparse.ArgumentParser(
        prog=prog, description=description, epilog=epilog, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    g = p.add_argument_group("server")
    g.add_argument(
        "--host", default="127.0.0.1", help="interface to bind (default 127.0.0.1: reachable from this machine only)"
    )
    port_help = (
        f"TCP port (default {default_port}; 0 picks a free port)"
        if default_port is not None
        else "TCP port (default: the Song Deck preset port of the role; 0 picks a free port)"
    )
    g.add_argument("--port", type=int, default=default_port, help=port_help)
    g.add_argument(
        "--token",
        default=os.environ.get(TOKEN_ENV) or None,
        help=f"require 'Authorization: Bearer <token>' on every request except GET /health (default: ${TOKEN_ENV}); "
        "mandatory when --host is not a loopback address",
    )
    g.add_argument(
        "--allow-origin",
        action="append",
        default=None,
        metavar="URL",
        help="browser origin allowed by CORS; repeatable, replaces the defaults ("
        + ", ".join(DEFAULT_CORS_ORIGINS)
        + "); '*' allows any origin",
    )
    g.add_argument(
        "--allow-host",
        action="append",
        default=[],
        metavar="NAME",
        help="extra Host header name accepted while bound to loopback (DNS-rebinding protection)",
    )
    g.add_argument(
        "--max-body-mb", type=float, default=512.0, metavar="MB", help="largest accepted request body (default 512)"
    )
    g.add_argument("--max-jobs", type=int, default=1, metavar="N", help="jobs that run at the same time (default 1)")
    g.add_argument(
        "--max-queue",
        type=int,
        default=8,
        metavar="N",
        help="requests that may wait for a job slot; more → 409 busy (default 8; 0 = never queue)",
    )
    g.add_argument(
        "--no-disconnect-detection",
        action="store_true",
        help="do not cancel a job when its client disconnects (only POST /cancel stops it)",
    )
    g.add_argument(
        "--allow-remote-without-token",
        action="store_true",
        help="allow a non-loopback --host without --token (NOT recommended: anyone on the network could run jobs)",
    )
    g.add_argument(
        "--log-level",
        default="info",
        choices=["debug", "info", "warning", "error"],
        help="log verbosity (default info)",
    )
    g.add_argument("--quiet", action="store_true", help="only log warnings and errors")
    g.add_argument("--version", action="version", version=f"songdeck_bridge {__version__}")
    if engine_flags:
        e = p.add_argument_group("engine")
        e.add_argument("--model", default=None, help="model id to load/report (bridge specific default)")
        e.add_argument("--device", default="auto", help="compute device: auto, cpu, cuda, cuda:N or mps (default auto)")
    return p


def setup_logging(args: argparse.Namespace) -> None:
    level = (
        logging.WARNING
        if getattr(args, "quiet", False)
        else getattr(logging, str(getattr(args, "log_level", "info")).upper(), logging.INFO)
    )
    logging.basicConfig(
        level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S", stream=sys.stderr
    )


def app_options(args: argparse.Namespace) -> Dict[str, Any]:
    """Keyword arguments for :class:`BridgeApp` from the common flags."""
    return {
        "token": args.token,
        "cors_origins": args.allow_origin if args.allow_origin is not None else DEFAULT_CORS_ORIGINS,
        "allowed_hosts": args.allow_host,
        "max_body_bytes": int(max(1.0, args.max_body_mb) * 1024 * 1024),
        "max_jobs": max(1, args.max_jobs),
        "max_queue": max(0, args.max_queue),
        "detect_disconnect": not args.no_disconnect_detection,
    }


def fail(message: str, code: int = 2) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(code)


def check_bind(args: argparse.Namespace) -> None:
    """Refuse to expose an unauthenticated bridge to the network."""
    if not is_loopback_host(args.host) and not args.token and not args.allow_remote_without_token:
        fail(
            f"refusing to listen on {args.host} without a token: anyone who can reach this port could run jobs on this machine. "
            f"Pass --token (or set ${TOKEN_ENV}); --allow-remote-without-token overrides this check."
        )
    if args.allow_origin and "*" in args.allow_origin:
        log.warning("--allow-origin '*': any web page you visit can call this bridge from your browser")


def module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def require_module(name: str, install_hint: str) -> Any:
    """Import an engine module or exit with a clear message (engine bridges import lazily)."""
    try:
        return importlib.import_module(name)
    except ImportError as e:
        fail(f"'{name}' could not be imported ({e}). {install_hint}")


def resolve_device(device: Optional[str]) -> str:
    """'auto' → cuda / mps / cpu depending on what PyTorch reports (cpu when torch is absent)."""
    d = (device or "auto").strip().lower()
    if d != "auto":
        return d
    try:
        import torch  # type: ignore
    except ImportError:
        return "cpu"
    try:
        if torch.cuda.is_available():
            return "cuda"
        mps = getattr(getattr(torch, "backends", None), "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    except Exception:  # pragma: no cover - broken torch installs
        pass
    return "cpu"


class MainThreadRunner:
    """Runs callables on the main thread while :func:`serve` waits for a shutdown signal.

    ``call(fn)`` (from any other thread) queues ``fn`` and blocks until it ran on the main thread,
    returning its result or raising its exception. ``poll`` is called about every 0.2 s while
    waiting (e.g. ``ctx.check_cancelled``). Long main-thread calls (a plugin editor window) should
    register an interrupt with :meth:`add_interrupt` so a shutdown signal can end them.
    """

    def __init__(self) -> None:
        self._queue: "queue.Queue[Any]" = queue.Queue()
        self._interrupts: List[Callable[[], None]] = []
        self._lock = threading.Lock()
        self.active = False
        self.busy = False

    def call(self, fn: Callable[[], Any], *, poll: Optional[Callable[[], None]] = None) -> Any:
        if not self.active:
            raise RuntimeError("the main-thread runner is not being serviced (serve() was not given it)")
        if threading.current_thread() is threading.main_thread():
            return fn()
        done = threading.Event()
        box: Dict[str, Any] = {}
        self._queue.put((fn, done, box))
        while not done.wait(0.2):
            if not self.active:
                raise RuntimeError("the bridge is shutting down")
            if poll is not None:
                poll()  # may raise (e.g. JobCancelled); the queued call still runs or is dropped at shutdown
        if "error" in box:
            raise box["error"]
        return box.get("value")

    def run_pending(self, timeout: float) -> None:
        """Run queued calls (main thread only); wait up to ``timeout`` seconds for the first one."""
        try:
            item = self._queue.get(timeout=timeout)
        except queue.Empty:
            return
        while item is not None:
            fn, done, box = item
            self.busy = True
            try:
                box["value"] = fn()
            except BaseException as e:  # noqa: BLE001 - handed to the caller
                box["error"] = e
            finally:
                self.busy = False
                done.set()
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                item = None

    def add_interrupt(self, fn: Callable[[], None]) -> None:
        with self._lock:
            self._interrupts.append(fn)

    def remove_interrupt(self, fn: Callable[[], None]) -> None:
        with self._lock:
            if fn in self._interrupts:
                self._interrupts.remove(fn)

    def interrupt(self) -> None:
        """Ask long main-thread calls to return (called from the signal handler)."""
        with self._lock:
            hooks = list(self._interrupts)
        for fn in hooks:
            try:
                fn()
            except Exception:  # pragma: no cover - defensive
                log.exception("main-thread interrupt hook failed")

    def close(self) -> None:
        self.active = False
        self.interrupt()
        while True:
            try:
                _fn, done, box = self._queue.get_nowait()
            except queue.Empty:
                break
            box["error"] = RuntimeError("the bridge is shutting down")
            done.set()


def serve(
    bindings: Sequence[Tuple[BridgeApp, str, int]],
    *,
    shutdown_timeout: float = 10.0,
    announce: bool = True,
    main_thread: Optional[MainThreadRunner] = None,
) -> int:
    """Serve each ``(app, host, port)`` on its own thread until SIGINT/SIGTERM; returns an exit code.

    With ``main_thread``, queued main-thread calls run here while waiting (see :class:`MainThreadRunner`).
    """
    servers: List[Tuple[BridgeApp, Any]] = []
    for app, host, port in bindings:
        try:
            srv = app.create_server(host, port)
        except OSError as e:
            for a, s in servers:
                s.server_close()
                a.close()
            fail(f"cannot listen on {host}:{port} for {app.name}: {e}")
        servers.append((app, srv))
    threads = []
    for app, srv in servers:
        t = threading.Thread(
            target=srv.serve_forever, kwargs={"poll_interval": 0.25}, name=f"serve-{app.role}", daemon=True
        )
        t.start()
        threads.append(t)
        log.info(
            "%s (%s) listening on %s%s", app.name, app.role, app.url, " — bearer token required" if app.token else ""
        )
    if announce:
        ready = {"bridges": [{"name": a.name, "role": a.role, "url": a.url} for a, _ in servers], "pid": os.getpid()}
        print("songdeck-bridge ready " + json.dumps(ready), flush=True)

    stop = threading.Event()

    def on_signal(signum: int, _frame: Any) -> None:
        if stop.is_set():
            print("forced exit", file=sys.stderr, flush=True)
            os._exit(130)
        stop.set()
        if main_thread is not None:
            main_thread.interrupt()  # e.g. close an open plugin editor window

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, on_signal)
            except (ValueError, OSError):  # not the main thread / unsupported
                pass
    try:
        if main_thread is None:
            while not stop.wait(0.5):
                if not all(t.is_alive() for t in threads):
                    log.error("a server thread stopped unexpectedly")
                    break
        else:
            main_thread.active = True
            while not stop.is_set():
                main_thread.run_pending(0.25)
                if not all(t.is_alive() for t in threads):
                    log.error("a server thread stopped unexpectedly")
                    break
    except KeyboardInterrupt:
        pass
    if main_thread is not None:
        main_thread.close()
    log.info("shutting down …")
    for app, _ in servers:
        app.begin_shutdown()
    for _, srv in servers:
        srv.shutdown()
    deadline = time.monotonic() + shutdown_timeout
    for app, _ in servers:
        if not app.wait_idle(max(0.0, deadline - time.monotonic())):
            log.warning("%s: jobs still running after %.0f s; exiting anyway", app.name, shutdown_timeout)
    for app, srv in servers:
        srv.server_close()
        app.close()
    log.info("bye")
    return 0
