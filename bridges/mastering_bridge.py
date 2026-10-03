#!/usr/bin/env python3
"""
Song Deck MASTERING bridge — reference implementation (Matchering / pyloudnorm / stdlib).

Contract (packages/ai/src/contracts.ts, MASTERING_BRIDGE_PATHS)::

    POST /master  {"audio_base64": "<wav>", "target": "streaming|cd|loud-rock|dynamic|podcast|demo",
                   "reference_audio_base64"?: "<wav>"}                            → audio/wav
    GET  /info · GET /health · POST /cancel

Engines (``--engine auto`` picks the first that applies):

1. **Matchering 2** (``pip install matchering``) when a reference track is supplied: matches the
   reference's loudness, frequency response and stereo width::

       import matchering as mg
       mg.process(target="mix.wav", reference="reference.wav", results=[mg.pcm24("master.wav")])

   It runs in a subprocess (``--python``), so a cancelled job is killed immediately.
2. **pyloudnorm** (``pip install pyloudnorm``, needs numpy): ITU-R BS.1770 loudness normalization
   to the target (or to the reference's loudness) followed by a look-ahead peak limiter.
3. **stdlib** fallback: the same algorithm in pure Python (``songdeck_bridge.dsp.master`` — what
   the mock bridge uses). Fine for previews; slow on long files.

Targets (integrated loudness / sample-peak ceiling; ``cd`` is written as 16-bit with TPDF dither,
the others as 24-bit PCM)::

    streaming −14 LUFS / −1.0 dBFS   cd −9 / −0.3   loud-rock −8 / −0.3
    dynamic −18 / −1.0               podcast −16 / −1.0   demo −12 / −1.0

Responses carry ``X-Model`` (matchering-2 | pyloudnorm | songdeck-stdlib-loudness) and, when
measured, ``X-Integrated-LUFS``.

Run: ``python3 bridges/mastering_bridge.py`` (http://127.0.0.1:8815). In Song Deck: Settings →
Providers → Add provider → Mastering → "Local mastering engine".

This is REFERENCE code (only the stdlib path is exercised by Song Deck's CI, through the mock
bridge). ``run_matchering()`` and ``master_pyloudnorm()`` are the functions to adapt.
"""
from __future__ import annotations

import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__, dsp  # noqa: E402
from songdeck_bridge.cli import app_options, build_parser, check_bind, fail, module_available, serve, setup_logging  # noqa: E402
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    EngineError,
    RequestContext,
    json_response,
    req_str,
    run_command,
    wav_response,
)
from songdeck_bridge.wav import Audio, WavError, decode_base64, read_wav, wav_info, write_wav  # noqa: E402

DEFAULT_PORT = 8815
TARGETS = dsp.MASTERING_TARGETS

MATCHERING_SCRIPT = (
    "import sys\n"
    "import matchering as mg\n"
    "target, reference, out, bits = sys.argv[1:5]\n"
    "mg.process(target=target, reference=reference, results=[mg.pcm16(out) if bits == '16' else mg.pcm24(out)])\n"
)


def matchering_available(python: str) -> bool:
    try:
        return subprocess.run([python, "-c", "import matchering"], capture_output=True, timeout=120).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def run_matchering(target_wav: bytes, reference_wav: bytes, bits: int, args: Any, ctx: RequestContext) -> bytes:
    """THE Matchering call (Matchering 2.0 API), in a subprocess so cancellation can kill it."""
    with tempfile.TemporaryDirectory(prefix="songdeck-matchering-") as tmp:
        t, r, o = Path(tmp, "target.wav"), Path(tmp, "reference.wav"), Path(tmp, "master.wav")
        t.write_bytes(target_wav)
        r.write_bytes(reference_wav)
        run_command([args.python, "-c", MATCHERING_SCRIPT, str(t), str(r), str(o), str(bits)], ctx, timeout=args.timeout, name="matchering")
        if not o.is_file():
            raise EngineError("Matchering finished without writing the master")
        return o.read_bytes()


