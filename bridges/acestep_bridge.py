#!/usr/bin/env python3
"""
Song Deck MUSIC bridge for ACE-Step — reference implementation.

Contract (packages/ai/src/contracts.ts, MUSIC_BRIDGE_PATHS)::

    GET  /info        → {name, version, models, capabilities, hardware}
    POST /generate    {prompt, duration_seconds, seed?, bpm?, key?, lyrics?, sections?, instrumental?,
                       guide_audio_base64?, reference_audio_base64?, strength?, model?}   → audio/wav
    POST /transform   {audio_base64, prompt, strength, seed?, model?}                      → audio/wav
    POST /inpaint     {audio_base64, start_seconds, end_seconds, prompt, seed?, model?}    → audio/wav
    POST /extend      {audio_base64, prompt, duration_seconds, seed?, model?}              → audio/wav
    POST /cancel      {job_id?} → 204                    (+ GET /health)

Expected engine version
-----------------------
ACE-Step **v1** (https://github.com/ace-step/ACE-Step, Apache-2.0; ``pip install -e .`` in a
checkout; the ``ACE-Step/ACE-Step-v1-3.5B`` checkpoints download on first use or come from
``--checkpoint-dir``), through its Python pipeline::

    from acestep.pipeline_ace_step import ACEStepPipeline
    pipe = ACEStepPipeline(checkpoint_dir=…, dtype="bfloat16", torch_compile=False, cpu_offload=False, overlapped_decode=False)
    paths = pipe(format="wav", audio_duration=…, prompt="tags", lyrics="[verse]\\n…", manual_seeds=[seed],
                 infer_step=60, guidance_scale=15, scheduler_type="euler", cfg_type="apg", omega_scale=10,
                 save_path="<dir>", task="text2music" | "repaint" | "extend", …)

Every ACE-Step specific lives in :class:`AceStepEngine` — ``load()`` and, above all, ``run()``
are the functions to adapt for other versions. (ACE-Step 1.5 ships a different Python API and its
own REST server; map the same four operations there: text2music, audio2audio with a reference
strength, repaint for inpainting, extend.)

Contract → ACE-Step mapping
---------------------------
* /generate → text2music. ``prompt`` + ``bpm`` + ``key`` become the comma-separated tag prompt;
  ``lyrics`` keep their ``[verse]``/``[chorus]`` structure tags (``[instrumental]`` when
  instrumental). A guide or reference WAV switches on audio2audio with
  ``ref_audio_strength = 1 − strength`` (Song Deck's strength = how far the output may depart).
  Not supported by ACE-Step v1 and therefore ignored: ``negative_prompt`` and explicit section
  timings (section names still reach the model through the lyric tags).
* /transform → audio2audio on the input (same strength mapping).
* /inpaint → task "repaint" (``repaint_start``/``repaint_end``); the bridge then splices the
  regenerated range into the ORIGINAL so nothing outside the range changes (``--no-splice`` to
  return ACE-Step's full re-render instead).
* /extend → task "extend" with ``repaint_end`` = source length + requested seconds (what the
  ACE-Step UI does); the original audio is kept and the continuation appended.

Cancellation: ACE-Step's pipeline call blocks; the bridge wraps the ``tqdm`` iterator that drives
its diffusion steps so a cancelled job (client disconnect / ``POST /cancel``) stops at the next
step. If your version does not use ``tqdm`` that way, a cancelled job finishes its generation and
the result is discarded.

Install and run
---------------
::

    git clone https://github.com/ace-step/ACE-Step && cd ACE-Step && pip install -e .
    python3 bridges/acestep_bridge.py --device cuda:0           # http://127.0.0.1:8810

In Song Deck: Settings → Providers → Add provider → Music generation → "ACE-Step (local)".

This is REFERENCE code (not exercised in Song Deck's CI).
"""
from __future__ import annotations

import os
import sys
import tempfile
import types
from pathlib import Path
from typing import Any, Dict, List, Optional

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__, dsp  # noqa: E402
from songdeck_bridge.cli import app_options, build_parser, check_bind, fail, module_available, serve, setup_logging  # noqa: E402
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    EngineError,
    ModelLoader,
    NotFound,
    RequestContext,
    json_response,
    req_bool,
    req_list,
    req_number,
    req_seed,
    req_str,
    wav_response,
)
from songdeck_bridge.wav import Audio, WavError, decode_base64, fit_length, read_wav, resample_audio, wav_info, write_wav  # noqa: E402

