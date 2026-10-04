#!/usr/bin/env python3
"""
Song Deck TRANSCRIPTION bridge for Spotify Basic Pitch — reference implementation.

Contract (packages/ai/src/contracts.ts, TRANSCRIPTION_BRIDGE_PATHS)::

    POST /transcribe  {"audio_base64": "<wav>", "source": "mix|vocals|bass|drums|piano|guitar|melody|other"}
                   →  {"notes": [{"pitch", "start", "end", "velocity", "confidence"}], "tempo"?, "key"?}
    GET  /info · GET /health · POST /cancel

How it works
------------
``basic_pitch.inference.predict`` returns note events ``(start_s, end_s, pitch_midi, amplitude,
pitch_bends)``. Each becomes a contract note: ``velocity = round(127 × amplitude)`` (what Basic
Pitch's own MIDI export does) and ``confidence = amplitude`` (Basic Pitch has no separate per-note
confidence; the mean note posterior is the closest proxy). ``source`` picks a frequency range
(bass 30–400 Hz, vocals/melody 70–1400 Hz, …). ``drums`` answers 501: Basic Pitch transcribes
pitched notes only. ``tempo`` comes from a simple onset autocorrelation and ``key`` from a
Krumhansl–Kessler profile match over the notes (both stdlib, see songdeck_bridge.dsp).

The model loads once in a background thread at startup; requests answer 503 (+ Retry-After)
until it is ready.

Install and run
---------------
::

    pip install basic-pitch            # CPU is fine; TensorFlow/ONNX/CoreML backends depending on platform
    python3 bridges/basic_pitch_bridge.py                      # http://127.0.0.1:8813

In Song Deck: Settings → Providers → Add provider → Transcription → "Basic Pitch (local)".

This is REFERENCE code (not exercised in Song Deck's CI), written against the basic-pitch 0.3/0.4
API. ``load_engine()`` and ``run_basic_pitch()`` are the functions to adapt for other versions.
"""

from __future__ import annotations

import os
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
    ModelLoader,
    NotSupported,
    RequestContext,
    json_response,
    req_str,
)
from songdeck_bridge.wav import WavError, decode_base64, wav_info  # noqa: E402

DEFAULT_PORT = 8813

#: Basic Pitch settings per contract `source` (None = Basic Pitch's own default).
SOURCE_SETTINGS: Dict[str, Dict[str, Any]] = {
    "bass": {"minimum_frequency": 30.0, "maximum_frequency": 400.0, "minimum_note_length": 90.0},
    "vocals": {"minimum_frequency": 70.0, "maximum_frequency": 1400.0, "minimum_note_length": 80.0},
    "melody": {"minimum_frequency": 70.0, "maximum_frequency": 1400.0, "minimum_note_length": 80.0},
    "guitar": {"minimum_frequency": 75.0, "maximum_frequency": 1400.0},
    "piano": {"minimum_frequency": 27.5, "maximum_frequency": 4200.0},
    "mix": {},
    "other": {},
}

NoteEvent = Tuple[float, float, int, float, Optional[Sequence[int]]]


def load_engine(model_path: Optional[str]) -> Tuple[Any, Any]:
    """Import Basic Pitch and load the model once. Returns ``(inference module, model)``.

    basic-pitch ≥ 0.3 exposes ``basic_pitch.inference.Model`` (TF / CoreML / TFLite / ONNX
    backends); older versions take the model path in ``predict`` and load it on every call.
    """
    from basic_pitch import ICASSP_2022_MODEL_PATH  # type: ignore
    from basic_pitch import inference  # type: ignore

    path = model_path or ICASSP_2022_MODEL_PATH
    model_cls = getattr(inference, "Model", None)
    return inference, (model_cls(path) if model_cls is not None else path)


def run_basic_pitch(engine: Tuple[Any, Any], wav_path: Path, settings: Dict[str, Any], args: Any) -> List[NoteEvent]:
    """THE engine call: note events ``(start_s, end_s, pitch_midi, amplitude, pitch_bends)``.

    ``predict(audio_path, model_or_model_path, onset_threshold, frame_threshold,
    minimum_note_length (ms), minimum_frequency, maximum_frequency, multiple_pitch_bends,
    melodia_trick)`` → ``(model_output, midi_data, note_events)`` in basic-pitch 0.2–0.4.
    """
    inference, model = engine
    _model_output, _midi, note_events = inference.predict(
        str(wav_path),
        model,
        onset_threshold=args.onset_threshold,
        frame_threshold=args.frame_threshold,
        minimum_note_length=settings.get("minimum_note_length", args.min_note_ms),
        minimum_frequency=settings.get("minimum_frequency"),
        maximum_frequency=settings.get("maximum_frequency"),
        multiple_pitch_bends=False,
        melodia_trick=not args.no_melodia_trick,
    )
    return list(note_events)


