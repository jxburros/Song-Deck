#!/usr/bin/env python3
"""
Song Deck LYRICS TRANSCRIPTION bridge for Whisper (faster-whisper, openai-whisper, WhisperX) —
reference implementation.

Contract (packages/ai/src/contracts.ts, LYRICS_BRIDGE_PATHS)::

    POST /transcribe_lyrics  {"audio_base64": "<wav>", "language"?: "en", "prompt"?: "expected lyrics",
                              "word_timestamps"?: true, "model"?: "<id from /info>"}
                          →  {"text", "language", "segments": [{"start", "end", "text",
                                "words": [{"word", "start", "end", "confidence"}]}], "model"}
    GET  /info  → {name, version, models, capabilities: ["LYRIC_TRANSCRIPTION"], …}
    GET  /health · POST /cancel

Engines (``--engine auto`` picks the first one installed)::

    faster-whisper   pip install faster-whisper      CTranslate2; fastest on CPU and GPU (preferred)
    whisper          pip install openai-whisper      the reference implementation (PyTorch)
    whisperx         pip install whisperx            faster-whisper + wav2vec2 forced alignment

``--align`` runs WhisperX's forced alignment after faster-whisper/whisper (better word timings on
sung vocals; needs whisperx). ``--vad`` skips silence first (faster-whisper/WhisperX VAD), which
reduces hallucinated words in instrumental passages. ``prompt`` becomes Whisper's
``initial_prompt``, which biases recognition toward the expected words; ``language`` skips
detection. Word ``confidence`` is Whisper's word probability (WhisperX: its alignment score).
Singing is harder than speech: isolating the vocals first (the Demucs bridge with
``stems: ["vocals"]``) helps a lot, and Song Deck may do that before calling this bridge.

The model loads in the background (``/transcribe_lyrics`` answers 503 until it is ready). Audio is
decoded with NumPy (mono, resampled to 16 kHz) and handed to the engine as an array, so no ffmpeg
is needed. Cancellation stops between segments (faster-whisper decodes lazily, segment by
segment); openai-whisper and WhisperX finish their call and the result is discarded.

Install and run::

    pip install faster-whisper                 # or: pip install openai-whisper / whisperx
    python3 bridges/whisper_bridge.py [--model large-v3-turbo] [--device cuda] [--vad] [--align]

In Song Deck: Settings → Providers → Add provider, preset ``whisper-local``.

This is REFERENCE code (not exercised in Song Deck's CI): ``WhisperEngine.load()`` and
``WhisperEngine.transcribe()`` are the functions to adapt to other engine versions.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional, Sequence

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__  # noqa: E402
from songdeck_bridge.cli import (
    app_options,
    build_parser,
    check_bind,
    module_available,
    resolve_device,
    serve,
    setup_logging,
)  # noqa: E402
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    EngineError,
    ModelLoader,
    NotFound,
    RequestContext,
    json_response,
    req_bool,
    req_str,
)
from songdeck_bridge.npaudio import resample_np, wav_to_numpy  # noqa: E402
from songdeck_bridge.wav import WavError, decode_base64, wav_layout  # noqa: E402

DEFAULT_PORT = 8816
DEFAULT_MODEL = "large-v3-turbo"
ENGINES = {"faster-whisper": "faster_whisper", "whisper": "whisper", "whisperx": "whisperx"}
INSTALL_HINT = "install an engine: pip install faster-whisper   (or: pip install openai-whisper | pip install whisperx)"
SAMPLE_RATE = 16000


def pick_engine(choice: str) -> Optional[str]:
    if choice != "auto":
        return choice if module_available(ENGINES[choice]) else None
    for name, module in ENGINES.items():
        if module_available(module):
            return name
    return None


# ---------------------------------------------------------------------------
# Audio: WAV → mono float32 at 16 kHz (NumPy; Whisper's input format)
# ---------------------------------------------------------------------------


def wav_to_16k_mono(data: bytes, np: Any) -> Any:
    x, rate = wav_to_numpy(data, np)
    return resample_np(x.mean(axis=0), rate, SAMPLE_RATE, np)


# ---------------------------------------------------------------------------
# The engines — ADAPT HERE for other versions
# ---------------------------------------------------------------------------


def _word(text: Any, start: Any, end: Any, conf: Any) -> Optional[Dict[str, Any]]:
    w = str(text or "").strip()
    if not w or start is None or end is None:
        return None
    out: Dict[str, Any] = {"word": w, "start": round(float(start), 3), "end": round(max(float(start), float(end)), 3)}
    if conf is not None:
        out["confidence"] = round(max(0.0, min(1.0, float(conf))), 3)
    return out


class WhisperEngine:
    """Everything engine specific: ``load()`` and ``transcribe()``."""

    def __init__(self, args: Any):
        self.args = args
        self.kind: Optional[str] = None
        self.model: Any = None
        self.device = "cpu"
        self.np: Any = None
        self._align_models: Dict[str, Any] = {}

    def load(self) -> "WhisperEngine":
        a = self.args
        kind = pick_engine(a.engine)
        if kind is None:
            raise RuntimeError(
                f"{'no Whisper engine is' if a.engine == 'auto' else a.engine + ' is not'} installed for this Python; {INSTALL_HINT}"
            )
        if a.align and kind != "whisperx" and not module_available("whisperx"):
            raise RuntimeError("--align needs WhisperX: pip install whisperx")
        import numpy  # type: ignore  (every engine depends on it)

        self.np = numpy
        device = resolve_device(a.device)
        index = 0
        if device.startswith("cuda:"):
            device, index = "cuda", int(device.split(":", 1)[1])
        if kind in ("faster-whisper", "whisperx") and device == "mps":
            device = "cpu"  # CTranslate2 has no Metal backend
        self.device = device
        compute_type = a.compute_type or ("float16" if device == "cuda" else "int8")
        if kind == "faster-whisper":
            from faster_whisper import WhisperModel  # type: ignore

            self.model = WhisperModel(
                a.model, device=device, device_index=index, compute_type=compute_type, download_root=a.download_root
            )
        elif kind == "whisper":
            import whisper  # type: ignore

            self.model = whisper.load_model(
                a.model, device=f"cuda:{index}" if device == "cuda" else device, download_root=a.download_root
            )
        else:
            import whisperx  # type: ignore

            kwargs: Dict[str, Any] = {
                "device_index": index,
                "compute_type": compute_type,
                "download_root": a.download_root,
            }
            if _accepts(whisperx.load_model, "vad_method"):  # whisperx >= 3.3: silero is lighter than pyannote
                kwargs["vad_method"] = "silero" if a.vad else "pyannote"
            self.model = whisperx.load_model(a.model, device, **kwargs)
        self.kind = kind
        return self

    def transcribe(
        self, audio: Any, *, language: Optional[str], prompt: Optional[str], words: bool, ctx: RequestContext
    ) -> Dict[str, Any]:
        """THE engine call. Returns ``{"language", "segments": [{start, end, text, words?}]}``."""
        a = self.args
        segments: List[Dict[str, Any]] = []
        lang: Optional[str]
        if self.kind == "faster-whisper":
            seg_iter, info = self.model.transcribe(
                audio,
                language=language,
                initial_prompt=prompt or None,
                word_timestamps=words or a.align,
                vad_filter=a.vad,
                beam_size=a.beam_size,
                condition_on_previous_text=a.condition_on_previous_text,
            )
            lang = getattr(info, "language", None) or language
            for seg in seg_iter:  # lazy: each step decodes one more window
                ctx.check_cancelled()
                item: Dict[str, Any] = {"start": float(seg.start), "end": float(seg.end), "text": seg.text.strip()}
                if words:
                    item["words"] = [
                        w
                        for w in (
                            _word(x.word, x.start, x.end, getattr(x, "probability", None)) for x in seg.words or []
                        )
                        if w
                    ]
                segments.append(item)
        elif self.kind == "whisper":
            result = self.model.transcribe(
                audio,
                language=language,
                initial_prompt=prompt or None,
                word_timestamps=words or a.align,
                beam_size=a.beam_size,
                condition_on_previous_text=a.condition_on_previous_text,
                fp16=self.device == "cuda",
                verbose=None,
            )
            lang = result.get("language") or language
            for seg in result.get("segments", []):
                item = {"start": float(seg["start"]), "end": float(seg["end"]), "text": str(seg["text"]).strip()}
                if words:
                    item["words"] = [
                        w
                        for w in (
                            _word(x.get("word"), x.get("start"), x.get("end"), x.get("probability"))
                            for x in seg.get("words", [])
                        )
                        if w
                    ]
                segments.append(item)
        else:  # whisperx: batched faster-whisper + VAD; words come from the alignment below
            opts: Dict[str, Any] = {"batch_size": a.batch_size}
            if language:
                opts["language"] = language
            result = self.model.transcribe(audio, **opts)
            lang = result.get("language") or language
            segments = [
                {"start": float(s["start"]), "end": float(s["end"]), "text": str(s["text"]).strip()}
                for s in result.get("segments", [])
            ]
        ctx.check_cancelled()
        if words and (self.kind == "whisperx" or a.align) and segments and lang:
            segments = self.align(audio, segments, lang, ctx)
        return {"language": lang, "segments": segments}

    def align(self, audio: Any, segments: List[Dict[str, Any]], lang: str, ctx: RequestContext) -> List[Dict[str, Any]]:
        """WhisperX forced alignment (wav2vec2) → word timings with alignment scores."""
        import whisperx  # type: ignore

        if lang not in self._align_models:
            try:
                self._align_models[lang] = whisperx.load_align_model(language_code=lang, device=self.device)
            except Exception as e:  # noqa: BLE001 - no alignment model for this language
                if any("words" in s for s in segments):
                    return segments  # keep Whisper's own word timings
                raise EngineError(f"WhisperX has no alignment model for '{lang}': {e}") from None
        model, meta = self._align_models[lang]
        ctx.check_cancelled()
        aligned = whisperx.align(
            [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in segments],
            model,
            meta,
            audio,
            self.device,
            return_char_alignments=False,
        )
        out = []
        for s in aligned.get("segments", []):
            ws = [
                w
                for w in (
                    _word(x.get("word"), x.get("start"), x.get("end"), x.get("score")) for x in s.get("words", [])
                )
                if w
            ]
            out.append(
                {
                    "start": float(s["start"]),
                    "end": float(s["end"]),
                    "text": str(s.get("text", "")).strip(),
                    "words": ws,
                }
            )
        return out


def _accepts(fn: Any, name: str) -> bool:
    try:
        import inspect

        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def tidy(segments: List[Dict[str, Any]], words: bool) -> List[Dict[str, Any]]:
    out = []
    for s in segments:
        item: Dict[str, Any] = {
            "start": round(s["start"], 3),
            "end": round(max(s["start"], s["end"]), 3),
            "text": s["text"],
        }
        if words:
            item["words"] = s.get("words", [])
        if item["text"] or item.get("words"):
            out.append(item)
    return out


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("Whisper lyrics bridge", role="lyrics", **app_options(args))
    engine = WhisperEngine(args)
    loader = app.add_loader(ModelLoader(f"Whisper {args.model}", engine.load, retry_after=20))

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        body: Dict[str, Any] = {
            "name": app.name,
            "version": __version__,
            "models": [{"id": args.model, "name": f"Whisper {args.model}"}],
            "capabilities": ["LYRIC_TRANSCRIPTION"],
            "engine": engine.kind or pick_engine(args.engine) or "none",
            "align": bool(args.align),
            "vad": bool(args.vad),
            "status": loader.state,
            "hardware": {"min_vram_gb": 0},
        }
        if loader.state == "failed":
            body["error"] = loader.error
            body["install"] = INSTALL_HINT
        return json_response(body)

    @app.job("POST", "/transcribe_lyrics")
    def transcribe_lyrics(ctx: RequestContext):
        body = ctx.json_object()
        try:
            data = decode_base64(req_str(body, "audio_base64"), "audio_base64")
            lay = wav_layout(data)
        except WavError as e:
            raise BadRequest(f"audio_base64: {e}") from None
        seconds = lay["frames"] / float(lay["sample_rate"])
        if seconds > args.max_duration:
            raise BadRequest(
                f"the audio is {seconds:.0f} s long; this bridge accepts at most {args.max_duration:.0f} s (--max-duration)"
            )
        language = (req_str(body, "language", required=False, max_len=32) or "").strip().lower() or None
        if language:
            language = language.split("-")[0]  # BCP-47 "en-US" → Whisper's "en"
        prompt = req_str(body, "prompt", required=False, max_len=20_000) or None
        words = req_bool(body, "word_timestamps", default=True)
        model = req_str(body, "model", required=False, max_len=200)
        if model and model != args.model:
            raise NotFound(f"unknown model '{model}' (this bridge serves '{args.model}')")
        eng = loader.get()  # 503 while loading; 500 with the install hint when it failed

        def work():
            try:
                audio = wav_to_16k_mono(data, eng.np)
            except WavError as e:
                raise BadRequest(f"audio_base64: {e}") from None
            ctx.check_cancelled()
            result = eng.transcribe(audio, language=language, prompt=prompt, words=words, ctx=ctx)
            segments = tidy(result["segments"], words)
            out = {
                "text": " ".join(s["text"] for s in segments).strip(),
                "language": result.get("language") or language,
                "segments": segments,
                "model": args.model,
            }
            return json_response(out, headers={"X-Model": args.model})

        return work

    return app


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser(
        "Song Deck lyrics transcription bridge for Whisper (reference implementation).",
        DEFAULT_PORT,
        prog="whisper_bridge.py",
    )
    p.set_defaults(model=DEFAULT_MODEL)
    w = p.add_argument_group("whisper")
    w.add_argument(
        "--engine",
        choices=["auto", *ENGINES],
        default="auto",
        help="auto: faster-whisper, else openai-whisper, else whisperx (default auto)",
    )
    w.add_argument(
        "--compute-type", default=None, help="CTranslate2 compute type (default float16 on CUDA, int8 on CPU)"
    )
    w.add_argument(
        "--vad", action="store_true", help="skip non-speech first (faster-whisper/WhisperX voice activity detection)"
    )
    w.add_argument(
        "--align", action="store_true", help="refine word timings with WhisperX forced alignment (pip install whisperx)"
    )
    w.add_argument("--beam-size", type=int, default=5, help="beam size (default 5)")
    w.add_argument("--batch-size", type=int, default=16, help="WhisperX batch size (default 16)")
    w.add_argument(
        "--condition-on-previous-text",
        action="store_true",
        help="feed each window the previous text (off by default: on songs it causes repetition loops)",
    )
    w.add_argument("--download-root", default=None, help="model cache folder (default: the engine's)")
    w.add_argument(
        "--max-duration", type=float, default=1200.0, help="longest accepted input in seconds (default 1200)"
    )
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    if args.max_jobs != 1:
        print("warning: one Whisper model serves one request at a time; forcing --max-jobs 1", file=sys.stderr)
        args.max_jobs = 1
    if pick_engine(args.engine) is None:
        print(
            f"warning: {args.engine} is not installed: {INSTALL_HINT}. The bridge starts anyway; /health and /info report the error.",
            file=sys.stderr,
        )
    app = build_app(args)
    app.loaders[0].start()  # background load; /transcribe_lyrics answers 503 until ready
    return serve([(app, args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
