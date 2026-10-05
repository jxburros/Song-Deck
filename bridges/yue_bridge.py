#!/usr/bin/env python3
"""
Song Deck MUSIC bridge for YuE (full songs with vocals from lyrics + style) — reference implementation.

Contract (packages/ai/src/contracts.ts, MUSIC_BRIDGE_PATHS)::

    GET  /info        → {name, version, models, capabilities, hardware}
    POST /generate    {prompt, lyrics, duration_seconds, seed?, bpm?, key?, instrumental?,
                       reference_audio_base64?, guide_audio_base64?, model?, …}     → audio/wav
    POST /transform · /inpaint · /extend → 501
    POST /cancel · GET /health

Two generations of YuE (https://github.com/multimodal-art-projection/YuE) are supported, chosen
with ``--engine`` (``auto`` looks at ``--yue-root``):

``yue2`` — the current main branch (YuE2, ``pip install .`` in the checkout). The bridge runs its
CLI (``--python`` must be the interpreter where yue2 is installed)::

    {python} -m yue2.cli generate --id song --style {style} --lyrics-file {lyrics_txt} --seed {seed}
             --output {output_dir} --device {device} --model {model} --quiet

and reads ``{output_dir}/song/audio.flac`` (48 kHz stereo). YuE2 composes the song length itself.

``yue1`` — the original YuE (branch ``YuE-v1``; ``inference/infer.py``)::

    {python} infer.py --cuda_idx {cuda_idx} --stage1_model {stage1_model} --stage2_model {stage2_model}
             --genre_txt {genre_txt} --lyrics_txt {lyrics_txt} --run_n_segments {segments}
             --stage2_batch_size {stage2_batch_size} --output_dir {output_dir}
             --max_new_tokens {max_new_tokens} --repetition_penalty {repetition_penalty} --seed {seed}

run in ``<yue-root>/inference``. With reference/guide audio the bridge uses in-context learning:
``--icl-args`` (default ``--use_audio_prompt --audio_prompt_path {audio_prompt}
--prompt_start_time 0 --prompt_end_time {prompt_end}``) is appended and the stage-1 model becomes
``--stage1-icl-model`` (``m-a-p/YuE-s1-7B-anneal-en-icl``). One lyric section is one segment;
``max_new_tokens`` covers the requested duration at ``--tokens-per-second`` (100, i.e. 3000 ≈ 30 s
per segment). The final mix is ``{output_dir}/*_mixed.mp3`` (the vocoder output); an
``instrumental: true`` request returns the instrumental stem (``vocoder/stems/itrack.mp3``).

Both templates are overridable (``--command``, ``--icl-args``); placeholders: {python} {style}
{genre_txt} {lyrics_txt} {output_dir} {seed} {device} {cuda_idx} {model} {stage1_model}
{stage2_model} {segments} {max_new_tokens} {stage2_batch_size} {repetition_penalty}
{audio_prompt} {prompt_end}. Commands run without a shell.

Request mapping: ``prompt`` (+ ``bpm``, ``key``) is the style (YuE2) / genre tags (YuE v1);
``lyrics`` keep their ``[verse]``/``[chorus]`` sections (written to a temp lyrics file; YuE needs
lyrics, so a request without them is a 400). The output is trimmed or padded to
``duration_seconds``. MP3/FLAC outputs are converted with ffmpeg, or with soundfile/torchaudio in
``--python``. A cancelled job kills the YuE process.

In Song Deck: Settings → Providers → Add provider, preset ``yue-local``.

This is REFERENCE code (not exercised in Song Deck's CI): ``run_yue()`` and the templates are what
to adapt; the plumbing was smoke-tested against a stand-in command.
"""

