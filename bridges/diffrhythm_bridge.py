#!/usr/bin/env python3
"""
Song Deck MUSIC bridge for DiffRhythm (full songs with vocals from timed lyrics) — reference implementation.

Contract (packages/ai/src/contracts.ts, MUSIC_BRIDGE_PATHS)::

    GET  /info        → {name, version, models, capabilities, hardware}
    POST /generate    {prompt, lyrics?, duration_seconds, sections?, bpm?, key?,
                       reference_audio_base64?, guide_audio_base64?, model?, …}     → audio/wav
    POST /inpaint     {audio_base64, start_seconds, end_seconds, prompt, model?}    → audio/wav (edit mode)
    POST /transform · /extend → 501
    POST /cancel · GET /health

Engine: DiffRhythm (https://github.com/ASLP-lab/DiffRhythm) through its inference script, run in
``--diffrhythm-root`` with ``PYTHONPATH`` set to it (what its ``scripts/*.sh`` do)::

    {python} infer/infer.py --lrc-path {lrc} --ref-prompt {ref_prompt} --audio-length {audio_length}
                            --output-dir {output_dir} --chunked --batch-infer-num 1
    # reference audio instead of a text style (--ref-audio-command):
    {python} infer/infer.py --lrc-path {lrc} --ref-audio-path {ref_audio} --audio-length {audio_length} …
    # inpainting (--edit-command; DiffRhythm 1.2 edit mode):
    {python} infer/infer.py --lrc-path {lrc} --ref-prompt {ref_prompt} --audio-length {audio_length}
                            --output-dir {output_dir} --chunked --edit --ref-song {ref_song}
                            --edit-segments {edit_segments}

The script writes ``{output_dir}/output.wav`` (44.1 kHz stereo). ``--audio-length`` is 95 (the
base model, ``ASLP-lab/DiffRhythm-1_2``) or 96…285 (the full model, ``DiffRhythm-1_2-full``); the
script picks the model from it. The bridge asks for 95 s when the request fits, otherwise for the
request rounded up, and trims the result to ``duration_seconds`` (``--fixed-lengths`` rounds up to
95/285 for older checkouts that only accept those; their ``--repo-id`` flag can be added with
``--command``).

Lyrics → LRC: each ``[section]`` block of ``lyrics`` is placed on a request section (the next one
whose name matches the tag, e.g. ``[chorus]`` → "Chorus 2", else simply the next one) and its
lines are spread evenly from the section's ``start_seconds`` to its end. Without sections the
blocks share the song evenly after a short intro. Lines past the generated length are dropped.
No lyrics → an empty LRC (instrumental-ish output). The style is the prompt (+ ``bpm``, ``key``),
or the reference/guide audio (DiffRhythm wants at least ~10 s of it). DiffRhythm has no seed flag:
no ``X-Seed`` header is sent (``{seed}`` exists for forks that add one).

Placeholders: {python} {lrc} {ref_prompt} {ref_audio} {audio_length} {output_dir} {ref_song}
{edit_segments} {seed}. Commands run without a shell; a cancelled job kills the process.

Install and run::

    git clone https://github.com/ASLP-lab/DiffRhythm && cd DiffRhythm && pip install -r requirements.txt
    sudo apt-get install espeak-ng            # the phonemizer needs it (brew install espeak-ng on macOS)
    python3 bridges/diffrhythm_bridge.py --diffrhythm-root ~/DiffRhythm [--python ~/DiffRhythm/.venv/bin/python]   # :8822

In Song Deck: Settings → Providers → Add provider, preset ``diffrhythm-local``.

This is REFERENCE code (not exercised in Song Deck's CI): ``run_diffrhythm()``, ``build_lrc()``
and the templates are what to adapt; the plumbing was smoke-tested against a stand-in script.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__  # noqa: E402
from songdeck_bridge.cli import app_options, build_parser, check_bind, fail, serve, setup_logging  # noqa: E402
from songdeck_bridge.music import (  # noqa: E402
    Section,
    audio_file_to_wav,
    engine_check,
    env_with_pythonpath,
    find_audio_file,
    fit_wav_bytes,
    lrc_timestamp,
    parse_lyric_blocks,
    parse_sections,
    resolve_model,
    splice_range,
    style_prompt,
    wav_field,
)
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    EngineError,
    ModelLoader,
    NotSupported,
    RequestContext,
    command_from_template,
    json_response,
    req_bool,
    req_list,
    req_number,
    req_seed,
    req_str,
    run_command,
    wav_response,
)
from songdeck_bridge.wav import WavError, read_wav, wav_info, write_wav  # noqa: E402

DEFAULT_PORT = 8822
BASE_LENGTH, FULL_LENGTH = 95, 285
_COMMON = "--audio-length {audio_length} --output-dir {output_dir} --chunked --batch-infer-num 1"
DEFAULT_COMMAND = "{python} infer/infer.py --lrc-path {lrc} --ref-prompt {ref_prompt} " + _COMMON
DEFAULT_AUDIO_COMMAND = "{python} infer/infer.py --lrc-path {lrc} --ref-audio-path {ref_audio} " + _COMMON
DEFAULT_EDIT_COMMAND = (
    "{python} infer/infer.py --lrc-path {lrc} --ref-prompt {ref_prompt} --audio-length {audio_length} "
    "--output-dir {output_dir} --chunked --edit --ref-song {ref_song} --edit-segments {edit_segments}"
)
PLACEHOLDERS = (
    "python",
    "lrc",
    "ref_prompt",
    "ref_audio",
    "audio_length",
    "output_dir",
    "ref_song",
    "edit_segments",
    "seed",
)
INSTALL_HINT = (
    "install DiffRhythm's requirements into that Python: pip install -r requirements.txt (in the DiffRhythm checkout)"
)


def audio_length_for(seconds: float, fixed: bool) -> int:
    """The ``--audio-length`` to request: 95 (base model) when it fits, else the full model's length."""
    if seconds <= BASE_LENGTH:
        return BASE_LENGTH
    if seconds > FULL_LENGTH:
        raise BadRequest(f"DiffRhythm renders at most {FULL_LENGTH} s (got {seconds:g})")
    return FULL_LENGTH if fixed else max(BASE_LENGTH + 1, int(math.ceil(seconds - 1e-9)))


