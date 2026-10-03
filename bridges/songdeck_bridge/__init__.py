"""
songdeck_bridge — a tiny, dependency-free toolkit for Song Deck local-model bridges.

A *bridge* wraps a local engine (ACE-Step, DiffSinger, Demucs, Basic Pitch, RVC, a mastering
engine…) behind the small JSON/HTTP contracts defined in ``packages/ai/src/contracts.ts``, so
Song Deck never depends on one engine. This package provides the parts every bridge needs:

* :mod:`songdeck_bridge.server` — a ``ThreadingHTTPServer`` application with routing,
  contract-shaped JSON errors, optional bearer token, CORS for the Song Deck origins, body size
  limits, a job slot/queue, ``POST /cancel`` and client-disconnect detection.
* :mod:`songdeck_bridge.wav` — WAV read/write (PCM 16/24/32, float 32/64), base64, resampling.
* :mod:`songdeck_bridge.dsp` — small stdlib DSP (oscillators, filters, BS.1770 loudness,
  limiter, pitch tracking, tempo/key estimates) used by the mock bridge and stdlib fallbacks.
* :mod:`songdeck_bridge.cli` — the common command-line flags and a serve loop with graceful
  shutdown.

Everything here uses only the Python standard library (3.9+).
"""

__version__ = "0.1.0"
