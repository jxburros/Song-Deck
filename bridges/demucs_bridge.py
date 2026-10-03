#!/usr/bin/env python3
"""
Song Deck SEPARATION bridge for Demucs — reference implementation.

Contract (packages/ai/src/contracts.ts, SEPARATION_BRIDGE_PATHS)::

    POST /separate  {"audio_base64": "<wav>", "stems": ["drums", "bass", "vocals", "other"]}
                 →  {"stems": {"drums": "<wav base64>", …}, "model": "htdemucs"}
    GET  /info · GET /health · POST /cancel

How it works
------------
The input WAV is written to a temporary folder and the Demucs command line runs as a subprocess::

    <python> -m demucs -n <model> -o <tmp>/out [-d <device>] [--two-stems <stem>]
             [--shifts N] [--overlap X] [--float32|--int24] <tmp>/in/track.wav

Demucs writes ``<tmp>/out/<model>/track/<stem>.wav``; the bridge base64-encodes the requested
stems. Using the CLI keeps the bridge independent of Demucs' Python API (it changed between
releases) and lets a cancelled job stop immediately: the process is killed when Song Deck aborts
the request or calls ``POST /cancel``.

* ``guitar`` / ``piano`` requested → the 6-stem model (``--model-6s``, default ``htdemucs_6s``).
* exactly one stem requested → ``--two-stems <stem>``: the response holds ``<stem>`` and
  ``no_<stem>`` (everything else) — much faster for vocal isolation.

Install and run
---------------
::

    pip install demucs                 # pulls in PyTorch; install the CUDA build of torch first for GPU
    python3 bridges/demucs_bridge.py --model htdemucs_ft --device cuda      # http://127.0.0.1:8812

Model weights download on first use (internet needed once; ``--repo`` points at a local folder).
In Song Deck: Settings → Providers → Add provider → Source separation → "Demucs (local)".

This is REFERENCE code (not exercised in Song Deck's CI). ``run_demucs()`` is the one function to
adapt if your Demucs version uses different flags or output paths.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__  # noqa: E402
from songdeck_bridge.cli import app_options, build_parser, check_bind, fail, serve, setup_logging  # noqa: E402
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    EngineError,
    RequestContext,
    json_response,
    req_list,
    req_str,
    run_command,
)
from songdeck_bridge.wav import WavError, decode_base64, encode_base64, wav_info  # noqa: E402

DEFAULT_PORT = 8812
FOUR_STEMS = ["drums", "bass", "vocals", "other"]
SIX_STEMS = FOUR_STEMS + ["guitar", "piano"]
SIX_STEM_MODELS = {"htdemucs_6s"}
KNOWN_MODELS = [
    {"id": "htdemucs", "name": "Hybrid Transformer Demucs (4 stems)"},
    {"id": "htdemucs_ft", "name": "Hybrid Transformer Demucs, fine-tuned (4 stems, slower, better)"},
    {"id": "htdemucs_6s", "name": "Hybrid Transformer Demucs (6 stems: + guitar, piano)"},
    {"id": "mdx_extra", "name": "MDX-Net extra (4 stems)"},
]


def run_demucs(input_wav: Path, out_dir: Path, model: str, two_stems: Optional[str], args: Any, ctx: RequestContext) -> Dict[str, Path]:
    """THE engine call: run the Demucs CLI and return {stem name: wav path}.

    Written for the Demucs 4.x command line (``python -m demucs`` = ``demucs.separate``):
    ``-n/--name``, ``-o/--out``, ``-d/--device``, ``--two-stems``, ``--shifts``, ``--overlap``,
    ``--segment``, ``-j/--jobs``, ``--float32``/``--int24``, ``--repo``; output files at
    ``<out>/<model>/<track name>/<stem>.wav`` (default ``--filename "{track}/{stem}.{ext}"``).
    Adapt the flags or the output lookup here for other versions/forks.
    """
    cmd: List[str] = [args.python, "-m", "demucs", "-n", model, "-o", str(out_dir)]
    if args.device and args.device != "auto":
        cmd += ["-d", args.device]  # "auto": Demucs picks CUDA when available, else CPU
    if two_stems:
        cmd += ["--two-stems", two_stems]
    cmd += ["--shifts", str(args.shifts), "--overlap", str(args.overlap)]
    if args.segment:
        cmd += ["--segment", str(args.segment)]
    if args.jobs:
        cmd += ["-j", str(args.jobs)]
    if args.output_format == "float32":
        cmd.append("--float32")
    elif args.output_format == "int24":
        cmd.append("--int24")
    if args.repo:
        cmd += ["--repo", args.repo]
    cmd += list(args.demucs_arg or [])
    cmd.append(str(input_wav))
    run_command(cmd, ctx, timeout=args.timeout, name="demucs")
    track_dir = out_dir / model / input_wav.stem
    files = {p.stem: p for p in track_dir.glob("*.wav")} if track_dir.is_dir() else {}
    if not files:  # other --filename templates / versions: search the whole output folder
        files = {p.stem: p for p in out_dir.rglob("*.wav")}
    return files


def check_engine(python: str) -> str:
    """Verify that Demucs can be imported by the configured interpreter; return its version."""
    try:
        r = subprocess.run([python, "-c", "import demucs; print(getattr(demucs, '__version__', 'unknown'))"],
                           capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail(f"could not run {python} to check for Demucs: {e}")
    if r.returncode != 0:
        detail = (r.stderr or r.stdout).strip().splitlines()[-1:] or ["no output"]
        fail(f"Demucs is not importable by {python} ({detail[0]}).\n"
             "Install it with:  pip install demucs   (installs PyTorch; for a GPU install the CUDA build of torch first)\n"
             "or point --python at the interpreter/venv that has it (--skip-check skips this test).")
    return r.stdout.strip() or "unknown"


def build_app(args: Any, engine_version: str) -> BridgeApp:
    app = BridgeApp("Demucs separation bridge", role="separation", **app_options(args))

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response({
            "name": app.name,
            "version": __version__,
            "engine": {"name": "demucs", "version": engine_version, "python": args.python},
            "models": KNOWN_MODELS,
            "default_model": args.model,
            "six_stem_model": args.model_6s,
            "capabilities": ["SOURCE_SEPARATION", "VOCAL_ISOLATION", "STEM_OUTPUT"],
            "stems": SIX_STEMS,
            "hardware": {"min_vram_gb": 0},
        })

    @app.job("POST", "/separate")
    def separate(ctx: RequestContext):
        body = ctx.json_object()
        try:
            wav_bytes = decode_base64(req_str(body, "audio_base64"), "audio_base64")
            meta = wav_info(wav_bytes)  # header check only: Demucs decodes the file itself
        except WavError as e:
            raise BadRequest(f"audio_base64: {e}") from None
        if meta["duration"] > args.max_duration:
            raise BadRequest(f"the audio is {meta['duration']:.0f} s long; this bridge accepts at most {args.max_duration:.0f} s (--max-duration)")
        raw = req_list(body, "stems", required=False, default=None) or list(FOUR_STEMS)
        stems: List[str] = []
        for i, s in enumerate(raw):
            name = s.strip().lower() if isinstance(s, str) else None
            if name not in SIX_STEMS:
                raise BadRequest(f"stems[{i}]: unknown stem {s!r} (Demucs models produce: {', '.join(SIX_STEMS)})")
            if name not in stems:
                stems.append(name)
        needs_six = any(s in ("guitar", "piano") for s in stems)
        model = args.model_6s if needs_six and args.model not in SIX_STEM_MODELS else args.model
        two_stems = stems[0] if len(stems) == 1 and not args.no_two_stems else None

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-demucs-") as tmp:
                inp = Path(tmp, "in", "track.wav")
                inp.parent.mkdir(parents=True)
                inp.write_bytes(wav_bytes)
                files = run_demucs(inp, Path(tmp, "out"), model, two_stems, args, ctx)
                wanted = stems + ([f"no_{two_stems}"] if two_stems else [])
                missing = [s for s in wanted if s not in files]
                if missing:
                    raise EngineError(f"Demucs ({model}) did not produce {', '.join(missing)} (got: {', '.join(sorted(files)) or 'nothing'})")
                out = {name: encode_base64(files[name].read_bytes()) for name in wanted}
            return json_response({"stems": out, "model": model}, headers={"X-Model": model})

        return work

    return app


def main(argv: Optional[List[str]] = None) -> int:
    p = build_parser("Song Deck separation bridge for Demucs (reference implementation).", DEFAULT_PORT, prog="demucs_bridge.py")
    p.set_defaults(model="htdemucs")
    d = p.add_argument_group("demucs")
    d.add_argument("--model-6s", default="htdemucs_6s", help="model used when guitar/piano stems are requested (default htdemucs_6s)")
    d.add_argument("--python", default=sys.executable, help="interpreter with Demucs installed (default: this one)")
    d.add_argument("--shifts", type=int, default=1, help="random shifts for equivariant stabilization (quality vs time; default 1)")
    d.add_argument("--overlap", type=float, default=0.25, help="overlap between prediction windows (default 0.25)")
    d.add_argument("--segment", type=int, default=None, help="segment length in seconds (lower = less memory)")
    d.add_argument("--jobs", type=int, default=0, help="parallel jobs inside Demucs (CPU; default 0)")
    d.add_argument("--output-format", choices=["float32", "int24", "int16"], default="float32", help="stem WAV encoding (default float32: stems sum exactly)")
    d.add_argument("--repo", default=None, help="local folder with Demucs models (offline use)")
    d.add_argument("--demucs-arg", action="append", default=[], metavar="ARG", help="extra argument passed to Demucs (repeatable)")
    d.add_argument("--no-two-stems", action="store_true", help="never use --two-stems for single-stem requests")
    d.add_argument("--max-duration", type=float, default=1800.0, help="longest accepted input in seconds (default 1800)")
    d.add_argument("--timeout", type=float, default=3600.0, help="seconds before a Demucs run is killed (default 3600)")
    d.add_argument("--skip-check", action="store_true", help="do not check at startup that Demucs is importable")
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    version = "unchecked" if args.skip_check else check_engine(args.python)
    return serve([(build_app(args, version), args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