def _kind(name: str) -> str:
    m = re.match(r"[a-z\-]+", (name or "").strip().lower())
    return m.group(0).replace("-", "") if m else ""


def place_blocks(
    blocks: List[Tuple[str, List[str]]], sections: List[Section], duration: float
) -> List[Tuple[float, float, List[str]]]:
    """``[(start, end, lines)]``: lyric blocks on request sections (matching names first)."""
    out: List[Tuple[float, float, List[str]]] = []
    unused = list(sections)
    cursor = 0.0
    leftovers: List[List[str]] = []
    for tag, lines in blocks:
        if not lines:
            continue
        pick = next((s for s in unused if _kind(s.name) and _kind(s.name) == _kind(tag)), None)
        pick = pick or (unused[0] if unused else None)
        if pick is None:
            leftovers.append(lines)
            continue
        unused = [s for s in unused if s.start > pick.start]  # later blocks go later in the song
        out.append((pick.start, pick.end, lines))
        cursor = max(cursor, pick.end)
    if leftovers:  # no section left: share the remaining time (or the whole song without sections)
        start = cursor if out else min(10.0, 0.08 * duration)
        end = duration - min(5.0, 0.05 * duration)
        if end - start < 1.0:
            start, end = cursor, duration
        span = (end - start) / len(leftovers)
        for i, lines in enumerate(leftovers):
            out.append((start + i * span, start + (i + 1) * span, lines))
    return out


def build_lrc(lyrics: str, sections: List[Section], duration: float, limit: float) -> str:
    """LRC text: every line gets ``[mm:ss.xx]``, spread evenly within its block's time span."""
    lines_out: List[Tuple[float, str]] = []
    for start, end, lines in place_blocks(parse_lyric_blocks(lyrics), sections, duration):
        step = (end - start) / len(lines)
        for k, line in enumerate(lines):
            t = start + k * step
            if t < limit - 1.0:
                lines_out.append((t, line))
    lines_out.sort(key=lambda x: x[0])
    return "".join(f"[{lrc_timestamp(t)}]{line}\n" for t, line in lines_out)