from __future__ import annotations

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
from songdeck_bridge.music import (  # noqa: E402
    audio_file_to_wav,
    engine_check,
    find_audio_file,
    fit_wav_bytes,
    lyrics_text,
    parse_lyric_blocks,
    resolve_model,
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
from songdeck_bridge.wav import WavError, wav_info  # noqa: E402

DEFAULT_PORT = 8821
YUE2_COMMAND = (
    "{python} -m yue2.cli generate --id song --style {style} --lyrics-file {lyrics_txt} --seed {seed} "
    "--output {output_dir} --device {device} --model {model} --quiet"
)
YUE1_COMMAND = (
    "{python} infer.py --cuda_idx {cuda_idx} --stage1_model {stage1_model} --stage2_model {stage2_model} "
    "--genre_txt {genre_txt} --lyrics_txt {lyrics_txt} --run_n_segments {segments} "
    "--stage2_batch_size {stage2_batch_size} --output_dir {output_dir} --max_new_tokens {max_new_tokens} "
    "--repetition_penalty {repetition_penalty} --seed {seed}"
)
YUE1_ICL_ARGS = (
    "--use_audio_prompt --audio_prompt_path {audio_prompt} --prompt_start_time 0 --prompt_end_time {prompt_end}"
)
PLACEHOLDERS = (
    "python",
    "style",
    "genre_txt",
    "lyrics_txt",
    "output_dir",
    "seed",
    "device",
    "cuda_idx",
    "model",
    "stage1_model",
    "stage2_model",
    "segments",
    "max_new_tokens",
    "stage2_batch_size",
    "repetition_penalty",
    "audio_prompt",
    "prompt_end",
)


def detect_engine(args: Any) -> str:
    if args.engine != "auto":
        return args.engine
    root = Path(args.yue_root) if args.yue_root else None
    if root is not None and (root / "inference" / "infer.py").is_file():
        return "yue1"
    return "yue2"


def capabilities(engine: str) -> List[str]:
    caps = ["TEXT_TO_MUSIC", "LYRIC_CONDITIONING", "VOCAL_GENERATION", "SECTION_GENERATION"]
    return caps + (["REFERENCE_AUDIO"] if engine == "yue1" else [])


def lyrics_for(engine: str, lyrics: str) -> str:
    """YuE v1 expects lower-case ``[verse]`` tags, YuE2 ``[Verse]``; sections are blank-line separated."""
    blocks = parse_lyric_blocks(lyrics)
    if not blocks:
        return ""
    fix = (lambda t: t.lower()) if engine == "yue1" else (lambda t: " ".join(w.capitalize() for w in t.split()))
    return lyrics_text([(fix(tag), lines) for tag, lines in blocks])


def run_yue(
    ctx: RequestContext,
    args: Any,
    engine: str,
    tmp: Path,
    *,
    style: str,
    lyrics: str,
    seed: int,
    duration: float,
    reference: Optional[bytes],
    instrumental: bool,
) -> Path:
    """THE engine call: write the prompt files, run the YuE command, return the produced audio file."""
    genre_txt, lyrics_txt, out_dir = tmp / "genre.txt", tmp / "lyrics.txt", tmp / "output"
    out_dir.mkdir()
    genre = re.sub(r"\s+", " ", style.replace(",", " ")).strip()  # YuE v1: space-separated tags
    genre_txt.write_text(genre if engine == "yue1" else style, encoding="utf-8")
    lyrics_txt.write_text(lyrics, encoding="utf-8")
    segments = max(1, len(parse_lyric_blocks(lyrics)))
    device = resolve_device(args.device)
    values: Dict[str, str] = {
        "python": args.python,
        "style": style,
        "genre_txt": str(genre_txt),
        "lyrics_txt": str(lyrics_txt),
        "output_dir": str(out_dir),
        "seed": str(seed),
        "device": device,
        "cuda_idx": device.split(":", 1)[1] if device.startswith("cuda:") else "0",
        "model": args.model,
        "stage1_model": args.stage1_model,
        "stage2_model": args.stage2_model,
        "segments": str(min(segments, args.max_segments)),
        "max_new_tokens": str(max(500, int(duration * args.tokens_per_second / min(segments, args.max_segments)))),
        "stage2_batch_size": str(args.stage2_batch_size),
        "repetition_penalty": f"{args.repetition_penalty:g}",
        "audio_prompt": "",
        "prompt_end": "30",
    }
    template = args.command or (YUE1_COMMAND if engine == "yue1" else YUE2_COMMAND)
    if reference is not None and engine == "yue1":
        ref = tmp / "reference.wav"
        ref.write_bytes(reference)
        values.update(
            audio_prompt=str(ref),
            prompt_end=f"{min(30.0, wav_info(reference)['duration']):.2f}",
            stage1_model=args.stage1_icl_model,
        )
        template = f"{template} {args.icl_args}"
    cwd = args.yue_root
    if engine == "yue1" and args.yue_root and Path(args.yue_root, "inference").is_dir():
        cwd = str(Path(args.yue_root, "inference"))  # infer.py resolves its codec paths from there
    run_command(command_from_template(template, values), ctx, cwd=cwd, timeout=args.timeout, name="yue")
    if engine == "yue1":
        top = [p for p in out_dir.glob("*") if p.is_file() and "mix" in p.name.lower()]
        found = (
            find_audio_file(out_dir, prefer=("itrack", "instrumental"))
            if instrumental
            else (
                sorted(top, key=lambda p: p.stat().st_mtime)[-1]
                if top
                else find_audio_file(out_dir, prefer=("mixed", "mix"), avoid=("itrack", "vtrack"))
            )
        )
    else:
        found = find_audio_file(out_dir, prefer=("audio",))
    if found is None:
        raise EngineError(f"YuE finished without writing audio into {out_dir} (check --command)")
    return found


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("YuE music bridge", role="music", **app_options(args))
    engine = detect_engine(args)
    models = [args.model if engine == "yue2" else args.stage1_model]
    hint = (
        "install YuE2 into that Python: git clone https://github.com/multimodal-art-projection/YuE && cd YuE && pip install ."
        if engine == "yue2"
        else "install YuE v1's requirements into that Python (pip install -r requirements.txt in the YuE-v1 checkout)"
    )
    modules = ["yue2"] if engine == "yue2" else ["torch", "torchaudio", "transformers"]
    loader = app.add_loader(
        ModelLoader(f"YuE ({engine}) environment", engine_check(args.python, modules, hint), retry_after=10)
    )

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            {
                "name": app.name,
                "version": __version__,
                "engine": engine,
                "models": [
                    {"id": models[0], "name": ("YuE2 " if engine == "yue2" else "YuE ") + models[0].split("/")[-1]}
                ],
                "capabilities": capabilities(engine),
                "hardware": {"min_vram_gb": args.min_vram_gb},
                "max_duration_seconds": args.max_duration,
                "status": loader.state,
                **({"error": loader.error, "install": hint} if loader.state == "failed" else {}),
            }
        )

    @app.job("POST", "/generate")
    def generate(ctx: RequestContext):
        body = ctx.json_object()
        prompt = req_str(body, "prompt")
        duration = req_number(body, "duration_seconds", exclusive_minimum=0, maximum=args.max_duration)
        seed, _ = req_seed(body)
        resolve_model(body, models, models[0])
        bpm = req_number(body, "bpm", required=False, minimum=20, maximum=400)
        key = req_str(body, "key", required=False, max_len=64)
        lyrics = lyrics_for(engine, req_str(body, "lyrics", required=False, default="") or "")
        if not lyrics.strip():
            raise BadRequest("YuE writes songs from lyrics: 'lyrics' is required ([verse]/[chorus] sections)")
        instrumental = req_bool(body, "instrumental", default=False)
        if instrumental and engine != "yue1":
            raise NotSupported(
                "YuE2's command line produces only the full mix; instrumental output needs --engine yue1"
            )
        req_list(body, "sections", required=False)  # section order comes from the lyric tags
        req_str(body, "negative_prompt", required=False)
        req_number(body, "strength", required=False, minimum=0, maximum=1)
        reference = wav_field(body, "reference_audio_base64", required=False) or wav_field(
            body, "guide_audio_base64", required=False
        )
        style = style_prompt(prompt, bpm, key)
        loader.get()  # 503 while the environment check runs; 500 with the install hint when it failed

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-yue-") as tmp:
                path = run_yue(
                    ctx,
                    args,
                    engine,
                    Path(tmp),
                    style=style,
                    lyrics=lyrics,
                    seed=seed,
                    duration=duration,
                    reference=reference if engine == "yue1" else None,
                    instrumental=instrumental,
                )
                wav = audio_file_to_wav(path, ctx, python=args.python, ffmpeg=args.ffmpeg, timeout=args.timeout)
            try:
                out = fit_wav_bytes(wav, duration)
            except WavError as e:
                raise EngineError(f"YuE output is not readable ({e})") from None
            ctx.check_cancelled()
            headers = {"X-Reference-Ignored": "true"} if reference is not None and engine != "yue1" else None
            return wav_response(out, seed=seed, model=models[0], headers=headers)

        return work

    for path in ("/transform", "/inpaint", "/extend"):
        app.add_route("POST", path, _unsupported(path), job=True)
    return app


