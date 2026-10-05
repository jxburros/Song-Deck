"""
HTTP application server for Song Deck bridges (standard library only).

The contracts (``packages/ai/src/contracts.ts``) boil down to a few rules every bridge follows:

* JSON requests (UTF-8); audio inside JSON is base64 of a complete WAV file.
* Audio endpoints answer ``200`` with ``Content-Type: audio/wav`` and may add ``X-Seed`` /
  ``X-Model`` headers.
* Errors are non-2xx with ``{"error": "<message>"}``: 400 invalid input, 404 unknown voice/model
  id, 409 busy and not queueing, 501 unsupported operation, 503 model still loading. Song Deck
  retries 429/5xx up to twice, so handlers must be idempotent.
* Optional bearer auth (``Authorization: Bearer <token>``).
* Long jobs stop when the client disconnects (Song Deck aborts the HTTP request on cancel) and
  on ``POST /cancel``.

:class:`BridgeApp` implements all of that once. A bridge registers handlers::

    app = BridgeApp("My bridge", role="music")

    @app.job("POST", "/generate")
    def generate(ctx):
        body = ctx.json_object()
        prompt = req_str(body, "prompt")                 # validation runs immediately → 400s
        seconds = req_number(body, "duration_seconds", exclusive_minimum=0)

        def work():                                      # runs in a job slot (queued if busy)
            for chunk in range(100):
                ctx.check_cancelled()                    # raises JobCancelled on disconnect / POST /cancel
                ...
            return wav_response(wav_bytes, seed=1, model="my-model")
        return work

Built-in routes: ``GET /health`` (status, jobs, model loading state; no auth) and
``POST /cancel`` (``{"job_id"?: str}`` → 204; cancels that job, or every running/queued job).

Security defaults: bind to 127.0.0.1, reject cross-origin browser requests from origins that are
not allow-listed (CORS is only granted to the Song Deck studio/server origins), reject ``Host``
headers that are not loopback names when bound to loopback (DNS-rebinding protection), and
compare tokens in constant time.
"""

from __future__ import annotations

import hmac
import json
import logging
import math
import os
import random
import re
import select
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .wav import Audio, WavError, audio_from_base64

__all__ = [
    "BridgeApp",
    "RequestContext",
    "Response",
    "Job",
    "ModelLoader",
    "HTTPError",
    "BadRequest",
    "Unauthorized",
    "Forbidden",
    "NotFound",
    "MethodNotAllowed",
    "Busy",
    "PayloadTooLarge",
    "EngineError",
    "NotSupported",
    "ModelLoading",
    "JobCancelled",
    "json_response",
    "wav_response",
    "no_content",
    "error_response",
    "req_str",
    "req_number",
    "req_int",
    "req_bool",
    "req_list",
    "req_object",
    "req_audio",
    "req_seed",
    "run_command",
    "command_from_template",
    "DEFAULT_CORS_ORIGINS",
    "DEFAULT_MAX_BODY_BYTES",
]

log = logging.getLogger("songdeck_bridge")

#: Browser origins allowed by default: the Song Deck studio dev server (Vite, port 5173) and the
#: Song Deck local server (port 7788), which also serves the built studio.
DEFAULT_CORS_ORIGINS: Tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:7788",
    "http://127.0.0.1:7788",
)
DEFAULT_MAX_BODY_BYTES = 512 * 1024 * 1024
LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1", "localhost.localdomain"})
EXPOSED_HEADERS = "X-Seed, X-Model, X-Job-Id"
DEFAULT_ALLOWED_HEADERS = "Authorization, Content-Type, Accept, X-Job-Id"
_DRAIN_LIMIT = 1 << 20  # bodies up to 1 MiB are drained after an early error (keeps keep-alive usable)

# ---------------------------------------------------------------------------
# Errors and responses
# ---------------------------------------------------------------------------


class HTTPError(Exception):
    """An error with an HTTP status; rendered as ``{"error": message}``."""

    status = 500

    def __init__(self, message: str, status: Optional[int] = None, headers: Optional[Dict[str, str]] = None):
        super().__init__(message)
        self.message = message
        if status is not None:
            self.status = int(status)
        self.headers = dict(headers or {})


class BadRequest(HTTPError):
    """400 — invalid input."""

    status = 400


class Unauthorized(HTTPError):
    status = 401


class Forbidden(HTTPError):
    status = 403


class NotFound(HTTPError):
    """404 — unknown path, or unknown voice/model id (contract)."""

    status = 404


class MethodNotAllowed(HTTPError):
    status = 405


class Busy(HTTPError):
    """409 — busy and not queueing (contract)."""

    status = 409


class PayloadTooLarge(HTTPError):
    status = 413


class EngineError(HTTPError):
    """500 — the engine failed (Song Deck retries 5xx up to twice)."""

    status = 500


class NotSupported(HTTPError):
    """501 — the operation is not supported by this bridge/engine (contract)."""

    status = 501


class ModelLoading(HTTPError):
    """503 — the model is still loading (contract); sends ``Retry-After``."""

    status = 503

    def __init__(self, message: str = "the model is still loading; retry shortly", retry_after: int = 10):
        super().__init__(message, headers={"Retry-After": str(max(1, int(retry_after)))})


