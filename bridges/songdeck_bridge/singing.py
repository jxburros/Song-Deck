"""
Singing-contract request parsing shared by singing bridges (mock and DiffSinger).

``POST /synthesize`` → audio covering 0 … end of the last note.
``POST /regenerate_phrase`` → audio covering ONLY [start_seconds, end_seconds].

:func:`parse_singing_request` validates a body against ``SingingBridgeRequest`` /
``SingingBridgePhraseRequest`` (packages/ai/src/contracts.ts) and returns a :class:`SingingJob`
whose ``window`` and ``frames(sample_rate)`` encode exactly those time ranges.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .server import BadRequest, NotFound, req_list, req_number, req_object, req_seed, req_str

__all__ = ["SungNote", "SingingJob", "parse_note", "parse_singing_request", "ONSETS", "RELEASES"]

ONSETS = ("soft", "normal", "hard", "scoop")
RELEASES = ("normal", "falling", "rising", "breathy", "cut")


@dataclass
class SungNote:
    pitch: float
    start: float
    duration: float
    lyric: str
    velocity: float
    phonemes: List[str] = field(default_factory=list)
    expression: Dict[str, Any] = field(default_factory=dict)

    @property
    def end(self) -> float:
        return self.start + self.duration

    @property
    def is_melisma(self) -> bool:
        """``_`` (or a bare ``-``) continues the previous syllable's vowel."""
        return self.lyric.strip() in ("_", "-")


@dataclass
class SingingJob:
    voice_id: str
    tempo_bpm: float
    sample_rate: int
    seed: int
    notes: List[SungNote]
    language: Optional[str] = None
    phrase: Optional[Tuple[float, float]] = None

    @property
    def window(self) -> Tuple[float, float]:
        """Time range the output must cover: (0, end of last note) or the phrase range."""
        if self.phrase is not None:
            return self.phrase
        return 0.0, max(n.end for n in self.notes)

    def frames(self, sample_rate: Optional[int] = None) -> int:
        sr = sample_rate or self.sample_rate
        t0, t1 = self.window
        if self.phrase is not None:
            return max(1, int(round((t1 - t0) * sr)))
        return max(1, int(math.ceil(t1 * sr - 1e-9)))  # covers the last note completely

    def notes_in_window(self) -> List[SungNote]:
        t0, t1 = self.window
        return [n for n in self.notes if n.end > t0 and n.start < t1]


def _prefixed(prefix: str, fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except BadRequest as e:
        raise BadRequest(f"{prefix}: {e.message}") from None


def parse_note(i: int, raw: Any) -> SungNote:
    if not isinstance(raw, dict):
        raise BadRequest(f"notes[{i}] must be an object")
    p = f"notes[{i}]"
    pitch = _prefixed(p, lambda: req_number(raw, "pitch", minimum=0, maximum=127))
    start = _prefixed(p, lambda: req_number(raw, "start_seconds", minimum=0))
    duration = _prefixed(p, lambda: req_number(raw, "duration_seconds", exclusive_minimum=0))
    lyric = _prefixed(p, lambda: req_str(raw, "lyric", required=False, default="la", max_len=200))
    velocity = _prefixed(p, lambda: req_number(raw, "velocity", required=False, default=90, minimum=0, maximum=127))
    phonemes = _prefixed(p, lambda: req_list(raw, "phonemes", required=False, default=[], max_items=64))
    if any(not isinstance(ph, str) or not ph.strip() for ph in phonemes):
        raise BadRequest(f"{p}: 'phonemes' must be an array of non-empty strings")
    expr_raw = _prefixed(p, lambda: req_object(raw, "expression", required=False, default={}))
    expr: Dict[str, Any] = {}
    q = f"{p}.expression"
    for name in ("breathiness", "tension", "vibrato", "energy"):
        v = _prefixed(q, lambda: req_number(expr_raw, name, required=False, minimum=0, maximum=1))
        if v is not None:
            expr[name] = v
    rate = _prefixed(q, lambda: req_number(expr_raw, "vibrato_rate", required=False, minimum=0, maximum=20))
    if rate is not None:
        expr["vibrato_rate"] = rate
    for name in ("onset", "release"):  # unknown values are ignored ("unsupported parameters can be ignored", spec §35)
        v = _prefixed(q, lambda: req_str(expr_raw, name, required=False, max_len=32))
        if v is not None:
            expr[name] = v.strip().lower()
    return SungNote(
        float(pitch),
        float(start),
        float(duration),
        lyric if lyric is not None else "la",
        max(1.0, float(velocity)),
        [ph.strip() for ph in phonemes],
        expr,
    )


def parse_singing_request(
    body: Dict[str, Any], *, phrase: bool, voice_ids: Iterable[str], max_duration: float = 600.0, max_notes: int = 20000
) -> SingingJob:
    """Validate a /synthesize (``phrase=False``) or /regenerate_phrase (``phrase=True``) body."""
    voices = list(voice_ids)
    voice_id = req_str(body, "voice_id", allow_empty=False, max_len=200)
    if voice_id not in voices:
        raise NotFound(f"unknown voice_id '{voice_id}' (available: {', '.join(voices) or 'none'})")
    tempo = req_number(body, "tempo_bpm", exclusive_minimum=0, maximum=1000)
    sample_rate = int(req_number(body, "sample_rate", minimum=8000, maximum=192000))
    seed, _ = req_seed(body)
    raw = req_list(body, "notes", max_items=max_notes)
    if not raw:
        raise BadRequest("'notes' must contain at least one note")
    notes = sorted((parse_note(i, n) for i, n in enumerate(raw)), key=lambda n: n.start)
    language = req_str(body, "language", required=False, max_len=35)
    window: Optional[Tuple[float, float]] = None
    if phrase:
        start = req_number(body, "start_seconds", minimum=0)
        end = req_number(body, "end_seconds", minimum=0)
        if end <= start:
            raise BadRequest("'end_seconds' must be greater than 'start_seconds'")
        window = (float(start), float(end))
        if end - start > max_duration:
            raise BadRequest(
                f"the phrase is {end - start:.1f} s long; this bridge renders at most {max_duration:.0f} s"
            )
    else:
        last = max(n.end for n in notes)
        if last > max_duration:
            raise BadRequest(f"the last note ends at {last:.1f} s; this bridge renders at most {max_duration:.0f} s")
    return SingingJob(voice_id, float(tempo), sample_rate, seed, notes, language, window)