def _unsupported(path: str):
    def handler(ctx: RequestContext):
        raise NotSupported(f"YuE generates whole songs; {path} is not supported by this bridge")

    return handler


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser(
        "Song Deck music bridge for YuE / YuE2 (reference implementation).", DEFAULT_PORT, prog="yue_bridge.py"
    )
    p.set_defaults(model="m-a-p/YuE2-3B")
    y = p.add_argument_group("YuE")
    y.add_argument(
        "--engine",
        choices=["auto", "yue2", "yue1"],
        default="auto",
        help="auto: yue1 when <yue-root>/inference/infer.py exists, else yue2",
    )
    y.add_argument(
        "--yue-root", default=None, help="YuE checkout (working directory of the command; required for yue1)"
    )
    y.add_argument("--python", default=sys.executable, help="interpreter of the YuE environment ({python})")
    y.add_argument("--command", default=None, help="command template (default: the yue2 or yue1 template above)")
    y.add_argument("--icl-args", default=YUE1_ICL_ARGS, help="yue1: arguments appended when reference audio is given")
    y.add_argument("--stage1-model", default="m-a-p/YuE-s1-7B-anneal-en-cot", help="yue1 stage-1 model")
    y.add_argument(
        "--stage1-icl-model", default="m-a-p/YuE-s1-7B-anneal-en-icl", help="yue1 stage-1 model with reference audio"
    )
    y.add_argument("--stage2-model", default="m-a-p/YuE-s2-1B-general", help="yue1 stage-2 model")
    y.add_argument("--stage2-batch-size", type=int, default=4)
    y.add_argument("--repetition-penalty", type=float, default=1.1)
    y.add_argument(
        "--tokens-per-second", type=float, default=100.0, help="yue1 stage-1 tokens per second of audio (default 100)"
    )
    y.add_argument("--max-segments", type=int, default=8, help="yue1: most lyric sections generated (default 8)")
    y.add_argument("--ffmpeg", default=None, help="ffmpeg executable for MP3/FLAC outputs (default: from PATH)")
    y.add_argument("--max-duration", type=float, default=360.0, help="longest song in seconds (default 360)")
    y.add_argument("--timeout", type=float, default=7200.0, help="seconds before a YuE run is killed (default 7200)")
    y.add_argument("--min-vram-gb", type=float, default=24.0, help="VRAM requirement reported in /info (default 24)")
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    args.max_jobs = 1
    for tpl, name in ((args.command or "", "--command"), (args.icl_args, "--icl-args")):
        for ph in re.findall(r"\{([A-Za-z_]+)\}", tpl):
            if ph not in PLACEHOLDERS:
                fail(
                    f"unknown placeholder {{{ph}}} in {name} (known: {', '.join('{' + x + '}' for x in PLACEHOLDERS)})"
                )
    if args.yue_root and not Path(args.yue_root).is_dir():
        fail(f"--yue-root {args.yue_root} is not a folder")
    engine = detect_engine(args)
    if (
        engine == "yue1"
        and not args.command
        and not (args.yue_root and Path(args.yue_root, "inference", "infer.py").is_file())
    ):
        fail(
            "--engine yue1 needs --yue-root pointing at a YuE v1 checkout (git clone -b YuE-v1 https://github.com/multimodal-art-projection/YuE)"
        )
    print(f"YuE engine: {engine} (python {args.python})", file=sys.stderr)
    app = build_app(args)
    app.loaders[0].start()
    return serve([(app, args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
