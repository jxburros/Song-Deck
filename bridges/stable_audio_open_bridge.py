#!/usr/bin/env python3
"""
Song Deck MUSIC bridge for Stable Audio Open (``diffusers`` ``StableAudioPipeline``) — reference
implementation.

Contract (packages/ai/src/contracts.ts, MUSIC_BRIDGE_PATHS)::

    GET  /info        → {name, version, models, capabilities, hardware}
    POST /generate    {prompt, duration_seconds, seed?, negative_prompt?, bpm?, key?,
                       reference_audio_base64?, guide_audio_base64?, model?, …}     → audio/wav
    POST /transform   {audio_base64, prompt, strength, seed?, model?}              → audio/wav (if supported)
    POST /inpaint · POST /extend → 501
    POST /cancel · GET /health

Engine::

    from diffusers import StableAudioPipeline
    pipe = StableAudioPipeline.from_pretrained("stabilityai/stable-audio-open-1.0", torch_dtype=torch.float16).to("cuda")
    audio = pipe(prompt, negative_prompt=…, num_inference_steps=200, guidance_scale=7.0,
                 audio_end_in_s=seconds, generator=torch.Generator("cuda").manual_seed(seed)).audios[0]

Stable Audio Open 1.0 renders at most ~47 s (``--max-duration``) of 44.1 kHz stereo; it is gated
on Hugging Face (accept the license and ``huggingface-cli login`` once). ``bpm``/``key`` are added
to the prompt; ``lyrics``/``sections`` are accepted and ignored (instrumental only).

Audio to audio: diffusers' pipeline accepts ``initial_audio_waveforms`` in recent versions (the
input is encoded and added to the starting noise). The bridge checks the installed signature and
only then advertises ``AUDIO_TO_AUDIO``/``REFERENCE_AUDIO`` and serves ``/transform``. diffusers
has no strength control for it, so ``strength`` is accepted and ignored; the influence of the
input is modest.

Cancellation stops at the next diffusion step (the pipeline callback raises).

Install and run::

    pip install torch diffusers transformers accelerate torchsde soundfile
    huggingface-cli login                    # Stable Audio Open is a gated model
    python3 bridges/stable_audio_open_bridge.py --device cuda      # :8823

In Song Deck: Settings → Providers → Add provider, preset ``stable-audio-open-local``.

This is REFERENCE code (not exercised in Song Deck's CI): ``StableAudioEngine.load()`` and
``StableAudioEngine.generate()`` hold every diffusers call.
"""

from __future__ import annotations

import inspect
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

DEFAULT_PORT = 8823
DEFAULT_MODEL = "stabilityai/stable-audio-open-1.0"
INSTALL_HINT = "pip install torch diffusers transformers accelerate torchsde soundfile  (then: huggingface-cli login)"


def diffusers_supports_initial_audio() -> bool:
    """True when the installed StableAudioPipeline accepts ``initial_audio_waveforms`` (no model load)."""
    try:
        from diffusers import StableAudioPipeline  # type: ignore
    except Exception:  # noqa: BLE001 - not installed / broken install
        return False
    try:
        return "initial_audio_waveforms" in inspect.signature(StableAudioPipeline.__call__).parameters
    except (TypeError, ValueError):
        return False