def run_diffrhythm(
    ctx: RequestContext,
    args: Any,
    tmp: Path,
    *,
    template: str,
    lrc: str,
    ref_prompt: str,
    audio_length: int,
    seed: int,
    ref_audio: Optional[bytes] = None,
    ref_song: Optional[bytes] = None,
    edit_segments: Optional[List[List[float]]] = None,
) -> Path:
    """THE engine call: write the LRC (and audio inputs), run the script, return the produced WAV."""
    lrc_path, out_dir = tmp / "lyrics.lrc", tmp / "output"
    lrc_path.write_text(lrc, encoding="utf-8")
    out_dir.mkdir()
    values: Dict[str, str] = {
        "python": args.python,
        "lrc": str(lrc_path),
        "ref_prompt": ref_prompt,
        "ref_audio": "",
        "audio_length": str(audio_length),
        "output_dir": str(out_dir),
        "ref_song": "",
        "edit_segments": json.dumps(edit_segments or []),
        "seed": str(seed),
    }
    inputs = []
    if ref_audio is not None:
        (tmp / "reference.wav").write_bytes(ref_audio)
        values["ref_audio"] = str(tmp / "reference.wav")
        inputs.append(tmp / "reference.wav")
    if ref_song is not None:
        (tmp / "song.wav").write_bytes(ref_song)
        values["ref_song"] = str(tmp / "song.wav")
        inputs.append(tmp / "song.wav")
    run_command(
        command_from_template(template, values),
        ctx,
        cwd=args.diffrhythm_root,
        env=env_with_pythonpath(args.diffrhythm_root),
        timeout=args.timeout,
        name="diffrhythm",
    )
    out = out_dir / "output.wav"
    if not out.is_file():
        found = find_audio_file(out_dir, exclude=inputs)
        if found is None:
            raise EngineError(f"DiffRhythm finished without writing {out} (check the command template)")
        out = found
    return out


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("DiffRhythm music bridge", role="music", **app_options(args))
    loader = app.add_loader(
        ModelLoader(
            "DiffRhythm environment", engine_check(args.python, ["torch", "torchaudio"], INSTALL_HINT), retry_after=10
        )
    )
    model_id = "diffrhythm"
    models = [model_id]
    caps = [
        "TEXT_TO_MUSIC",
        "LYRIC_CONDITIONING",
        "VOCAL_GENERATION",
        "SECTION_GENERATION",
        "REFERENCE_AUDIO",
        "INPAINTING",
    ]

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        body: Dict[str, Any] = {
            "name": app.name,
            "version": __version__,
            "models": [{"id": model_id, "name": "DiffRhythm (95 s base / 285 s full, chosen by duration)"}],
            "capabilities": caps,
            "hardware": {"min_vram_gb": args.min_vram_gb},
            "max_duration_seconds": FULL_LENGTH,
            "status": loader.state,
        }
        if loader.state == "failed":
            body.update(error=loader.error, install=INSTALL_HINT)
        return json_response(body)

    @app.job("POST", "/generate")
    def generate(ctx: RequestContext):
        body = ctx.json_object()
        prompt = req_str(body, "prompt")
        duration = req_number(body, "duration_seconds", exclusive_minimum=0, maximum=FULL_LENGTH)
        seed, _ = req_seed(body)
        resolve_model(body, models, model_id)
        bpm = req_number(body, "bpm", required=False, minimum=20, maximum=400)
        key = req_str(body, "key", required=False, max_len=64)
        lyrics = req_str(body, "lyrics", required=False, default="") or ""
        instrumental = req_bool(body, "instrumental", default=False)
        sections = parse_sections(req_list(body, "sections", required=False, default=[]), duration)
        req_str(body, "negative_prompt", required=False)
        req_number(body, "strength", required=False, minimum=0, maximum=1)
        reference = wav_field(body, "reference_audio_base64", required=False) or wav_field(
            body, "guide_audio_base64", required=False
        )
        length = audio_length_for(duration, args.fixed_lengths)
        lrc = "" if instrumental else build_lrc(lyrics, sections, duration, length)
        style = style_prompt(prompt, bpm, key)
        loader.get()

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-diffrhythm-") as tmp:
                out = run_diffrhythm(
                    ctx,
                    args,
                    Path(tmp),
                    template=args.ref_audio_command if reference is not None else args.command,
                    lrc=lrc,
                    ref_prompt=style,
                    audio_length=length,
                    seed=seed,
                    ref_audio=reference,
                )
                wav = audio_file_to_wav(out, ctx, python=args.python, timeout=args.timeout)
            try:
                data = fit_wav_bytes(wav, duration)
            except WavError as e:
                raise EngineError(f"DiffRhythm output is not readable ({e})") from None
            ctx.check_cancelled()
            return wav_response(data, model=model_id, headers={"X-Audio-Length": str(length)})

        return work

    @app.job("POST", "/inpaint")
    def inpaint(ctx: RequestContext):
        body = ctx.json_object()
        data = wav_field(body, "audio_base64")
        start = req_number(body, "start_seconds", minimum=0)
        end = req_number(body, "end_seconds", minimum=0)
        prompt = req_str(body, "prompt")
        seed, _ = req_seed(body)
        resolve_model(body, models, model_id)
        total = wav_info(data)["duration"]
        if end <= start:
            raise BadRequest("'end_seconds' must be greater than 'start_seconds'")
        if start >= total:
            raise BadRequest(f"'start_seconds' ({start}) is beyond the end of the audio ({total:.3f} s)")
        end = min(end, total)
        length = audio_length_for(total, args.fixed_lengths)
        loader.get()

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-diffrhythm-") as tmp:
                out = run_diffrhythm(
                    ctx,
                    args,
                    Path(tmp),
                    template=args.edit_command,
                    lrc="",
                    ref_prompt=prompt,
                    audio_length=length,
                    seed=seed,
                    ref_song=data,
                    edit_segments=[[round(start, 3), round(end, 3)]],
                )
                wav = audio_file_to_wav(out, ctx, python=args.python, timeout=args.timeout)
            if args.no_splice:
                return wav_response(fit_wav_bytes(wav, total), model=model_id)
            try:
                spliced = splice_range(read_wav(data), read_wav(wav), start, end)
            except WavError as e:
                raise EngineError(f"DiffRhythm output is not readable ({e})") from None
            ctx.check_cancelled()
            return wav_response(write_wav(spliced), model=model_id)  # same format: untouched samples stay bit-identical

        return work

    @app.job("POST", "/transform")
    def transform(ctx: RequestContext):
        raise NotSupported(
            "DiffRhythm has no audio-to-audio mode in this bridge (use reference_audio_base64 in /generate)"
        )

    @app.job("POST", "/extend")
    def extend(ctx: RequestContext):
        raise NotSupported("DiffRhythm cannot continue audio in this bridge (no OUTPAINTING)")

    return app


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser(
        "Song Deck music bridge for DiffRhythm (reference implementation).", DEFAULT_PORT, prog="diffrhythm_bridge.py"
    )
    d = p.add_argument_group("DiffRhythm")
    d.add_argument("--diffrhythm-root", required=True, help="DiffRhythm checkout (working directory and PYTHONPATH)")
    d.add_argument("--python", default=sys.executable, help="interpreter of the DiffRhythm environment ({python})")
    d.add_argument("--command", default=DEFAULT_COMMAND, help="generation with a text style (see module docs)")
    d.add_argument("--ref-audio-command", default=DEFAULT_AUDIO_COMMAND, help="generation with reference audio")
    d.add_argument("--edit-command", default=DEFAULT_EDIT_COMMAND, help="inpainting (edit mode)")
    d.add_argument("--fixed-lengths", action="store_true", help="only ask for 95 or 285 s (older DiffRhythm checkouts)")
    d.add_argument("--no-splice", action="store_true", help="/inpaint returns DiffRhythm's full re-render")
    d.add_argument("--timeout", type=float, default=3600.0, help="seconds before a run is killed (default 3600)")
    d.add_argument("--min-vram-gb", type=float, default=8.0, help="VRAM requirement reported in /info (default 8)")
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    args.max_jobs = 1
    for name in ("command", "ref_audio_command", "edit_command"):
        for ph in re.findall(r"\{([A-Za-z_]+)\}", getattr(args, name)):
            if ph not in PLACEHOLDERS:
                fail(
                    f"unknown placeholder {{{ph}}} in --{name.replace('_', '-')} (known: {', '.join('{' + x + '}' for x in PLACEHOLDERS)})"
                )
    root = Path(args.diffrhythm_root)
    if not root.is_dir():
        fail(f"--diffrhythm-root {args.diffrhythm_root} is not a folder")
    if not (root / "infer" / "infer.py").is_file() and args.command == DEFAULT_COMMAND:
        print(f"warning: {root}/infer/infer.py not found; is this a DiffRhythm checkout?", file=sys.stderr)
    app = build_app(args)
    app.loaders[0].start()
    return serve([(app, args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