class JobCancelled(Exception):
    """Raised inside a job when its client disconnected or ``POST /cancel`` was called.

    ``status`` is what the (possibly still connected) client receives: 409 for an explicit
    cancel, 503 when the bridge is shutting down (Song Deck may then fall back to another provider).
    """

    def __init__(self, reason: str = "cancelled", status: int = 409):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class _ClientGone(Exception):
    """The client closed the connection while we were reading its request."""


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    content_type: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)


def json_response(obj: Any, status: int = 200, headers: Optional[Dict[str, str]] = None) -> Response:
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return Response(status, body, "application/json; charset=utf-8", dict(headers or {}))


def wav_response(
    wav: bytes, *, seed: Optional[int] = None, model: Optional[str] = None, headers: Optional[Dict[str, str]] = None
) -> Response:
    """``200 audio/wav`` with the optional contract headers ``X-Seed`` and ``X-Model``."""
    h = dict(headers or {})
    if seed is not None:
        h["X-Seed"] = str(int(seed))
    if model:
        h["X-Model"] = str(model)
    return Response(200, wav, "audio/wav", h)


def no_content(headers: Optional[Dict[str, str]] = None) -> Response:
    return Response(204, b"", None, dict(headers or {}))


def error_response(status: int, message: str, headers: Optional[Dict[str, str]] = None) -> Response:
    return json_response({"error": message}, status, headers)


# ---------------------------------------------------------------------------
# Request field helpers (raise BadRequest with the field name)
# ---------------------------------------------------------------------------


def _show(v: Any) -> str:
    s = repr(v)
    return s if len(s) <= 60 else s[:57] + "..."


def _absent(obj: Dict[str, Any], name: str) -> bool:
    return obj.get(name) is None


def req_str(
    obj: Dict[str, Any],
    name: str,
    *,
    required: bool = True,
    default: Optional[str] = None,
    allow_empty: bool = True,
    max_len: int = 1_000_000,
    choices: Optional[Sequence[str]] = None,
) -> Optional[str]:
    if _absent(obj, name):
        if required:
            raise BadRequest(f"'{name}' is required")
        return default
    v = obj[name]
    if not isinstance(v, str):
        raise BadRequest(f"'{name}' must be a string (got {type(v).__name__})")
    if not allow_empty and not v.strip():
        raise BadRequest(f"'{name}' must not be empty")
    if len(v) > max_len:
        raise BadRequest(f"'{name}' is too long (max {max_len} characters)")
    if choices is not None and v not in choices:
        raise BadRequest(f"'{name}' must be one of: {', '.join(choices)} (got {_show(v)})")
    return v


def req_number(
    obj: Dict[str, Any],
    name: str,
    *,
    required: bool = True,
    default: Optional[float] = None,
    minimum: Optional[float] = None,
    maximum: Optional[float] = None,
    exclusive_minimum: Optional[float] = None,
) -> Optional[float]:
    if _absent(obj, name):
        if required:
            raise BadRequest(f"'{name}' is required")
        return default
    v = obj[name]
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise BadRequest(f"'{name}' must be a number (got {_show(v)})")
    if minimum is not None and v < minimum:
        raise BadRequest(f"'{name}' must be >= {minimum} (got {v})")
    if exclusive_minimum is not None and v <= exclusive_minimum:
        raise BadRequest(f"'{name}' must be > {exclusive_minimum} (got {v})")
    if maximum is not None and v > maximum:
        raise BadRequest(f"'{name}' must be <= {maximum} (got {v})")
    return float(v)


def req_int(
    obj: Dict[str, Any],
    name: str,
    *,
    required: bool = True,
    default: Optional[int] = None,
    minimum: Optional[int] = None,
    maximum: Optional[int] = None,
) -> Optional[int]:
    v = req_number(obj, name, required=required, default=None, minimum=minimum, maximum=maximum)
    if v is None:
        return default
    if v != int(v):
        raise BadRequest(f"'{name}' must be an integer (got {obj[name]})")
    return int(v)


def req_bool(obj: Dict[str, Any], name: str, *, default: Optional[bool] = None) -> Optional[bool]:
    if _absent(obj, name):
        return default
    v = obj[name]
    if not isinstance(v, bool):
        raise BadRequest(f"'{name}' must be true or false (got {_show(v)})")
    return v


def req_list(
    obj: Dict[str, Any],
    name: str,
    *,
    required: bool = True,
    default: Optional[list] = None,
    max_items: Optional[int] = None,
) -> Optional[list]:
    if _absent(obj, name):
        if required:
            raise BadRequest(f"'{name}' is required")
        return default
    v = obj[name]
    if not isinstance(v, list):
        raise BadRequest(f"'{name}' must be an array (got {type(v).__name__})")
    if max_items is not None and len(v) > max_items:
        raise BadRequest(f"'{name}' has too many items (max {max_items})")
    return v


def req_object(
    obj: Dict[str, Any], name: str, *, required: bool = False, default: Optional[dict] = None
) -> Optional[dict]:
    if _absent(obj, name):
        if required:
            raise BadRequest(f"'{name}' is required")
        return default
    v = obj[name]
    if not isinstance(v, dict):
        raise BadRequest(f"'{name}' must be an object (got {type(v).__name__})")
    return v


def req_audio(obj: Dict[str, Any], name: str, *, required: bool = True) -> Optional[Audio]:
    """Decode a base64 WAV field into :class:`~songdeck_bridge.wav.Audio` (400 on bad data)."""
    if _absent(obj, name):
        if required:
            raise BadRequest(f"'{name}' is required (base64 of a WAV file)")
        return None
    try:
        return audio_from_base64(obj[name], name)
    except WavError as e:
        raise BadRequest(str(e)) from None