def events_to_notes(events: List[NoteEvent]) -> List[Dict[str, Any]]:
    notes = []
    for ev in events:
        start, end, pitch, amplitude = float(ev[0]), float(ev[1]), int(ev[2]), float(ev[3])
        if not end > start:
            continue
        amp = max(0.0, min(1.0, amplitude))
        notes.append(
            {
                "pitch": max(0, min(127, pitch)),
                "start": round(start, 4),
                "end": round(end, 4),
                "velocity": max(1, min(127, int(round(127 * amp)))),
                "confidence": round(amp, 3),
            }
        )
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("Basic Pitch transcription bridge", role="transcription", **app_options(args))
    loader = app.add_loader(ModelLoader("Basic Pitch model", lambda: load_engine(args.model_path)))

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            {
                "name": app.name,
                "version": __version__,
                "models": [{"id": "basic-pitch-icassp-2022", "name": "Basic Pitch (ICASSP 2022)"}],
                "capabilities": ["AUDIO_TRANSCRIPTION", "AUDIO_TO_MIDI", "PITCH_TRACKING"],
                "sources": sorted(SOURCE_SETTINGS),
                "status": loader.state,
                "hardware": {"min_vram_gb": 0},
            }
        )

    @app.job("POST", "/transcribe")
    def transcribe(ctx: RequestContext):
        body = ctx.json_object()
        try:
            wav_bytes = decode_base64(req_str(body, "audio_base64"), "audio_base64")
            meta = wav_info(wav_bytes)
        except WavError as e:
            raise BadRequest(f"audio_base64: {e}") from None
        source = (req_str(body, "source", required=False, default="mix") or "mix").strip().lower()
        if source == "drums":
            raise NotSupported(
                "Basic Pitch transcribes pitched notes; drums are unpitched (use a drum-transcription engine or Song Deck's built-in analysis)"
            )
        settings = SOURCE_SETTINGS.get(source, SOURCE_SETTINGS["other"])
        if meta["duration"] > args.max_duration:
            raise BadRequest(
                f"the audio is {meta['duration']:.0f} s long; this bridge accepts at most {args.max_duration:.0f} s (--max-duration)"
            )
        engine = loader.get()  # 503 while the model is loading

        def work():
            with tempfile.TemporaryDirectory(prefix="songdeck-basic-pitch-") as tmp:
                path = Path(tmp, "input.wav")
                path.write_bytes(wav_bytes)
                ctx.check_cancelled()
                events = run_basic_pitch(engine, path, settings, args)
            ctx.check_cancelled()  # inference itself cannot be interrupted; drop the result if cancelled
            notes = events_to_notes(events)
            result: Dict[str, Any] = {"notes": notes}
            tempo = dsp.estimate_tempo([n["start"] for n in notes])
            if tempo:
                result["tempo"] = tempo
            key = dsp.estimate_key(notes)
            if key:
                result["key"] = key[0]
            return json_response(result, headers={"X-Model": "basic-pitch-icassp-2022"})

        return work

    return app


def main(argv: Optional[List[str]] = None) -> int:
    p = build_parser(
        "Song Deck transcription bridge for Spotify Basic Pitch (reference implementation).",
        DEFAULT_PORT,
        prog="basic_pitch_bridge.py",
    )
    b = p.add_argument_group("basic pitch")
    b.add_argument(
        "--model-path", default=None, help="model file/folder (default: the ICASSP 2022 model shipped with basic-pitch)"
    )
    b.add_argument("--onset-threshold", type=float, default=0.5, help="onset posterior threshold (default 0.5)")
    b.add_argument("--frame-threshold", type=float, default=0.3, help="frame posterior threshold (default 0.3)")
    b.add_argument("--min-note-ms", type=float, default=127.7, help="minimum note length in ms (default 127.7)")
    b.add_argument("--no-melodia-trick", action="store_true", help="disable Basic Pitch's melodia post-processing")
    b.add_argument(
        "--max-duration", type=float, default=1800.0, help="longest accepted input in seconds (default 1800)"
    )
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    if not module_available("basic_pitch"):
        fail("Basic Pitch is not installed for this Python. Install it with:  pip install basic-pitch")
    app = build_app(args)
    app.loaders[0].start()  # load in the background; /transcribe answers 503 until ready
    return serve([(app, args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
