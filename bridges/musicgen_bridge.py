#!/usr/bin/env python3
"""
Song Deck MUSIC bridge for Meta's MusicGen (Hugging Face ``transformers``) — reference implementation.

Contract (packages/ai/src/contracts.ts, MUSIC_BRIDGE_PATHS)::

    GET  /info        → {name, version, models, capabilities, hardware}
    POST /generate    {prompt, duration_seconds, seed?, bpm?, key?, guide_audio_base64?,
                       reference_audio_base64?, model?, …}                         → audio/wav
    POST /transform   {audio_base64, prompt, strength, seed?, model?}              → audio/wav (melody models)
    POST /extend      {audio_base64, prompt, duration_seconds, seed?, model?}      → audio/wav (other models)
    POST /inpaint     → 501 (MusicGen cannot regenerate a range)
    POST /cancel · GET /health

Models (``--model``; one per bridge process)::

    facebook/musicgen-small | -medium | -large                 text → music (mono, 32 kHz)
    facebook/musicgen-stereo-small | -medium | -large          the same in stereo
    facebook/musicgen-melody | -melody-large                   text + a melody (chroma of guide/reference audio)
    facebook/musicgen-stereo-melody | -stereo-melody-large

MusicGen is instrumental only: ``lyrics`` are accepted and ignored (``X-Lyrics-Ignored: true``),
and so are ``sections`` and ``negative_prompt``. ``bpm`` and ``key`` are appended to the prompt.

* Text models generate windows of ``--window-seconds`` (30 s, MusicGen's training length); longer
  requests continue the music window by window, each time with the last ``--context-seconds`` as
  the audio prompt (``--max-duration`` caps the total). ``/extend`` continues the input the same
  way and returns input + continuation.
* Melody models condition on the chromagram of ``guide_audio_base64`` (else
  ``reference_audio_base64``) and generate at most one window; ``/transform`` re-renders the
  input's melody with the prompt (``strength`` has no MusicGen equivalent and is ignored).

Cancellation stops at the next generated token (a ``StoppingCriteria`` checks the job).

Install and run::

    pip install torch transformers          # CUDA build of torch for a GPU
    python3 bridges/musicgen_bridge.py --model facebook/musicgen-medium --device cuda   # :8824

In Song Deck: Settings → Providers → Add provider, preset ``musicgen-local``.

This is REFERENCE code (not exercised in Song Deck's CI): ``MusicGenEngine.load()`` and
``MusicGenEngine.generate()`` hold every transformers call.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional, Sequence

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__  # noqa: E402
from songdeck_bridge.cli import (  # noqa: E402
    app_options,
    build_parser,
    check_bind,
    module_available,
    resolve_device,
    serve,
    setup_logging,
)
from songdeck_bridge.music import resolve_model, style_prompt, wav_field  # noqa: E402
from songdeck_bridge.npaudio import fit_np, numpy_to_wav, resample_np, to_channels_np, wav_to_numpy  # noqa: E402
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    ModelLoader,
    NotSupported,
    RequestContext,
    json_response,
    req_bool,
    req_list,
    req_number,
    req_seed,
    req_str,
    wav_response,
)
from songdeck_bridge.wav import wav_info  # noqa: E402

DEFAULT_PORT = 8824
DEFAULT_MODEL = "facebook/musicgen-medium"
INSTALL_HINT = "pip install torch transformers   (install the CUDA build of torch first for a GPU)"


def is_melody(model_id: str) -> bool:
    return "melody" in model_id.lower()


def capabilities(model_id: str) -> List[str]:
    caps = ["TEXT_TO_MUSIC", "INSTRUMENTAL_ONLY"]
    return caps + (["REFERENCE_AUDIO", "AUDIO_TO_AUDIO"] if is_melody(model_id) else ["OUTPAINTING"])


class MusicGenEngine:
    """Everything transformers specific. Adapt ``load()`` / ``generate()`` for other versions."""

    def __init__(self, args: Any):
        self.args = args
        self.torch: Any = None
        self.np: Any = None
        self.model: Any = None
        self.processor: Any = None
        self.device = "cpu"
        self.sample_rate = 32000
        self.frame_rate = 50
        self.channels = 1

    def load(self) -> "MusicGenEngine":
        try:
            import numpy as np  # type: ignore
            import torch  # type: ignore
            import transformers  # type: ignore
        except ImportError as e:
            raise RuntimeError(f"transformers/torch are not importable ({e}); {INSTALL_HINT}") from e
        a = self.args
        self.torch, self.np = torch, np
        self.device = resolve_device(a.device)
        cls_name = (
            "MusicgenMelodyForConditionalGeneration" if is_melody(a.model) else "MusicgenForConditionalGeneration"
        )
        cls = getattr(transformers, cls_name, None)
        if cls is None:
            raise RuntimeError(f"this transformers version has no {cls_name}; pip install -U transformers")
        dtype = {"float32": torch.float32, "float16": torch.float16, "bfloat16": torch.bfloat16}[a.dtype]
        if self.device == "cpu":
            dtype = torch.float32
        self.processor = transformers.AutoProcessor.from_pretrained(a.model, cache_dir=a.cache_dir)
        self.model = cls.from_pretrained(a.model, torch_dtype=dtype, cache_dir=a.cache_dir).to(self.device)
        self.model.eval()
        enc = self.model.config.audio_encoder
        self.sample_rate = int(getattr(enc, "sampling_rate", 32000))
        self.frame_rate = int(getattr(enc, "frame_rate", 50) or 50)
        self.channels = int(getattr(self.model.config.decoder, "audio_channels", 1) or 1)
        return self

    def _stopper(self, ctx: RequestContext) -> Any:
        import transformers  # type: ignore

        class Cancel(transformers.StoppingCriteria):
            def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> Any:
                return ctx.cancelled  # True ends generation; the job then raises JobCancelled

        return transformers.StoppingCriteriaList([Cancel()])

    def generate(
        self,
        ctx: RequestContext,
        prompt: str,
        seconds: float,
        seed: int,
        *,
        audio_prompt: Optional[Any] = None,
        melody: Optional[Any] = None,
    ) -> Any:
        """THE engine call: ``seconds`` of NEW audio, (channels, frames) at ``self.sample_rate``.

        ``audio_prompt`` (channels, frames) at the model rate → continuation; ``melody`` → chroma conditioning.
        """
        torch, np = self.torch, self.np
        torch.manual_seed(int(seed) & 0xFFFFFFFF)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(int(seed) & 0xFFFFFFFF)
        kwargs: Dict[str, Any] = {"text": [prompt], "padding": True, "return_tensors": "pt"}
        if melody is not None:
            kwargs.update(audio=[np.asarray(melody, dtype=np.float32).mean(axis=0)], sampling_rate=self.sample_rate)
        elif audio_prompt is not None:
            ap = to_channels_np(audio_prompt, self.channels, np)
            kwargs.update(audio=[ap[0] if self.channels == 1 else ap], sampling_rate=self.sample_rate)
        inputs = self.processor(**kwargs).to(self.device)
        new_tokens = max(1, int(round(seconds * self.frame_rate)))
        with torch.no_grad():
            out = self.model.generate(
                **inputs,
                do_sample=True,
                guidance_scale=self.args.guidance_scale,
                max_new_tokens=new_tokens,
                temperature=self.args.temperature,
                top_k=self.args.top_k,
                stopping_criteria=self._stopper(ctx),
            )
        ctx.check_cancelled()
        audio = out[0].float().cpu().numpy()  # (channels, samples)
        audio = audio[None, :] if audio.ndim == 1 else audio
        want = int(round(seconds * self.sample_rate))
        if audio_prompt is not None:
            prompt_frames = audio_prompt.shape[-1]
            if audio.shape[-1] >= prompt_frames + want // 2:  # the decoded output includes the prompt
                audio = audio[:, prompt_frames:]
        return fit_np(audio, want, np)

    def generate_long(
        self, ctx: RequestContext, prompt: str, seconds: float, seed: int, start: Optional[Any] = None
    ) -> Any:
        """Windowed generation: continue from the last ``--context-seconds`` until ``seconds`` of new audio exist."""
        np, a = self.np, self.args
        window, context = a.window_seconds, min(a.context_seconds, a.window_seconds / 2)
        made: List[Any] = []
        have = 0.0
        history = start
        step = 0
        while have < seconds - 1e-6:
            ctx.check_cancelled()
            if history is None:
                n = min(window, seconds - have)
                chunk = self.generate(ctx, prompt, n, seed + step)
            else:
                ctx_frames = min(history.shape[-1], int(context * self.sample_rate))
                n = min(window - ctx_frames / self.sample_rate, seconds - have)
                chunk = self.generate(ctx, prompt, n, seed + step, audio_prompt=history[:, -ctx_frames:])
            made.append(chunk)
            history = chunk if history is None else np.concatenate([history, chunk], axis=1)
            have += chunk.shape[-1] / self.sample_rate
            step += 1
        return np.concatenate(made, axis=1)[:, : int(round(seconds * self.sample_rate))]


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("MusicGen music bridge", role="music", **app_options(args))
    engine = MusicGenEngine(args)
    loader = app.add_loader(ModelLoader(args.model, engine.load, retry_after=30))
    melody_model = is_melody(args.model)
    models = [args.model]

    def to_model_rate(data: bytes) -> Any:
        x, sr = wav_to_numpy(data, engine.np)
        return to_channels_np(resample_np(x, sr, engine.sample_rate, engine.np), engine.channels, engine.np)

    def respond(audio: Any, seed: int, headers: Optional[Dict[str, str]] = None) -> Any:
        peak = float(abs(audio).max()) if audio.size else 0.0
        if peak > 0.999:
            audio = audio * (0.999 / peak)
        return wav_response(
            numpy_to_wav(audio, engine.sample_rate, engine.np), seed=seed, model=args.model, headers=headers
        )

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        body: Dict[str, Any] = {
            "name": app.name,
            "version": __version__,
            "models": [{"id": args.model, "name": args.model.split("/")[-1]}],
            "capabilities": capabilities(args.model),
            "hardware": {"min_vram_gb": args.min_vram_gb},
            "max_duration_seconds": args.window_seconds if melody_model else args.max_duration,
            "sample_rate": engine.sample_rate,
            "status": loader.state,
        }
        if loader.state == "failed":
            body.update(error=loader.error, install=INSTALL_HINT)
        return json_response(body)

    @app.job("POST", "/generate")
    def generate(ctx: RequestContext):
        body = ctx.json_object()
        prompt = req_str(body, "prompt")
        limit = args.window_seconds if melody_model else args.max_duration
        duration = req_number(body, "duration_seconds", exclusive_minimum=0)
        if duration > limit:
            raise BadRequest(
                f"'duration_seconds' is {duration:g}; {args.model} generates at most {limit:g} s per request"
                + (" (melody models cannot continue windows)" if melody_model else " (--max-duration)")
            )
        seed, _ = req_seed(body)
        resolve_model(body, models, args.model)
        bpm = req_number(body, "bpm", required=False, minimum=20, maximum=400)
        key = req_str(body, "key", required=False, max_len=64)
        lyrics = req_str(body, "lyrics", required=False, default="") or ""
        instrumental = req_bool(body, "instrumental", default=False)
        req_list(body, "sections", required=False)
        req_str(body, "negative_prompt", required=False)
        req_number(body, "strength", required=False, minimum=0, maximum=1)
        guide = wav_field(body, "guide_audio_base64", required=False)
        reference = wav_field(body, "reference_audio_base64", required=False)
        eng = loader.get()
        text = style_prompt(prompt, bpm, key)
        headers = {"X-Lyrics-Ignored": "true"} if lyrics.strip() and not instrumental else {}

        def work():
            melody_src = guide or reference
            if melody_model and melody_src is not None:
                audio = eng.generate(ctx, text, duration, seed, melody=to_model_rate(melody_src))
            else:
                if melody_src is not None:
                    headers["X-Reference-Ignored"] = "true"  # only melody models use audio conditioning
                audio = eng.generate_long(ctx, text, duration, seed)
            return respond(audio, seed, headers)

        return work

    @app.job("POST", "/transform")
    def transform(ctx: RequestContext):
        if not melody_model:
            raise NotSupported(f"{args.model} has no audio conditioning; run a musicgen-melody model for /transform")
        body = ctx.json_object()
        data = wav_field(body, "audio_base64")
        prompt = req_str(body, "prompt")
        req_number(body, "strength", minimum=0, maximum=1)  # no MusicGen equivalent (see module docs)
        seed, _ = req_seed(body)
        resolve_model(body, models, args.model)
        seconds = wav_info(data)["duration"]
        if seconds > args.window_seconds:
            raise BadRequest(f"the audio is {seconds:.0f} s; melody models render at most {args.window_seconds:g} s")
        eng = loader.get()

        def work():
            return respond(eng.generate(ctx, prompt, seconds, seed, melody=to_model_rate(data)), seed)

        return work

    @app.job("POST", "/extend")
    def extend(ctx: RequestContext):
        if melody_model:
            raise NotSupported(f"{args.model} cannot continue audio; run a text model (e.g. facebook/musicgen-medium)")
        body = ctx.json_object()
        data = wav_field(body, "audio_base64")
        prompt = req_str(body, "prompt")
        seconds = req_number(body, "duration_seconds", exclusive_minimum=0, maximum=args.max_duration)
        seed, _ = req_seed(body)
        resolve_model(body, models, args.model)
        if wav_info(data)["duration"] > args.max_input_seconds:
            raise BadRequest(f"the audio is longer than {args.max_input_seconds:g} s (--max-input-seconds)")
        eng = loader.get()

        def work():
            original = to_model_rate(data)
            tail = eng.generate_long(ctx, prompt, seconds, seed, start=original)
            return respond(eng.np.concatenate([original, tail], axis=1), seed)

        return work

    @app.job("POST", "/inpaint")
    def inpaint(ctx: RequestContext):
        raise NotSupported("MusicGen cannot regenerate a time range (no INPAINTING); use /extend or another model")

    return app


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser(
        "Song Deck music bridge for MusicGen (reference implementation).", DEFAULT_PORT, prog="musicgen_bridge.py"
    )
    p.set_defaults(model=DEFAULT_MODEL)
    m = p.add_argument_group("MusicGen")
    m.add_argument(
        "--dtype",
        choices=["float32", "float16", "bfloat16"],
        default="float16",
        help="GPU precision (CPU uses float32)",
    )
    m.add_argument("--guidance-scale", type=float, default=3.0, help="classifier-free guidance (default 3)")
    m.add_argument("--temperature", type=float, default=1.0)
    m.add_argument("--top-k", type=int, default=250)
    m.add_argument("--window-seconds", type=float, default=30.0, help="longest single generation (default 30)")
    m.add_argument(
        "--context-seconds", type=float, default=10.0, help="audio prompt carried into each next window (default 10)"
    )
    m.add_argument(
        "--max-duration", type=float, default=120.0, help="longest text-model generation via windows (default 120)"
    )
    m.add_argument("--max-input-seconds", type=float, default=600.0, help="longest /extend input (default 600)")
    m.add_argument("--cache-dir", default=None, help="Hugging Face cache folder")
    m.add_argument("--min-vram-gb", type=float, default=8.0, help="VRAM requirement reported in /info (default 8)")
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    args.max_jobs = 1
    if not (module_available("transformers") and module_available("torch")):
        print(
            f"warning: transformers/torch are not installed ({INSTALL_HINT}); /info and /health report it",
            file=sys.stderr,
        )
    app = build_app(args)
    app.loaders[0].start()
    return serve([(app, args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