def req_seed(obj: Dict[str, Any], name: str = "seed") -> Tuple[int, bool]:
    """``(seed, from_request)``; a random seed is drawn when absent (return it in ``X-Seed``)."""
    v = req_number(obj, name, required=False)
    if v is None:
        return random.SystemRandom().randrange(0, 2**31 - 1), False
    if v != int(v):
        raise BadRequest(f"'{name}' must be an integer (got {obj[name]})")
    return int(v), True


# ---------------------------------------------------------------------------
# Jobs, request context, model loading
# ---------------------------------------------------------------------------


class Job:
    """A long-running request. Cancelled by client disconnect, ``POST /cancel`` or shutdown."""

    def __init__(self, job_id: str, method: str, path: str, sock: Optional[socket.socket]):
        self.id = job_id
        self.method = method
        self.path = path
        self.sock = sock
        self.created = time.monotonic()
        self.started: Optional[float] = None
        self.state = "queued"
        self.reason: Optional[str] = None
        self.status = 409
        self._event = threading.Event()
        self._hooks: List[Callable[[], None]] = []
        self._lock = threading.Lock()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self, reason: str = "cancelled", status: int = 409) -> bool:
        with self._lock:
            if self._event.is_set():
                return False
            self.reason = reason
            self.status = status
            self._event.set()
            hooks = list(self._hooks)
        for hook in hooks:
            try:
                hook()
            except Exception:  # pragma: no cover - defensive
                log.exception("cancel hook of job %s failed", self.id)
        return True

    def on_cancel(self, fn: Callable[[], None]) -> None:
        """Call ``fn`` (from another thread) as soon as the job is cancelled."""
        with self._lock:
            if not self._event.is_set():
                self._hooks.append(fn)
                return
        fn()

    def check(self) -> None:
        if self._event.is_set():
            raise JobCancelled(self.reason or "cancelled", self.status)

    def wait(self, timeout: float) -> bool:
        """Sleep up to ``timeout`` seconds; True if the job was cancelled meanwhile."""
        return self._event.wait(timeout)


_UNSET = object()


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


class RequestContext:
    """What a handler sees: method, path, query, headers, body/JSON and (for jobs) the Job."""

    def __init__(
        self,
        app: "BridgeApp",
        handler: BaseHTTPRequestHandler,
        method: str,
        path: str,
        query: Dict[str, List[str]],
        body: bytes,
    ):
        self.app = app
        self.method = method
        self.path = path
        self.query = query
        self.headers = handler.headers
        self.client = handler.client_address[0] if handler.client_address else "?"
        self.body = body
        self.body_size = len(body)
        self.job: Optional[Job] = None
        self._json: Any = _UNSET
        self._socket = getattr(handler, "connection", None)

    # -- JSON ------------------------------------------------------------------------------
    def json(self) -> Any:
        if self._json is _UNSET:
            if not self.body.strip():
                raise BadRequest("the request body must be JSON")
            try:
                text = self.body.decode("utf-8-sig")
                self._json = json.loads(text, parse_constant=_reject_constant)
            except (UnicodeDecodeError, ValueError) as e:
                raise BadRequest(f"invalid JSON body: {e}") from None
            except RecursionError:
                raise BadRequest("invalid JSON body: nested too deeply") from None
            self.body = b""  # free the raw bytes (bodies can be hundreds of MB of base64)
        return self._json

    def json_object(self, allow_empty: bool = False) -> Dict[str, Any]:
        if allow_empty and self._json is _UNSET and not self.body.strip():
            return {}
        obj = self.json()
        if not isinstance(obj, dict):
            raise BadRequest("the request body must be a JSON object")
        return obj

    def header(self, name: str, default: Optional[str] = None) -> Optional[str]:
        v = self.headers.get(name)
        return default if v is None else v

    # -- cancellation ------------------------------------------------------------------------
    @property
    def cancelled(self) -> bool:
        return bool(self.job is not None and self.job.cancelled)

    @property
    def cancel_reason(self) -> str:
        return (self.job.reason if self.job is not None else None) or "cancelled"

    def check_cancelled(self) -> None:
        """Raise :class:`JobCancelled` if the client went away or the job was cancelled."""
        if self.job is not None:
            self.job.check()

    def on_cancel(self, fn: Callable[[], None]) -> None:
        if self.job is not None:
            self.job.on_cancel(fn)

    def sleep(self, seconds: float) -> None:
        """Cancellable sleep."""
        if seconds <= 0:
            return
        if self.job is None:
            time.sleep(seconds)
            return
        if self.job.wait(seconds):
            self.job.check()

    @property
    def job_id(self) -> Optional[str]:
        return self.job.id if self.job is not None else None