class StableAudioEngine:
    """Everything diffusers specific. Adapt ``load()`` / ``generate()`` for other versions."""

    def __init__(self, args: Any):
        self.args = args
        self.torch: Any = None
        self.np: Any = None
        self.pipe: Any = None
        self.device = "cpu"
        self.sample_rate = 44100
        self.channels = 2
        self.audio_to_audio = False
        self._callback_style = "none"

    def load(self) -> "StableAudioEngine":
        try:
            import numpy as np  # type: ignore
            import torch  # type: ignore
            from diffusers import StableAudioPipeline  # type: ignore
        except ImportError as e:
            raise RuntimeError(f"diffusers/torch are not importable ({e}); {INSTALL_HINT}") from e
        a = self.args
        self.torch, self.np = torch, np
        self.device = resolve_device(a.device)
        dtype = torch.float16 if self.device.startswith("cuda") and a.dtype == "float16" else torch.float32
        self.pipe = StableAudioPipeline.from_pretrained(a.model, torch_dtype=dtype, cache_dir=a.cache_dir).to(
            self.device
        )
        self.sample_rate = int(getattr(self.pipe.vae, "sampling_rate", 44100) or 44100)
        self.channels = int(getattr(getattr(self.pipe.vae, "config", None), "audio_channels", 2) or 2)
        params = inspect.signature(self.pipe.__call__).parameters
        self.audio_to_audio = "initial_audio_waveforms" in params and not a.no_audio_to_audio
        if "callback_on_step_end" in params:
            self._callback_style = "on_step_end"
        elif "callback" in params:
            self._callback_style = "callback"
        return self

    def generate(
        self,
        ctx: RequestContext,
        prompt: str,
        negative: Optional[str],
        seconds: float,
        seed: int,
        initial: Optional[Any] = None,
    ) -> Any:
        """THE engine call → (channels, frames) float32 at ``self.sample_rate``.

        ``initial`` (channels, frames) at the model rate is passed as ``initial_audio_waveforms``.
        """
        torch, a = self.torch, self.args
        gen_device = "cuda" if self.device.startswith("cuda") else "cpu"
        generator = torch.Generator(gen_device).manual_seed(int(seed) & 0xFFFFFFFF)
        kwargs: Dict[str, Any] = {
            "prompt": prompt,
            "negative_prompt": negative or None,
            "num_inference_steps": a.steps,
            "guidance_scale": a.cfg_scale,
            "audio_start_in_s": 0.0,
            "audio_end_in_s": float(seconds),
            "num_waveforms_per_prompt": 1,
            "generator": generator,
        }
        if self._callback_style == "on_step_end":

            def on_step_end(pipe: Any, step: int, timestep: Any, cb_kwargs: Dict[str, Any]) -> Dict[str, Any]:
                ctx.check_cancelled()  # raises JobCancelled → aborts the pipeline call
                return cb_kwargs

            kwargs["callback_on_step_end"] = on_step_end
        elif self._callback_style == "callback":
            kwargs.update(callback=lambda step, t, latents: ctx.check_cancelled(), callback_steps=1)
        if initial is not None:
            wave = torch.from_numpy(to_channels_np(initial, self.channels, self.np)).unsqueeze(0)
            kwargs.update(
                initial_audio_waveforms=wave.to(self.device, dtype=self.pipe.vae.dtype),
                initial_audio_sampling_rate=self.sample_rate,
            )
        with torch.no_grad():
            audios = self.pipe(**kwargs).audios
        ctx.check_cancelled()
        audio = audios[0].float().cpu().numpy()  # (channels, samples)
        return fit_np(audio, int(round(seconds * self.sample_rate)), self.np, fade=int(0.02 * self.sample_rate))


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("Stable Audio Open music bridge", role="music", **app_options(args))
    engine = StableAudioEngine(args)
    loader = app.add_loader(ModelLoader(args.model, engine.load, retry_after=30))
    models = [args.model]
    hint: Dict[str, bool] = {}

    def audio_to_audio() -> bool:
        if loader.state == "ready":
            return engine.audio_to_audio
        if "a2a" not in hint:  # signature check without loading the model (imports diffusers once)
            hint["a2a"] = diffusers_supports_initial_audio() and not args.no_audio_to_audio
        return hint["a2a"]

    def caps() -> List[str]:
        out = ["TEXT_TO_MUSIC", "INSTRUMENTAL_ONLY"]
        return out + (["AUDIO_TO_AUDIO", "REFERENCE_AUDIO"] if audio_to_audio() else [])

    def to_model_rate(data: bytes) -> Any:
        x, sr = wav_to_numpy(data, engine.np)
        return resample_np(x, sr, engine.sample_rate, engine.np)

    def respond(audio: Any, seed: int, headers: Optional[Dict[str, str]] = None) -> Any:
        return wav_response(
            numpy_to_wav(audio, engine.sample_rate, engine.np), seed=seed, model=args.model, headers=headers
        )

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        body: Dict[str, Any] = {
            "name": app.name,
            "version": __version__,
            "models": [{"id": args.model, "name": "Stable Audio Open " + args.model.split("-")[-1]}],
            "capabilities": caps(),
            "hardware": {"min_vram_gb": args.min_vram_gb},
            "max_duration_seconds": args.max_duration,
            "status": loader.state,
        }
        if loader.state == "failed":
            body.update(error=loader.error, install=INSTALL_HINT)
        return json_response(body)

    @app.job("POST", "/generate")
    def generate(ctx: RequestContext):
        body = ctx.json_object()
        prompt = req_str(body, "prompt")
        duration = req_number(body, "duration_seconds", exclusive_minimum=0)
        if duration > args.max_duration:
            raise BadRequest(
                f"'duration_seconds' is {duration:g}; Stable Audio Open renders at most {args.max_duration:g} s"
            )
        seed, _ = req_seed(body)
        resolve_model(body, models, args.model)
        negative = req_str(body, "negative_prompt", required=False, max_len=4000) or args.negative_prompt
        bpm = req_number(body, "bpm", required=False, minimum=20, maximum=400)
        key = req_str(body, "key", required=False, max_len=64)
        req_str(body, "lyrics", required=False)
        req_bool(body, "instrumental", default=False)
        req_list(body, "sections", required=False)
        req_number(body, "strength", required=False, minimum=0, maximum=1)
        guide = wav_field(body, "guide_audio_base64", required=False)
        reference = wav_field(body, "reference_audio_base64", required=False)
        eng = loader.get()
        text = style_prompt(prompt, bpm, key)

        def work():
            src = guide or reference
            initial = to_model_rate(src) if src is not None and eng.audio_to_audio else None
            headers = {"X-Reference-Ignored": "true"} if src is not None and initial is None else None
            return respond(eng.generate(ctx, text, negative, duration, seed, initial), seed, headers)

        return work

    @app.job("POST", "/transform")
    def transform(ctx: RequestContext):
        body = ctx.json_object()
        data = wav_field(body, "audio_base64")
        prompt = req_str(body, "prompt")
        req_number(body, "strength", minimum=0, maximum=1)  # no diffusers equivalent (see module docs)
        seed, _ = req_seed(body)
        resolve_model(body, models, args.model)
        seconds = wav_info(data)["duration"]
        if seconds > args.max_duration:
            raise BadRequest(f"the audio is {seconds:.0f} s; Stable Audio Open renders at most {args.max_duration:g} s")
        eng = loader.get()
        if not eng.audio_to_audio:
            raise NotSupported(
                "the installed diffusers StableAudioPipeline has no initial_audio_waveforms (upgrade diffusers)"
            )

        def work():
            return respond(eng.generate(ctx, prompt, args.negative_prompt, seconds, seed, to_model_rate(data)), seed)

        return work

    @app.job("POST", "/inpaint")
    def inpaint(ctx: RequestContext):
        raise NotSupported("Stable Audio Open cannot regenerate a time range in this bridge (no INPAINTING)")

    @app.job("POST", "/extend")
    def extend(ctx: RequestContext):
        raise NotSupported("Stable Audio Open cannot continue audio in this bridge (no OUTPAINTING)")

    return app


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser(
        "Song Deck music bridge for Stable Audio Open (reference implementation).",
        DEFAULT_PORT,
        prog="stable_audio_open_bridge.py",
    )
    p.set_defaults(model=DEFAULT_MODEL)
    s = p.add_argument_group("Stable Audio Open")
    s.add_argument(
        "--steps", type=int, default=100, help="diffusion steps (default 100; 200 = the model card's quality)"
    )
    s.add_argument("--cfg-scale", type=float, default=7.0, help="guidance scale (default 7)")
    s.add_argument(
        "--negative-prompt", default="Low quality.", help="used when a request has none (default 'Low quality.')"
    )
    s.add_argument(
        "--dtype", choices=["float16", "float32"], default="float16", help="GPU precision (CPU uses float32)"
    )
    s.add_argument(
        "--max-duration", type=float, default=47.0, help="longest render in seconds (Stable Audio Open 1.0: ~47)"
    )
    s.add_argument("--no-audio-to-audio", action="store_true", help="never advertise or use initial audio")
    s.add_argument("--cache-dir", default=None, help="Hugging Face cache folder")
    s.add_argument("--min-vram-gb", type=float, default=8.0, help="VRAM requirement reported in /info (default 8)")
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    args.max_jobs = 1
    if not (module_available("diffusers") and module_available("torch")):
        print(
            f"warning: diffusers/torch are not installed ({INSTALL_HINT}); /info and /health report it", file=sys.stderr
        )
    app = build_app(args)
    app.loaders[0].start()
    return serve([(app, args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