DEFAULT_PORT = 8810
CAPABILITIES = [
    "TEXT_TO_MUSIC", "AUDIO_TO_AUDIO", "LYRIC_CONDITIONING", "VOCAL_GENERATION", "INSTRUMENTAL_ONLY", "SECTION_GENERATION",
    "REFERENCE_AUDIO", "STEM_CONDITIONING", "INPAINTING", "OUTPAINTING", "REGION_GENERATION",
]


class AceStepEngine:
    """Everything ACE-Step specific. Adapt ``load()`` / ``run()`` for other ACE-Step versions."""

    def __init__(self, args: Any):
        self.args = args
        self.pipe: Any = None
        self._current: Optional[RequestContext] = None  # the job whose diffusion loop may be interrupted

    def load(self) -> "AceStepEngine":
        a = self.args
        if a.device == "cpu":
            os.environ["CUDA_VISIBLE_DEVICES"] = ""  # ACE-Step v1 picks CUDA whenever it is visible
        try:
            from acestep import pipeline_ace_step as module  # type: ignore
        except ImportError as e:
            raise RuntimeError(f"ACE-Step is not importable ({e}); install it from https://github.com/ace-step/ACE-Step (pip install -e .)") from e
        kwargs: Dict[str, Any] = {"dtype": a.dtype, "torch_compile": a.torch_compile, "cpu_offload": a.cpu_offload, "overlapped_decode": a.overlapped_decode}
        if a.checkpoint_dir:
            kwargs["checkpoint_dir"] = a.checkpoint_dir
        if a.device.startswith("cuda:"):
            kwargs["device_id"] = int(a.device.split(":", 1)[1])
        self.pipe = module.ACEStepPipeline(**kwargs)
        load_checkpoint = getattr(self.pipe, "load_checkpoint", None)
        if callable(load_checkpoint) and not getattr(self.pipe, "loaded", True):
            load_checkpoint(getattr(self.pipe, "checkpoint_dir", a.checkpoint_dir))  # weights now, not on the first request
        self._install_cancel_hook(module)
        return self

    def _install_cancel_hook(self, module: Any) -> None:
        """Best effort: wrap the module's ``tqdm`` so each diffusion step checks for cancellation."""
        orig = getattr(module, "tqdm", None)
        if orig is None or isinstance(orig, types.ModuleType) or not callable(orig) or getattr(orig, "_songdeck_wrapped", False):
            return
        engine = self

        class CancellableTqdm:
            _songdeck_wrapped = True

            def __init__(self, *a: Any, **kw: Any):
                self._bar = orig(*a, **kw)

            def __iter__(self):
                try:
                    for item in self._bar:
                        ctx = engine._current
                        if ctx is not None:
                            ctx.check_cancelled()  # raises JobCancelled → aborts the pipeline call
                        yield item
                finally:
                    close = getattr(self._bar, "close", None)
                    if callable(close):
                        close()

            def __getattr__(self, name: str) -> Any:
                return getattr(self._bar, name)

            def __enter__(self):
                self._bar.__enter__()
                return self

            def __exit__(self, *exc: Any) -> Any:
                return self._bar.__exit__(*exc)

        module.tqdm = CancellableTqdm

    def run(self, ctx: RequestContext, *, task: str, duration: float, prompt: str, lyrics: str, seed: int, out_dir: Path,
            src_audio: Optional[Path] = None, ref_audio: Optional[Path] = None, ref_strength: float = 0.5,
            repaint_start: float = 0.0, repaint_end: float = 0.0) -> Path:
        """THE engine call (ACE-Step v1 ``ACEStepPipeline.__call__``); returns the generated audio file.

        ``task``: "text2music", "audio2audio" (text2music + reference audio), "repaint", "extend".
        """
        a = self.args
        params: Dict[str, Any] = {
            "format": "wav",
            "audio_duration": float(duration),
            "prompt": prompt,
            "lyrics": lyrics,
            "infer_step": a.infer_steps,
            "guidance_scale": a.guidance_scale,
            "scheduler_type": a.scheduler,
            "cfg_type": a.cfg_type,
            "omega_scale": a.omega_scale,
            "manual_seeds": [int(seed) & 0xFFFFFFFF],
            "save_path": str(out_dir),  # a directory: ACE-Step writes output_<timestamp>_0.wav into it
        }
        if task == "audio2audio":
            params.update(task="text2music", audio2audio_enable=True, ref_audio_input=str(ref_audio), ref_audio_strength=float(ref_strength))
        elif task in ("repaint", "extend"):
            params.update(task=task, src_audio_path=str(src_audio), repaint_start=float(repaint_start), repaint_end=float(repaint_end),
                          retake_seeds=[int(seed) & 0xFFFFFFFF], retake_variance=a.retake_variance)
        else:
            params["task"] = "text2music"
        self._current = ctx
        try:
            outputs = self.pipe(**params)
        except TypeError as e:
            raise EngineError(f"ACE-Step rejected the call ({e}); adapt AceStepEngine.run() in bridges/acestep_bridge.py to your ACE-Step version") from None
        finally:
            self._current = None
        for p in outputs if isinstance(outputs, (list, tuple)) else [outputs]:
            if isinstance(p, (str, os.PathLike)) and str(p).lower().endswith(".wav") and os.path.isfile(p):
                return Path(p)
        wavs = sorted(Path(out_dir).rglob("*.wav"), key=lambda q: q.stat().st_mtime)
        if not wavs:
            raise EngineError("ACE-Step finished without writing a WAV file")
        return wavs[-1]