class ModelLoader:
    """Loads an engine/model once, in a background thread.

    Job handlers call :meth:`get`, which returns the loaded object, raises :class:`ModelLoading`
    (503 + Retry-After) while loading, or :class:`EngineError` (500) if loading failed.
    """

    def __init__(self, name: str, load: Callable[[], Any], *, retry_after: int = 10):
        self.name = name
        self._load = load
        self.retry_after = retry_after
        self.state = "idle"
        self.error: Optional[str] = None
        self.value: Any = None
        self.load_seconds: Optional[float] = None
        self._lock = threading.Lock()

    def start(self, background: bool = True) -> "ModelLoader":
        with self._lock:
            if self.state in ("loading", "ready"):
                return self
            self.state = "loading"
            self.error = None
        if background:
            threading.Thread(target=self._run, name=f"load-{self.name}", daemon=True).start()
        else:
            self._run()
        return self

    def _run(self) -> None:
        t0 = time.monotonic()
        log.info("loading %s …", self.name)
        try:
            value = self._load()
        except BaseException as e:  # noqa: BLE001 - report any failure (ImportError, CUDA errors…)
            with self._lock:
                self.state = "failed"
                self.error = f"{type(e).__name__}: {e}"
            log.error("loading %s failed: %s", self.name, self.error)
            if not isinstance(e, Exception):
                raise
            return
        with self._lock:
            self.value = value
            self.state = "ready"
            self.load_seconds = time.monotonic() - t0
        log.info("%s ready (%.1f s)", self.name, self.load_seconds)

    def get(self) -> Any:
        state = self.state
        if state == "ready":
            return self.value
        if state == "idle":
            self.start()
            state = "loading"
        if state == "loading":
            raise ModelLoading(f"{self.name} is still loading; retry shortly", self.retry_after)
        raise EngineError(f"{self.name} failed to load: {self.error} (fix the problem and restart the bridge)")

    def status(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"name": self.name, "state": self.state}
        if self.error:
            out["error"] = self.error
        if self.load_seconds is not None:
            out["load_seconds"] = round(self.load_seconds, 2)
        return out


# ---------------------------------------------------------------------------
# Subprocess engines (CLIs) that stop when the job is cancelled
# ---------------------------------------------------------------------------


def _process_group_kwargs() -> Dict[str, Any]:
    if os.name == "posix":
        return {"start_new_session": True}
    return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}


def _kill_process(proc: subprocess.Popen, grace: float = 5.0) -> None:
    """Terminate the process (and its children on POSIX), escalating to kill after ``grace`` s."""
    if proc.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGTERM)
        else:
            proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=grace)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:  # pragma: no cover - unkillable process
        log.error("process %s did not exit after SIGKILL", proc.pid)


def command_from_template(template: str, values: Dict[str, str]) -> List[str]:
    """Split a command template into arguments FIRST, then fill ``{placeholders}`` in each one.

    Values are therefore never re-split or interpreted by a shell (file names with spaces or
    quotes stay one argument). On Windows (non-POSIX ``shlex``) surrounding quotes are removed.
    """
    posix = os.name != "nt"
    out: List[str] = []
    for tok in shlex.split(template, posix=posix):
        if not posix and len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in "\"'":
            tok = tok[1:-1]
        # single pass: a value that happens to contain "{name}" is not substituted again
        out.append(_PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), m.group(0)), tok))
    return out


_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def run_command(
    cmd: Sequence[Any],
    ctx: Optional[RequestContext] = None,
    *,
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    timeout: Optional[float] = None,
    name: Optional[str] = None,
    poll_interval: float = 0.2,
    tail_chars: int = 4000,
) -> str:
    """Run an engine command line as a cancellable subprocess and return the tail of its output.

    The process is terminated (with its process group on POSIX) when the job is cancelled — the
    client disconnected or ``POST /cancel`` — and :class:`JobCancelled` is raised. A non-zero exit
    raises :class:`EngineError` with the last lines of output. No shell is involved, so arguments
    are never re-interpreted.
    """
    argv = [str(c) for c in cmd]
    label = name or os.path.basename(argv[0])
    log.info("running %s", " ".join(shlex.quote(a) for a in argv))
    with tempfile.TemporaryFile() as out:
        try:
            proc = subprocess.Popen(
                argv,
                cwd=cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                **_process_group_kwargs(),
            )
        except FileNotFoundError:
            raise EngineError(f"{label}: command not found: {argv[0]}") from None
        except OSError as e:
            raise EngineError(f"{label}: could not start ({e})") from None
        if ctx is not None and ctx.job is not None:
            ctx.job.on_cancel(lambda: threading.Thread(target=_kill_process, args=(proc,), daemon=True).start())
        deadline = time.monotonic() + timeout if timeout else None
        try:
            while True:
                try:
                    rc = proc.wait(timeout=poll_interval)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if ctx is not None and ctx.cancelled:
                    _kill_process(proc)
                    ctx.check_cancelled()
                if deadline is not None and time.monotonic() > deadline:
                    _kill_process(proc)
                    raise EngineError(f"{label} timed out after {timeout:.0f} s")
        except BaseException:
            _kill_process(proc)
            raise
        if ctx is not None:
            ctx.check_cancelled()
        out.seek(0, os.SEEK_END)
        size = out.tell()
        out.seek(max(0, size - tail_chars * 4))
        tail = out.read().decode("utf-8", errors="replace")[-tail_chars:]
    if rc != 0:
        lines = [ln.strip() for ln in tail.replace("\r", "\n").splitlines() if ln.strip()][-12:]
        detail = " | ".join(lines)[-1500:] or "no output"
        raise EngineError(f"{label} failed (exit code {rc}): {detail}")
    return tail


# ---------------------------------------------------------------------------
# The application
# ---------------------------------------------------------------------------


@dataclass
class _Route:
    handler: Callable[[RequestContext], Any]
    job: bool
    auth: bool


