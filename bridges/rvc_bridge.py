#!/usr/bin/env python3
"""
Song Deck VOICE-CONVERSION bridge for RVC (Retrieval-based Voice Conversion) — reference implementation.

Contract (packages/ai/src/contracts.ts, VOICE_CONVERSION_BRIDGE_PATHS)::

    GET  /voices   → [{"id", "name", "voice_type", "language", "kind"}]
    POST /convert  {"audio_base64": "<wav>", "target_voice_id": "<id>", "pitch_shift"?: semitones} → audio/wav
    GET  /info · GET /health · POST /cancel

Consent (spec §36): Song Deck refuses to send audio for a non-stock voice unless a consent
attestation was recorded — that check happens in the app before any request. This bridge only
converts to voice models installed in ``--models-dir``; it never downloads voices. Only install
models of voices you are authorized to use.

Voices
------
Every ``<id>.pth`` in ``--models-dir`` is a voice. Optional files next to it:
``<id>.index`` (retrieval index → ``{index}``) and ``<id>.json`` with
``{"name", "voice_type", "language", "kind"}`` (``kind`` defaults to ``imported``; use
``user-trained`` for your own voice — Song Deck asks for consent for anything that is not
``stock``).

How it works
------------
The input WAV is written to a temporary folder and the configured command runs (no shell) in
``--rvc-root``; the default template is::

    {python} infer_cli.py --input {input} --output {output} --model {model} --pitch {pitch}

Placeholders: {python} {input} {output} {model} (path of <id>.pth) {index} (path of <id>.index or
empty) {pitch} (integer semitones) {voice} (id) {f0_method} {index_rate} {device}.
RVC forks differ — e.g. for the RVC WebUI's ``tools/infer_cli.py`` (check ``--help``)::

    --rvc-root ~/Retrieval-based-Voice-Conversion-WebUI --models-dir ~/Retrieval-based-Voice-Conversion-WebUI/assets/weights \\
    --command "{python} tools/infer_cli.py --f0up_key {pitch} --input_path {input} --index_path {index} \\
               --f0method {f0_method} --opt_path {output} --model_name {voice}.pth --index_rate {index_rate} --device {device}"

The command is killed if Song Deck cancels. In Song Deck: Settings → Providers → Add provider →
Voice conversion → "RVC voice conversion (local)".

This is REFERENCE code (not exercised in Song Deck's CI); ``run_rvc()`` is the function to adapt.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__  # noqa: E402
from songdeck_bridge.cli import app_options, build_parser, check_bind, fail, resolve_device, serve, setup_logging  # noqa: E402
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    EngineError,
    NotFound,
    RequestContext,
    json_response,
    req_number,
    req_str,
    command_from_template,
    run_command,
    wav_response,
)
from songdeck_bridge.wav import WavError, decode_base64, wav_info  # noqa: E402

DEFAULT_PORT = 8814
DEFAULT_COMMAND = "{python} infer_cli.py --input {input} --output {output} --model {model} --pitch {pitch}"
PLACEHOLDERS = ("python", "input", "output", "model", "index", "pitch", "voice", "f0_method", "index_rate", "device")
VOICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")
VOICE_TYPES = ("soprano", "mezzo", "alto", "tenor", "baritone", "bass")


def scan_voices(models_dir: Path) -> Dict[str, Dict[str, Any]]:
    """<id>.pth (+ <id>.index, <id>.json) → contract voices with their file paths."""
    voices: Dict[str, Dict[str, Any]] = {}
    for pth in sorted(models_dir.glob("*.pth")):
        vid = pth.stem
        if not VOICE_ID_RE.match(vid):
            continue
        meta: Dict[str, Any] = {}
        meta_file = pth.with_suffix(".json")
        if meta_file.is_file():
            try:
                loaded = json.loads(meta_file.read_text(encoding="utf-8"))
                meta = loaded if isinstance(loaded, dict) else {}
            except ValueError:
                meta = {}
        index = pth.with_suffix(".index")
        voice_type = str(meta.get("voice_type") or "")
        voices[vid] = {
            "id": vid,
            "name": str(meta.get("name") or vid),
            "voice_type": voice_type if voice_type in VOICE_TYPES else "",
            "language": str(meta.get("language") or ""),
            "kind": str(meta.get("kind") or "imported"),
            "_model": str(pth.resolve()),
            "_index": str(index.resolve()) if index.is_file() else "",
        }
    return voices


def public(voice: Dict[str, Any]) -> Dict[str, str]:
    return {k: v for k, v in voice.items() if not k.startswith("_")}


def run_rvc(input_wav: Path, output_wav: Path, voice: Dict[str, Any], semitones: int, args: Any, ctx: RequestContext) -> bytes:
    """THE engine call: run the configured RVC command and return the converted WAV bytes."""
    device = resolve_device(args.device)
    values = {
        "python": args.python, "input": str(input_wav), "output": str(output_wav), "model": voice["_model"], "index": voice["_index"],
        "pitch": str(semitones), "voice": voice["id"], "f0_method": args.f0_method, "index_rate": f"{args.index_rate:g}",
        "device": "cuda:0" if device == "cuda" else device,
    }
    run_command(command_from_template(args.command, values), ctx, cwd=args.rvc_root, timeout=args.timeout, name="rvc")
    if not output_wav.is_file():
        produced = sorted(output_wav.parent.glob("*.wav"), key=lambda p: p.stat().st_mtime)
        produced = [p for p in produced if p != input_wav]
        if not produced:
            raise EngineError(f"the RVC command finished without writing {output_wav.name} (check --command)")
        output_wav = produced[-1]
    return output_wav.read_bytes()


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("RVC voice-conversion bridge", role="voice-conversion", **app_options(args))
    models_dir = Path(args.models_dir)

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        voices = scan_voices(models_dir)
        return json_response({
            "name": app.name,
            "version": __version__,
            "models": [{"id": f"rvc:{v['id']}", "name": f"RVC voice '{v['name']}'"} for v in voices.values()],
            "capabilities": ["VOICE_CONVERSION"],
            "voices": [public(v) for v in voices.values()],
            "hardware": {"min_vram_gb": 0},
        })

    @app.route("GET", "/voices")
    def list_voices(ctx: RequestContext):
        return json_response([public(v) for v in scan_voices(models_dir).values()])

    @app.job("POST", "/convert")
    def convert(ctx: RequestContext):
        body = ctx.json_object()
        try:
            wav_bytes = decode_base64(req_str(body, "audio_base64"), "audio_base64")
            meta = wav_info(wav_bytes)
        except WavError as e:
            raise BadRequest(f"audio_base64: {e}") from None
        if meta["duration"] > args.max_duration:
            raise BadRequest(f"the audio is {meta['duration']:.0f} s long; this bridge accepts at most {args.max_duration:.0f} s (--max-duration)")
        voice_id = req_str(body, "target_voice_id", allow_empty=False, max_len=128)
        voices = scan_voices(models_dir)
        if voice_id not in voices:
            raise NotFound(f"unknown target_voice_id '{voice_id}' (installed: {', '.join(voices) or 'none'} in {models_dir})")
        shift = req_number(body, "pitch_shift", required=False, default=0.0, minimum=-24, maximum=24)
        semitones = int(round(shift))  # RVC transposes in whole semitones
        voice = voices[voice_id]

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-rvc-") as tmp:
                inp = Path(tmp, "input.wav")
                inp.write_bytes(wav_bytes)
                out = run_rvc(inp, Path(tmp, "output.wav"), voice, semitones, args, ctx)
            try:
                wav_info(out)
            except WavError as e:
                raise EngineError(f"the RVC output is not a readable WAV ({e})") from None
            ctx.check_cancelled()
            return wav_response(out, model=f"rvc:{voice_id}", headers={"X-Voice-Id": voice_id, "X-Pitch-Shift": str(semitones)})

        return work

    return app


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser("Song Deck voice-conversion bridge for RVC (reference implementation).", DEFAULT_PORT, prog="rvc_bridge.py")
    r = p.add_argument_group("RVC")
    r.add_argument("--models-dir", required=True, help="folder with <voice>.pth models (+ optional .index and .json)")
    r.add_argument("--rvc-root", default=None, help="working directory of the command (your RVC checkout)")
    r.add_argument("--command", default=DEFAULT_COMMAND, help=f"conversion command template (default: {DEFAULT_COMMAND!r})")
    r.add_argument("--python", default=sys.executable, help="interpreter of the RVC environment ({python})")
    r.add_argument("--f0-method", default="rmvpe", help="pitch extraction method passed as {f0_method} (default rmvpe)")
    r.add_argument("--index-rate", type=float, default=0.75, help="retrieval index rate passed as {index_rate} (default 0.75)")
    r.add_argument("--max-duration", type=float, default=900.0, help="longest accepted input in seconds (default 900)")
    r.add_argument("--timeout", type=float, default=1800.0, help="seconds before a conversion is killed (default 1800)")
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    for ph in re.findall(r"\{([a-z_]+)\}", args.command):
        if ph not in PLACEHOLDERS:
            fail(f"unknown placeholder {{{ph}}} in --command (known: {', '.join('{' + x + '}' for x in PLACEHOLDERS)})")
    if not Path(args.models_dir).is_dir():
        fail(f"--models-dir {args.models_dir} is not a folder")
    if args.rvc_root and not Path(args.rvc_root).is_dir():
        fail(f"--rvc-root {args.rvc_root} is not a folder")
    if not scan_voices(Path(args.models_dir)):
        print(f"warning: no <voice>.pth models found in {args.models_dir}", file=sys.stderr)
    return serve([(build_app(args), args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