def _limit_numpy(np: Any, data: Any, sr: int, ceiling: float, release_s: float = 0.08, block_s: float = 0.003) -> Any:
    """Vectorized version of songdeck_bridge.dsp.limit for (frames, channels) arrays."""
    n = data.shape[0]
    if n == 0 or float(np.abs(data).max()) <= ceiling:
        return data
    b = max(16, int(sr * block_s))
    nb = -(-n // b)
    peaks = np.pad(np.abs(data).max(axis=1), (0, nb * b - n)).reshape(nb, b).max(axis=1)
    req = np.where(peaks > ceiling, ceiling / np.maximum(peaks, 1e-12), 1.0)
    target = np.minimum(np.concatenate([[1.0], req]), np.concatenate([req, [1.0]]))
    rc = 1.0 - math.exp(-b / max(1.0, release_s * sr))
    bounds = np.empty(nb + 1)
    g = 1.0
    for k in range(nb + 1):
        g += (1.0 - g) * rc
        g = min(g, float(target[k]))
        bounds[k] = g
    gains = np.interp(np.arange(n), np.arange(nb + 1) * b, bounds)
    return np.clip(data * gains[:, None], -ceiling, ceiling)


def master_pyloudnorm(audio: Audio, target: str, reference: Optional[Audio], ctx: RequestContext) -> Tuple[Audio, Dict[str, float]]:
    """THE pyloudnorm path: BS.1770 meter → loudness normalize → peak limit."""
    import numpy as np  # type: ignore
    import pyloudnorm as pyln  # type: ignore

    spec = TARGETS[target]
    report: Dict[str, float] = {"ceiling_db": spec["ceiling_db"]}
    target_lufs = spec["lufs"]
    if reference is not None:
        try:
            ref_lufs = pyln.Meter(reference.sample_rate).integrated_loudness(np.array(reference.channels, dtype=np.float64).T)
        except ValueError:  # shorter than one 400 ms block
            ref_lufs = float("-inf")
        if math.isfinite(ref_lufs):
            target_lufs = max(-24.0, min(-6.0, float(ref_lufs)))
            report["reference_lufs"] = round(float(ref_lufs), 2)
    report["target_lufs"] = target_lufs
    data = np.array(audio.channels, dtype=np.float64).T
    meter = pyln.Meter(audio.sample_rate)
    try:
        measured = float(meter.integrated_loudness(data))
    except ValueError:
        measured = float("-inf")
    ctx.check_cancelled()
    if math.isfinite(measured):
        report["input_lufs"] = round(measured, 2)
        gain_db = max(-24.0, min(24.0, target_lufs - measured))
        data = data * (10.0 ** (gain_db / 20.0))
        report["gain_db"] = round(gain_db, 2)
    data = _limit_numpy(np, data, audio.sample_rate, 10.0 ** (spec["ceiling_db"] / 20.0))
    try:
        report["output_lufs"] = round(float(meter.integrated_loudness(data)), 2)
    except ValueError:
        pass
    return Audio(audio.sample_rate, [list(map(float, ch)) for ch in data.T], int(spec["bits"]), False), report


def choose_engine(args: Any, has_reference: bool) -> str:
    if args.engine != "auto":
        return args.engine
    if has_reference and args.matchering_ok:
        return "matchering"
    if args.pyloudnorm_ok:
        return "pyloudnorm"
    return "stdlib"


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("Mastering bridge", role="mastering", **app_options(args))

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        engines = (["matchering-2"] if args.matchering_ok else []) + (["pyloudnorm"] if args.pyloudnorm_ok else []) + ["songdeck-stdlib-loudness"]
        return json_response({
            "name": app.name,
            "version": __version__,
            "models": [{"id": e, "name": e} for e in engines],
            "capabilities": ["MASTERING", "REFERENCE_AUDIO"],
            "targets": TARGETS,
            "engine": args.engine,
            "hardware": {"min_vram_gb": 0},
        })

    @app.job("POST", "/master")
    def master(ctx: RequestContext):
        body = ctx.json_object()
        target = req_str(body, "target", choices=list(TARGETS))
        try:
            audio_bytes = decode_base64(req_str(body, "audio_base64"), "audio_base64")
            meta = wav_info(audio_bytes)
            ref_text = req_str(body, "reference_audio_base64", required=False)
            ref_bytes = decode_base64(ref_text, "reference_audio_base64") if ref_text else None
            if ref_bytes is not None:
                wav_info(ref_bytes)
        except WavError as e:
            raise BadRequest(str(e)) from None
        if meta["duration"] > args.max_duration:
            raise BadRequest(f"the audio is {meta['duration']:.0f} s long; this bridge accepts at most {args.max_duration:.0f} s (--max-duration)")
        engine = choose_engine(args, ref_bytes is not None)
        if engine == "matchering" and ref_bytes is None:
            raise BadRequest("this bridge runs Matchering (--engine matchering), which needs 'reference_audio_base64'")
        bits = int(TARGETS[target]["bits"])

        def work():
            if engine == "matchering":
                wav = run_matchering(audio_bytes, ref_bytes, bits, args, ctx)  # type: ignore[arg-type]
                return wav_response(wav, model="matchering-2")
            try:
                audio = read_wav(audio_bytes)
                reference = read_wav(ref_bytes) if ref_bytes is not None else None
            except WavError as e:
                raise BadRequest(str(e)) from None
            if engine == "pyloudnorm":
                out, report = master_pyloudnorm(audio, target, reference, ctx)
                model = "pyloudnorm"
            else:
                out, report = dsp.master(audio, target, reference, ctx.check_cancelled)
                model = "songdeck-stdlib-loudness"
            ctx.check_cancelled()
            headers = {"X-Target-LUFS": f"{report['target_lufs']:.2f}"}
            if report.get("output_lufs", -999.0) > -999.0:
                headers["X-Integrated-LUFS"] = f"{report['output_lufs']:.2f}"
            if "gain_db" in report:
                headers["X-Gain-dB"] = f"{report['gain_db']:.2f}"
            return wav_response(write_wav(out, bits=bits, dither=bits == 16), model=model, headers=headers)

        return work

    return app


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser("Song Deck mastering bridge: Matchering / pyloudnorm / stdlib loudness (reference implementation).", DEFAULT_PORT, prog="mastering_bridge.py")
    m = p.add_argument_group("mastering")
    m.add_argument("--engine", choices=["auto", "matchering", "pyloudnorm", "stdlib"], default="auto",
                   help="auto: Matchering when a reference is given, else pyloudnorm, else stdlib (default auto)")
    m.add_argument("--python", default=sys.executable, help="interpreter with Matchering installed (default: this one)")
    m.add_argument("--max-duration", type=float, default=1800.0, help="longest accepted input in seconds (default 1800)")
    m.add_argument("--timeout", type=float, default=1800.0, help="seconds before a Matchering run is killed (default 1800)")
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    args.matchering_ok = matchering_available(args.python)
    args.pyloudnorm_ok = module_available("pyloudnorm") and module_available("numpy")
    if args.engine == "matchering" and not args.matchering_ok:
        fail(f"Matchering is not importable by {args.python}. Install it with:  pip install matchering")
    if args.engine == "pyloudnorm" and not args.pyloudnorm_ok:
        fail("pyloudnorm/numpy are not installed for this Python. Install them with:  pip install pyloudnorm numpy")
    available = ", ".join(e for e, ok in (("matchering", args.matchering_ok), ("pyloudnorm", args.pyloudnorm_ok), ("stdlib", True)) if ok)
    print(f"mastering engines available: {available}", file=sys.stderr)
    return serve([(build_app(args), args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