def _norm_path(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return path.rstrip("/") or "/"


_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


def _header_value(v: Any) -> str:
    s = str(v).replace("\r", " ").replace("\n", " ")
    return s.encode("latin-1", errors="replace").decode("latin-1")


def _host_name(host_header: str) -> str:
    h = host_header.strip()
    if h.startswith("["):
        end = h.find("]")
        return h[1:end].lower() if end > 0 else h.lower()
    if h.count(":") == 1:
        h = h.split(":", 1)[0]
    return h.lower()


def is_loopback_host(host: str) -> bool:
    """True for localhost / 127.0.0.0/8 / ::1 (what a bind address of a local-only bridge looks like)."""
    h = (host or "").strip().strip("[]").lower()
    if h in ("localhost", "localhost.localdomain"):
        return True
    try:
        import ipaddress

        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def _peer_closed(sock: socket.socket) -> bool:
    """Peek at a readable socket: b'' (EOF) or an error means the client is gone."""
    try:
        data = sock.recv(1, socket.MSG_PEEK | getattr(socket, "MSG_DONTWAIT", 0))
        return data == b""
    except (BlockingIOError, InterruptedError):
        return False
    except socket.timeout:
        return False
    except OSError:
        return True


class BridgeApp:
    """A bridge application: routes + contract plumbing. See the module docstring."""

    def __init__(
        self,
        name: str,
        *,
        version: str = __version__,
        role: str = "bridge",
        token: Optional[str] = None,
        cors_origins: Optional[Sequence[str]] = DEFAULT_CORS_ORIGINS,
        allowed_hosts: Optional[Sequence[str]] = None,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
        max_jobs: int = 1,
        max_queue: int = 8,
        detect_disconnect: bool = True,
        disconnect_poll: float = 0.25,
    ):
        self.name = name
        self.version = version
        self.role = role
        self.token = token or None
        self.cors_origins = {o.strip().rstrip("/").lower() for o in (cors_origins or ()) if o and o.strip()}
        self.allowed_hosts = {h.strip().lower() for h in (allowed_hosts or ()) if h and h.strip()}
        self.max_body_bytes = int(max_body_bytes)
        self.max_jobs = max(1, int(max_jobs))
        self.max_queue = max(0, int(max_queue))
        self.detect_disconnect = detect_disconnect
        self.disconnect_poll = disconnect_poll
        self.log = logging.getLogger(f"songdeck_bridge.{role}")
        #: response headers a browser may read (CORS); bridges with extra headers append to it
        self.expose_headers = EXPOSED_HEADERS
        self.loaders: List[ModelLoader] = []
        self.health_extra: Optional[Callable[[], Dict[str, Any]]] = None
        self.server: Optional[ThreadingHTTPServer] = None
        self.bind_host: Optional[str] = None
        self.started_at = time.time()
        self.stats = {"completed": 0, "cancelled": 0, "failed": 0, "rejected": 0}
        self._routes: Dict[str, Dict[str, _Route]] = {}
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self._idle = threading.Condition(self._lock)
        self._slots = threading.Semaphore(self.max_jobs)
        self._running = 0
        self._queued = 0
        self._shutting_down = False
        self._closed = threading.Event()
        self._close_hooks: List[Callable[[], None]] = []
        self._watcher: Optional[threading.Thread] = None
        self.add_route("GET", "/health", self._route_health, auth=False)
        self.add_route("POST", "/cancel", self._route_cancel)

    # -- registration --------------------------------------------------------------------------
    def add_route(
        self, method: str, path: str, handler: Callable[[RequestContext], Any], *, job: bool = False, auth: bool = True
    ) -> None:
        self._routes.setdefault(_norm_path(path), {})[method.upper()] = _Route(handler, job, auth)

    def route(self, method: str, path: str, *, auth: bool = True):
        """Decorator for quick (non-job) routes; the handler returns a :class:`Response`."""

        def deco(fn):
            self.add_route(method, path, fn, job=False, auth=auth)
            return fn

        return deco

    def job(self, method: str, path: str):
        """Decorator for long-running routes.

        The handler validates the request and returns either a :class:`Response` (answered at
        once) or a zero-argument callable doing the work. The callable runs in a job slot
        (``max_jobs`` at a time, ``max_queue`` waiting, 409 beyond that) and may call
        ``ctx.check_cancelled()``.
        """

        def deco(fn):
            self.add_route(method, path, fn, job=True)
            return fn

        return deco

    def add_loader(self, loader: ModelLoader) -> ModelLoader:
        self.loaders.append(loader)
        return loader

    def on_close(self, fn: Callable[[], None]) -> None:
        self._close_hooks.append(fn)

    # -- serving -------------------------------------------------------------------------------
    def create_server(self, host: str, port: int) -> ThreadingHTTPServer:
        handler_cls = type(
            f"{re.sub(r'[^A-Za-z0-9]', '', self.role.title()) or 'Bridge'}Handler", (_Handler,), {"app": self}
        )
        server = _BridgeServer((host, port), handler_cls)
        self.server = server
        self.bind_host = host
        if self.detect_disconnect and self._watcher is None:
            self._watcher = threading.Thread(
                target=self._watch_disconnects, name=f"{self.role}-disconnects", daemon=True
            )
            self._watcher.start()
        return server

    @property
    def url(self) -> str:
        if self.server is None:
            return ""
        host, port = self.server.server_address[:2]
        if host in ("0.0.0.0", "::"):
            host = "127.0.0.1" if host == "0.0.0.0" else "::1"
        return f"http://[{host}]:{port}" if ":" in str(host) else f"http://{host}:{port}"

    def begin_shutdown(self) -> None:
        """Refuse new jobs (503) and cancel queued/running ones."""
        self._shutting_down = True
        self.cancel_jobs(None, "the bridge is shutting down", status=503)

    def wait_idle(self, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        with self._idle:
            while self._running + self._queued > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._idle.wait(remaining)
        return True

    def close(self) -> None:
        self._closed.set()
        for fn in reversed(self._close_hooks):
            try:
                fn()
            except Exception:  # pragma: no cover - defensive
                self.log.exception("close hook failed")

    def cancel_jobs(self, job_id: Optional[str] = None, reason: str = "cancelled", status: int = 409) -> int:
        with self._lock:
            jobs = [j for j in self._jobs.values() if job_id is None or j.id == job_id]
        return sum(1 for j in jobs if j.cancel(reason, status))

    def job_counts(self) -> Dict[str, int]:
        with self._lock:
            return {"running": self._running, "queued": self._queued, **self.stats}

    # -- built-in routes -----------------------------------------------------------------------
    def _route_health(self, ctx: RequestContext) -> Response:
        with self._lock:
            jobs = {
                "running": self._running,
                "queued": self._queued,
                "max_jobs": self.max_jobs,
                "max_queue": self.max_queue,
                **self.stats,
            }
            now = time.monotonic()
            active = [
                {"id": j.id, "path": j.path, "state": j.state, "seconds": round(now - j.created, 2)}
                for j in self._jobs.values()
            ]
        models = [ld.status() for ld in self.loaders]
        status = "ok"
        if any(m["state"] == "failed" for m in models):
            status = "error"
        elif any(m["state"] in ("loading", "idle") for m in models):
            status = "loading"
        if self._shutting_down:
            status = "shutting-down"
        body: Dict[str, Any] = {
            "status": status,
            "name": self.name,
            "version": self.version,
            "role": self.role,
            "uptime_seconds": round(time.time() - self.started_at, 1),
            "auth_required": bool(self.token),
            "jobs": jobs,
            "active_jobs": active,
            "models": models,
        }
        if self.health_extra is not None:
            body.update(self.health_extra())
        return json_response(body)

    def _route_cancel(self, ctx: RequestContext) -> Response:
        body = ctx.json_object(allow_empty=True)
        job_id = req_str(body, "job_id", required=False)
        n = self.cancel_jobs(job_id, "cancelled via POST /cancel")
        self.log.info("POST /cancel%s: %d job(s) cancelled", f" job_id={job_id}" if job_id else "", n)
        return no_content({"X-Cancelled-Jobs": str(n)})

    # -- request pipeline ----------------------------------------------------------------------
    def _origin_allowed(self, origin: str) -> bool:
        o = origin.strip().rstrip("/").lower()
        return "*" in self.cors_origins or o in self.cors_origins

    def _host_allowed(self, host_header: Optional[str]) -> bool:
        if not host_header or self.bind_host is None or not is_loopback_host(self.bind_host):
            return True  # bound to a public interface: the token protects it
        name = _host_name(host_header)
        return (
            name in LOOPBACK_NAMES
            or name in self.allowed_hosts
            or name == self.bind_host.strip("[]").lower()
            or name.startswith("127.")
        )

    def _authorized(self, h: BaseHTTPRequestHandler) -> bool:
        auth = h.headers.get("Authorization") or ""
        scheme, _, value = auth.strip().partition(" ")
        if scheme.lower() != "bearer" or not value.strip():
            return False
        return hmac.compare_digest(value.strip().encode("utf-8"), str(self.token).encode("utf-8"))

    def _discard_body(self, h: BaseHTTPRequestHandler) -> bool:
        """Drain a small unread body so the connection can be reused; True → close the connection."""
        if "chunked" in (h.headers.get("Transfer-Encoding") or "").lower():
            return True
        try:
            n = int(h.headers.get("Content-Length") or 0)
        except ValueError:
            return True
        if n <= 0:
            return False
        if n > _DRAIN_LIMIT:
            return True
        try:
            _read_exact(h.rfile, n)
        except (_ClientGone, OSError):
            return True
        return False

    def _read_body(self, h: BaseHTTPRequestHandler) -> bytes:
        if "chunked" in (h.headers.get("Transfer-Encoding") or "").lower():
            return self._read_chunked(h)
        cl = h.headers.get("Content-Length")
        if cl is None:
            return b""
        try:
            n = int(cl)
            if n < 0:
                raise ValueError
        except ValueError:
            raise BadRequest("invalid Content-Length header") from None
        if n > self.max_body_bytes:
            raise PayloadTooLarge(
                f"the request body is {n} bytes; this bridge accepts at most {self.max_body_bytes} (start it with a larger --max-body-mb)"
            )
        return _read_exact(h.rfile, n)

    def _read_chunked(self, h: BaseHTTPRequestHandler) -> bytes:
        parts: List[bytes] = []
        total = 0
        while True:
            line = h.rfile.readline(65537)
            if not line:
                raise _ClientGone()
            try:
                size = int(line.split(b";", 1)[0].strip() or b"x", 16)
            except ValueError:
                raise BadRequest("invalid chunked transfer encoding") from None
            if size == 0:
                while True:  # trailers
                    t = h.rfile.readline(65537)
                    if not t or t in (b"\r\n", b"\n"):
                        break
                return b"".join(parts)
            total += size
            if total > self.max_body_bytes:
                raise PayloadTooLarge(
                    f"the request body exceeds {self.max_body_bytes} bytes (start the bridge with a larger --max-body-mb)"
                )
            parts.append(_read_exact(h.rfile, size))
            _read_exact(h.rfile, 2)

    def _dispatch(self, h: "_Handler") -> None:
        t0 = time.monotonic()
        method = (h.command or "GET").upper()
        split = urlsplit(h.path)
        path = _norm_path(split.path)
        origin = h.headers.get("Origin")
        cors_origin = origin if origin is not None and self._origin_allowed(origin) else None
        close = False
        ctx: Optional[RequestContext] = None
        try:
            if not self._host_allowed(h.headers.get("Host")):
                close = True
                raise Forbidden(
                    "Host header not allowed (DNS-rebinding protection); start the bridge with --allow-host <name> if you use another host name"
                )
            if origin is not None and cors_origin is None:
                close = True
                raise Forbidden(
                    f"origin {origin} is not allowed; start the bridge with --allow-origin {origin} to permit it"
                )
            if method == "OPTIONS":
                resp = self._preflight(h)
            else:
                routes = self._routes.get(path)
                if routes is None:
                    close = self._discard_body(h)
                    raise NotFound(f"unknown endpoint {method} {path}")
                route = routes.get("GET" if method == "HEAD" else method)
                if route is None:
                    close = self._discard_body(h)
                    allow = ", ".join(sorted(set(routes) | {"OPTIONS"}))
                    raise MethodNotAllowed(
                        f"{method} is not allowed on {path} (allowed: {allow})", headers={"Allow": allow}
                    )
                if route.auth and self.token and not self._authorized(h):
                    close = self._discard_body(h)
                    raise Unauthorized(
                        "missing or invalid bearer token (Authorization: Bearer <token>)",
                        headers={"WWW-Authenticate": 'Bearer realm="songdeck-bridge"'},
                    )
                try:
                    body = self._read_body(h)
                except (PayloadTooLarge, BadRequest):
                    close = True
                    raise
                ctx = RequestContext(self, h, method, path, parse_qs(split.query), body)
                resp = self._run_route(route, ctx) if route.job else route.handler(ctx)
                if not isinstance(resp, Response):
                    raise TypeError(f"handler for {path} returned {type(resp).__name__}, expected Response")
        except _ClientGone:
            h.close_connection = True
            self.log.info('%s "%s %s" client disconnected while sending the request', h.client_address[0], method, path)
            return
        except HTTPError as e:
            resp = error_response(e.status, e.message, e.headers)
        except JobCancelled as e:
            resp = error_response(
                e.status, f"job cancelled ({e.reason})", {"Retry-After": "5"} if e.status == 503 else None
            )
        except WavError as e:
            resp = error_response(400, str(e))
        except Exception as e:
            self.log.exception("unhandled error in %s %s", method, path)
            resp = error_response(500, f"internal bridge error: {type(e).__name__}: {e}")
        sent = self._send(h, resp, method, cors_origin, close)
        dt = time.monotonic() - t0
        job_id = ctx.job_id if ctx is not None else None
        level = logging.DEBUG if path == "/health" and resp.status == 200 else logging.INFO
        if resp.status >= 500:
            level = logging.WARNING
        err = ""
        if resp.status >= 400 and resp.content_type and resp.content_type.startswith("application/json"):
            try:
                err = " — " + str(json.loads(resp.body.decode("utf-8")).get("error", ""))[:200]
            except ValueError:
                err = ""
        self.log.log(
            level,
            '%s "%s %s" %d %s B %.2fs%s%s%s',
            h.client_address[0],
            method,
            path,
            resp.status,
            f"{len(resp.body):,}",
            dt,
            f" job={job_id}" if job_id else "",
            "" if sent else " (client gone)",
            err,
        )

    def _preflight(self, h: BaseHTTPRequestHandler) -> Response:
        requested = h.headers.get("Access-Control-Request-Headers")
        allow_headers = (
            requested if requested and re.fullmatch(r"[A-Za-z0-9_,\- ]{1,500}", requested) else DEFAULT_ALLOWED_HEADERS
        )
        headers = {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": allow_headers,
            "Access-Control-Max-Age": "600",
        }
        if (h.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"
        return Response(204, b"", None, headers)

    def _run_route(self, route: _Route, ctx: RequestContext) -> Response:
        if self._shutting_down:
            raise HTTPError("the bridge is shutting down", 503, {"Retry-After": "5"})
        with self._lock:
            if self._running >= self.max_jobs and self._queued >= self.max_queue:
                self.stats["rejected"] += 1
                raise Busy(self._busy_message())
        try:
            work = route.handler(ctx)  # validation (400/404 …) happens here, before queueing
        except HTTPError as e:
            if e.status < 500:
                with self._lock:
                    self.stats["rejected"] += 1
            raise
        if isinstance(work, Response):
            return work
        if not callable(work):
            raise TypeError(f"job handler for {ctx.path} must return a Response or a callable")
        requested_id = ctx.header("X-Job-Id")
        job_id = requested_id if requested_id and _JOB_ID_RE.match(requested_id) else uuid.uuid4().hex[:12]
        job = Job(job_id, ctx.method, ctx.path, ctx._socket if self.detect_disconnect else None)
        with self._lock:
            if self._running >= self.max_jobs and self._queued >= self.max_queue:
                self.stats["rejected"] += 1
                raise Busy(self._busy_message())
            if job.id in self._jobs:
                job.id = f"{job.id}-{uuid.uuid4().hex[:4]}"
            self._jobs[job.id] = job
            self._queued += 1
        ctx.job = job
        queued = True
        try:
            while True:
                job.check()
                if self._slots.acquire(timeout=0.1):
                    break
            with self._lock:
                self._queued -= 1
                queued = False
                self._running += 1
            job.state = "running"
            job.started = time.monotonic()
            try:
                resp = work()
            finally:
                with self._lock:
                    self._running -= 1
                self._slots.release()
            if not isinstance(resp, Response):
                raise TypeError(f"job for {ctx.path} returned {type(resp).__name__}, expected Response")
            resp.headers.setdefault("X-Job-Id", job.id)
            with self._lock:
                self.stats["completed"] += 1
            return resp
        except JobCancelled:
            with self._lock:
                self.stats["cancelled"] += 1
            self.log.info("job %s (%s) cancelled: %s", job.id, ctx.path, job.reason or "cancelled")
            raise
        except HTTPError as e:
            with self._lock:
                self.stats["failed" if e.status >= 500 else "rejected"] += 1
            raise
        except Exception:
            with self._lock:
                self.stats["failed"] += 1
            raise
        finally:
            job.state = "done"
            with self._lock:
                if queued:
                    self._queued -= 1
                self._jobs.pop(job.id, None)
                self._idle.notify_all()

    def _busy_message(self) -> str:
        return (
            f"the bridge is busy ({self._running} job(s) running, {self._queued} queued, queue limit {self.max_queue}); "
            "retry later or start it with a larger --max-queue"
        )

    def _send(
        self, h: BaseHTTPRequestHandler, resp: Response, method: str, cors_origin: Optional[str], close: bool
    ) -> bool:
        try:
            h.send_response(resp.status)
            headers: Dict[str, str] = {}
            if resp.content_type:
                headers["Content-Type"] = resp.content_type
            if resp.status != 204 and resp.status != 304:
                headers["Content-Length"] = str(len(resp.body))
            headers["Cache-Control"] = "no-store"
            headers["X-Content-Type-Options"] = "nosniff"
            if cors_origin is not None:
                headers["Access-Control-Allow-Origin"] = cors_origin
                headers["Vary"] = "Origin"
                headers["Access-Control-Expose-Headers"] = self.expose_headers
            headers.update(resp.headers)
            if close:
                headers["Connection"] = "close"
                h.close_connection = True
            for k, v in headers.items():
                h.send_header(k, _header_value(v))
            h.end_headers()
            if method != "HEAD" and resp.status not in (204, 304) and resp.body:
                h.wfile.write(resp.body)
            return True
        except (OSError, socket.timeout) as e:
            h.close_connection = True
            self.log.debug("client went away while sending the response: %s", e)
            return False

    # -- client-disconnect detection -------------------------------------------------------------
    def _watch_disconnects(self) -> None:
        while not self._closed.wait(self.disconnect_poll):
            with self._lock:
                jobs = [j for j in self._jobs.values() if j.sock is not None and not j.cancelled]
            if not jobs:
                continue
            socks: Dict[socket.socket, Job] = {}
            for j in jobs:
                try:
                    if j.sock.fileno() < 0:
                        j.cancel("client disconnected")
                        continue
                except OSError:
                    j.cancel("client disconnected")
                    continue
                socks[j.sock] = j
            if not socks:
                continue
            try:
                readable, _, broken = select.select(list(socks), [], list(socks), 0)
            except (OSError, ValueError):
                readable, broken = list(socks), []
            for s in set(readable) | set(broken):
                if _peer_closed(s):
                    socks[s].cancel("client disconnected")


def _read_exact(f, n: int) -> bytes:
    chunks: List[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = f.read(min(remaining, 1 << 20))
        if not chunk:
            raise _ClientGone()
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class _BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"  # on Windows SO_REUSEADDR would let two bridges share a port
    request_queue_size = 64

    def __init__(self, server_address, handler_cls):
        if ":" in str(server_address[0]):
            self.address_family = socket.AF_INET6
        super().__init__(server_address, handler_cls)

    def handle_error(self, request, client_address):  # noqa: D401 - socketserver hook
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, socket.timeout, TimeoutError)):
            log.debug("connection from %s ended: %s", client_address, exc)
            return
        log.exception("unhandled error serving %s", client_address)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"SongDeckBridge/{__version__}"
    sys_version = ""
    timeout = 300  # seconds of socket inactivity (slow uploads, idle keep-alive connections)
    app: BridgeApp

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        self.app._dispatch(self)

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = do_GET  # noqa: N815

    def version_string(self) -> str:
        return self.server_version

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - signature of the base class
        log.debug("%s - %s", self.address_string(), format % args)

    def log_request(self, code: Union[int, str] = "-", size: Union[int, str] = "-") -> None:
        pass  # BridgeApp logs one line per request itself

    def send_error(self, code: int, message: Optional[str] = None, explain: Optional[str] = None) -> None:
        """Malformed requests (bad request line, huge headers…) also get ``{"error": …}`` bodies."""
        try:
            phrase = HTTPStatus(code).phrase
        except ValueError:
            phrase = "Error"
        body = json.dumps({"error": message or phrase}).encode("utf-8")
        self.close_connection = True
        try:
            self.send_response(code, phrase)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if getattr(self, "command", None) != "HEAD" and code >= 200 and code not in (204, 304):
                self.wfile.write(body)
        except OSError:
            pass