def tag_prompt(prompt: str, bpm: Optional[float], key: Optional[str]) -> str:
    """ACE-Step prompts are comma-separated tags: '<prompt>, 120 bpm, E minor'."""
    parts = [prompt.strip().rstrip(",")]
    if bpm:
        parts.append(f"{bpm:g} bpm")
    if key:
        parts.append(key.strip())
    return ", ".join(p for p in parts if p)


def splice_range(orig: Audio, gen: Audio, start: float, end: float, xfade_s: float = 0.02) -> Audio:
    """``orig`` with [start, end) replaced by the same range of ``gen`` (crossfades inside the range)."""
    sr = orig.sample_rate
    s = int(round(start * sr))
    e = min(orig.frames, int(round(end * sr)))
    region = gen.slice(int(round(start * gen.sample_rate)), int(round(end * gen.sample_rate)))
    if region.sample_rate != sr:
        region = resample_audio(region, sr)
    region = fit_length(region.with_channels(orig.num_channels), e - s)
    xf = min(int(xfade_s * sr), (e - s) // 4)
    w = dsp.crossfade_weights(xf)
    out = []
    for ch, rg in zip(orig.channels, region.channels):
        rg = list(rg)
        for i in range(xf):
            rg[i] = ch[s + i] * (1.0 - w[i]) + rg[i] * w[i]
            j = e - s - 1 - i
            rg[j] = ch[s + j] * (1.0 - w[i]) + rg[j] * w[i]
        out.append(ch[:s] + rg + ch[e:])
    return orig.like(out)


def splice_extension(orig: Audio, gen: Audio, seconds: float, xfade_s: float = 0.02) -> Audio:
    """``orig`` + the continuation of ``gen`` after the original's length (short crossfade at the seam)."""
    sr = orig.sample_rate
    n = orig.frames
    g = (gen if gen.sample_rate == sr else resample_audio(gen, sr)).with_channels(orig.num_channels)
    tail = fit_length(g.slice(n), int(round(seconds * sr)))
    xf = min(int(xfade_s * sr), n, g.frames)
    w = dsp.crossfade_weights(xf)
    out = []
    for ch, gch, tch in zip(orig.channels, g.channels, tail.channels):
        head = list(ch)
        for i in range(xf):
            j = n - xf + i
            head[j] = ch[j] * (1.0 - w[i]) + gch[j] * w[i]
        out.append(head + list(tch))
    return orig.like(out)


def _wav_field(body: Dict[str, Any], name: str, required: bool = True) -> Optional[bytes]:
    text = req_str(body, name, required=required)
    if text is None:
        return None
    try:
        data = decode_base64(text, name)
        wav_info(data)
    except WavError as e:
        raise BadRequest(f"{name}: {e}") from None
    return data


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("ACE-Step music bridge", role="music", **app_options(args))
    engine = AceStepEngine(args)
    loader = app.add_loader(ModelLoader("ACE-Step pipeline", engine.load, retry_after=30))
    model_id = args.model

    def resolve_model(body: Dict[str, Any]) -> str:
        m = req_str(body, "model", required=False)
        if m and m != model_id:
            raise NotFound(f"unknown model '{m}' (this bridge serves '{model_id}')")
        return model_id

    def output(ctx: RequestContext, path: Path, seed: int) -> Any:
        data = path.read_bytes()
        try:
            wav_info(data)
        except WavError as e:
            raise EngineError(f"ACE-Step output is not a readable WAV ({e})") from None
        ctx.check_cancelled()
        return wav_response(data, seed=seed, model=model_id)

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response({
            "name": app.name,
            "version": __version__,
            "models": [{"id": model_id, "name": args.model_name}],
            "capabilities": CAPABILITIES,
            "hardware": {"min_vram_gb": args.min_vram_gb},
            "max_duration_seconds": args.max_duration,
            "status": loader.state,
        })

    @app.job("POST", "/generate")
    def generate(ctx: RequestContext):
        body = ctx.json_object()
        prompt = req_str(body, "prompt")
        duration = req_number(body, "duration_seconds", exclusive_minimum=0, maximum=args.max_duration)
        seed, _ = req_seed(body)
        resolve_model(body)
        lyrics = req_str(body, "lyrics", required=False, default="") or ""
        instrumental = req_bool(body, "instrumental", default=False)
        bpm = req_number(body, "bpm", required=False, minimum=20, maximum=400)
        key = req_str(body, "key", required=False, max_len=64)
        req_list(body, "sections", required=False)  # timings cannot be enforced by ACE-Step v1 (see module docs)
        req_str(body, "negative_prompt", required=False)  # not supported by ACE-Step v1: accepted and ignored
        guide = _wav_field(body, "guide_audio_base64", required=False)
        reference = _wav_field(body, "reference_audio_base64", required=False)
        strength = req_number(body, "strength", required=False, default=0.5, minimum=0, maximum=1)
        pipe = loader.get()  # 503 while loading
        tags = tag_prompt(prompt, bpm, key)
        lyric_text = "[instrumental]" if instrumental or not lyrics.strip() else lyrics

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-acestep-") as tmp:
                ref_path = None
                if guide or reference:
                    ref_path = Path(tmp, "reference.wav")
                    ref_path.write_bytes(guide or reference)  # type: ignore[arg-type]
                path = pipe.run(ctx, task="audio2audio" if ref_path else "text2music", duration=duration, prompt=tags, lyrics=lyric_text,
                                seed=seed, out_dir=Path(tmp), ref_audio=ref_path, ref_strength=1.0 - strength)
                return output(ctx, path, seed)

        return work

    @app.job("POST", "/transform")
    def transform(ctx: RequestContext):
        body = ctx.json_object()
        audio = _wav_field(body, "audio_base64")
        prompt = req_str(body, "prompt")
        strength = req_number(body, "strength", minimum=0, maximum=1)
        seed, _ = req_seed(body)
        resolve_model(body)
        duration = wav_info(audio)["duration"]  # type: ignore[arg-type]
        if duration > args.max_duration:
            raise BadRequest(f"the audio is {duration:.0f} s long; ACE-Step renders at most {args.max_duration:.0f} s (--max-duration)")
        pipe = loader.get()

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-acestep-") as tmp:
                src = Path(tmp, "input.wav")
                src.write_bytes(audio)  # type: ignore[arg-type]
                path = pipe.run(ctx, task="audio2audio", duration=duration, prompt=prompt, lyrics=args.transform_lyrics, seed=seed,
                                out_dir=Path(tmp), ref_audio=src, ref_strength=1.0 - strength)
                return output(ctx, path, seed)

        return work

    @app.job("POST", "/inpaint")
    def inpaint(ctx: RequestContext):
        body = ctx.json_object()
        audio = _wav_field(body, "audio_base64")
        start = req_number(body, "start_seconds", minimum=0)
        end = req_number(body, "end_seconds", minimum=0)
        prompt = req_str(body, "prompt")
        seed, _ = req_seed(body)
        resolve_model(body)
        duration = wav_info(audio)["duration"]  # type: ignore[arg-type]
        if end <= start:
            raise BadRequest("'end_seconds' must be greater than 'start_seconds'")
        if start >= duration:
            raise BadRequest(f"'start_seconds' ({start}) is beyond the end of the audio ({duration:.3f} s)")
        end = min(end, duration)
        pipe = loader.get()

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-acestep-") as tmp:
                src = Path(tmp, "input.wav")
                src.write_bytes(audio)  # type: ignore[arg-type]
                path = pipe.run(ctx, task="repaint", duration=duration, prompt=prompt, lyrics=args.repaint_lyrics, seed=seed,
                                out_dir=Path(tmp), src_audio=src, repaint_start=start, repaint_end=end)
                if args.no_splice:
                    return output(ctx, path, seed)
                spliced = splice_range(read_wav(audio), read_wav(path.read_bytes()), start, end)  # type: ignore[arg-type]
            ctx.check_cancelled()
            return wav_response(write_wav(spliced), seed=seed, model=model_id)

        return work

    @app.job("POST", "/extend")
    def extend(ctx: RequestContext):
        body = ctx.json_object()
        audio = _wav_field(body, "audio_base64")
        prompt = req_str(body, "prompt")
        seconds = req_number(body, "duration_seconds", exclusive_minimum=0, maximum=args.max_duration)
        seed, _ = req_seed(body)
        resolve_model(body)
        duration = wav_info(audio)["duration"]  # type: ignore[arg-type]
        if duration + seconds > args.max_duration:
            raise BadRequest(f"the extended audio would be {duration + seconds:.0f} s; ACE-Step renders at most {args.max_duration:.0f} s (--max-duration)")
        pipe = loader.get()

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-acestep-") as tmp:
                src = Path(tmp, "input.wav")
                src.write_bytes(audio)  # type: ignore[arg-type]
                # Mirrors the ACE-Step UI: repaint_start = -left_extension (0), repaint_end = duration + right_extension.
                path = pipe.run(ctx, task="extend", duration=duration, prompt=prompt, lyrics=args.repaint_lyrics, seed=seed,
                                out_dir=Path(tmp), src_audio=src, repaint_start=0.0, repaint_end=duration + seconds)
                if args.no_splice:
                    return output(ctx, path, seed)
                extended = splice_extension(read_wav(audio), read_wav(path.read_bytes()), seconds)  # type: ignore[arg-type]
            ctx.check_cancelled()
            return wav_response(write_wav(extended), seed=seed, model=model_id)

        return work

    return app


def main(argv: Optional[List[str]] = None) -> int:
    p = build_parser("Song Deck music bridge for ACE-Step (reference implementation).", DEFAULT_PORT, prog="acestep_bridge.py")
    p.set_defaults(model="ace-step-v1-3.5b")
    a = p.add_argument_group("ACE-Step")
    a.add_argument("--model-name", default="ACE-Step v1 3.5B", help="display name reported in /info")
    a.add_argument("--checkpoint-dir", default=None, help="ACE-Step checkpoint folder (default: ACE-Step downloads to its cache)")
    a.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"], help="model precision (default bfloat16)")
    a.add_argument("--cpu-offload", action="store_true", help="offload idle sub-models to the CPU (less VRAM, slower)")
    a.add_argument("--torch-compile", action="store_true", help="torch.compile the model (faster after warm-up)")
    a.add_argument("--overlapped-decode", action="store_true", help="decode long audio in overlapping windows (less VRAM)")
    a.add_argument("--infer-steps", type=int, default=60, help="diffusion steps (default 60; 27 is a fast preview)")
    a.add_argument("--guidance-scale", type=float, default=15.0)
    a.add_argument("--scheduler", default="euler", help="scheduler_type (euler | heun | pingpong, depending on version)")
    a.add_argument("--cfg-type", default="apg", help="cfg_type (apg | cfg | cfg_star)")
    a.add_argument("--omega-scale", type=float, default=10.0)
    a.add_argument("--retake-variance", type=float, default=1.0, help="variance for repaint/extend (default 1.0)")
    a.add_argument("--transform-lyrics", default="[instrumental]", help="lyrics passed with /transform (default [instrumental])")
    a.add_argument("--repaint-lyrics", default="[instrumental]", help="lyrics passed with /inpaint and /extend (default [instrumental])")
    a.add_argument("--no-splice", action="store_true", help="return ACE-Step's full re-render for /inpaint and /extend")
    a.add_argument("--max-duration", type=float, default=240.0, help="longest audio in seconds (ACE-Step v1: 240)")
    a.add_argument("--min-vram-gb", type=float, default=8.0, help="VRAM requirement reported in /info (default 8)")
    a.add_argument("--skip-check", action="store_true", help="do not check at startup that ACE-Step is importable")
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    if args.max_jobs != 1:
        print("warning: ACE-Step's pipeline is not thread-safe; forcing --max-jobs 1", file=sys.stderr)
        args.max_jobs = 1
    if not args.skip_check and not module_available("acestep"):
        fail("ACE-Step is not installed for this Python. Install it from a checkout:\n"
             "  git clone https://github.com/ace-step/ACE-Step && cd ACE-Step && pip install -e .")
    app = build_app(args)
    app.loaders[0].start()  # load in the background; job routes answer 503 until ready
    return serve([(app, args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
