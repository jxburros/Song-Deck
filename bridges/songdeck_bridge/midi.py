"""
MIDI helpers for Song Deck bridges (standard library only).

The plugin-host contract (``PLUGIN_HOST_PATHS`` in ``packages/ai/src/contracts.ts``) sends MIDI as
raw messages with absolute times in seconds::

    {"time_seconds": 0.5, "data": [144, 60, 100]}      # note on, channel 1, C4, velocity 100

This module validates those events (:func:`parse_events`), writes them as a Standard MIDI File for
command-line renderers such as FluidSynth or sfizz (:func:`write_smf`), and pairs note on/off
messages into notes (:func:`note_spans`) for engines that take notes rather than raw messages.

Times are exact to the SMF tick: the file uses 960 ticks per quarter note at 120 BPM, so one tick
is 1/1920 s (about 0.52 ms).
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .server import BadRequest

__all__ = [
    "MidiEvent",
    "NoteSpan",
    "message_length",
    "validate_message",
    "parse_events",
    "write_smf",
    "note_spans",
    "used_channels",
    "SMF_PPQ",
    "SMF_TEMPO_US",
]

#: ``(time in seconds, raw message bytes)`` — the shape pedalboard also accepts.
MidiEvent = Tuple[float, bytes]

SMF_PPQ = 960
SMF_TEMPO_US = 500_000  # 120 BPM → one tick = 500000 / 960 µs
MAX_EVENTS = 1_000_000
MAX_SYSEX_BYTES = 65_536


def message_length(status: int) -> Optional[int]:
    """Bytes in a message starting with ``status`` (None = variable-length SysEx; 0 = not allowed)."""
    if status < 0x80 or status > 0xFF:
        return 0
    kind = status & 0xF0
    if kind in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
        return 3
    if kind in (0xC0, 0xD0):
        return 2
    if status == 0xF0:
        return None
    if status in (0xF1, 0xF3):
        return 2
    if status == 0xF2:
        return 3
    if status in (0xF6, 0xF8, 0xFA, 0xFB, 0xFC, 0xFE):
        return 1
    return 0  # 0xF4/0xF5/0xF9/0xFD (undefined), 0xF7 (end of SysEx alone), 0xFF (reset; meta in files)


def validate_message(data: Sequence[Any]) -> bytes:
    """Check one raw MIDI message (status byte first) and return it as bytes; ValueError if invalid."""
    if not isinstance(data, (list, tuple)) or not data:
        raise ValueError("must be a non-empty array of bytes")
    for b in data:
        if isinstance(b, bool) or not isinstance(b, int) or not 0 <= b <= 255:
            raise ValueError(f"bytes must be integers 0-255 (got {b!r})")
    status = data[0]
    expected = message_length(status)
    if expected == 0:
        raise ValueError(f"status byte {status:#04x} is not a MIDI message this host accepts")
    if expected is None:  # SysEx: F0 … F7
        if len(data) < 2 or data[-1] != 0xF7:
            raise ValueError("a SysEx message must end with 0xF7")
        if len(data) > MAX_SYSEX_BYTES:
            raise ValueError(f"SysEx messages are limited to {MAX_SYSEX_BYTES} bytes")
        if any(b >= 0x80 for b in data[1:-1]):
            raise ValueError("SysEx data bytes must be < 0x80")
        return bytes(data)
    if len(data) != expected:
        raise ValueError(f"status {status:#04x} needs {expected} byte(s), got {len(data)}")
    if any(b >= 0x80 for b in data[1:]):
        raise ValueError("data bytes must be < 0x80")
    return bytes(data)


def parse_events(raw: Any, duration: float, *, field: str = "events", max_events: int = MAX_EVENTS) -> List[MidiEvent]:
    """Validate contract MIDI events; returns ``[(seconds, bytes)]`` sorted by time.

    Events at or after ``duration`` are dropped (the contract ignores them). Invalid input raises
    :class:`~songdeck_bridge.server.BadRequest` naming the offending event.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise BadRequest(f"'{field}' must be an array of {{time_seconds, data}} objects")
    if len(raw) > max_events:
        raise BadRequest(f"'{field}' has too many events (max {max_events})")
    out: List[Tuple[float, int, bytes]] = []
    for i, ev in enumerate(raw):
        if not isinstance(ev, dict):
            raise BadRequest(f"{field}[{i}] must be an object {{time_seconds, data}}")
        t = ev.get("time_seconds")
        if isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0:
            raise BadRequest(f"{field}[{i}].time_seconds must be a number >= 0")
        try:
            msg = validate_message(ev.get("data"))
        except ValueError as e:
            raise BadRequest(f"{field}[{i}].data: {e}") from None
        if t >= duration:
            continue
        out.append((float(t), i, msg))
    out.sort(key=lambda e: (e[0], e[1]))  # stable: equal times keep request order
    return [(t, m) for t, _, m in out]


def _vlq(n: int) -> bytes:
    n = max(0, int(n))
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append(0x80 | (n & 0x7F))
        n >>= 7
    return bytes(reversed(out))


def seconds_to_ticks(t: float) -> int:
    return int(round(t * 1_000_000.0 / SMF_TEMPO_US * SMF_PPQ))


def write_smf(events: Sequence[MidiEvent], *, duration: Optional[float] = None, prepend: Sequence[bytes] = ()) -> bytes:
    """Encode events as a format-0 Standard MIDI File.

    ``prepend`` messages (e.g. bank select + program change) are written at tick 0 before the
    events. The End of Track meta event sits at ``duration`` (or the last event), so renderers that
    stop at the end of the file (``sfizz_render --use-eot``) render the full length. System
    real-time and common messages, which cannot be stored in a file, are skipped.
    """
    track = bytearray()
    track += b"\x00\xff\x51\x03" + struct.pack(">I", SMF_TEMPO_US)[1:]
    last = 0
    for msg in prepend:
        track += b"\x00" + bytes(msg)
    for t, msg in events:
        status = msg[0]
        if 0xF1 <= status <= 0xFF:
            continue
        tick = seconds_to_ticks(t)
        delta = max(0, tick - last)
        last = max(last, tick)
        if status == 0xF0:
            track += _vlq(delta) + b"\xf0" + _vlq(len(msg) - 1) + msg[1:]
        else:
            track += _vlq(delta) + msg
    end = max(last, seconds_to_ticks(duration) if duration is not None else last)
    track += _vlq(end - last) + b"\xff\x2f\x00"
    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, SMF_PPQ)
    return header + b"MTrk" + struct.pack(">I", len(track)) + bytes(track)


@dataclass
class NoteSpan:
    start: float
    end: float
    channel: int
    pitch: int
    velocity: int


def note_spans(events: Sequence[MidiEvent], duration: float) -> List[NoteSpan]:
    """Pair note on/off messages (first in, first out per channel and key) into notes.

    A note on with velocity 0 is a note off; CC 120/123 (all sound/notes off) end every note of the
    channel; notes still sounding at ``duration`` end there.
    """
    open_notes: Dict[Tuple[int, int], List[Tuple[float, int]]] = {}
    spans: List[NoteSpan] = []
    for t, msg in events:
        kind, ch = msg[0] & 0xF0, msg[0] & 0x0F
        if kind == 0x90 and msg[2] > 0:
            open_notes.setdefault((ch, msg[1]), []).append((t, msg[2]))
        elif kind == 0x80 or (kind == 0x90 and msg[2] == 0):
            stack = open_notes.get((ch, msg[1]))
            if stack:
                start, vel = stack.pop(0)
                spans.append(NoteSpan(start, max(start, t), ch, msg[1], vel))
        elif kind == 0xB0 and msg[1] in (120, 123):
            for (c, p), stack in open_notes.items():
                if c == ch:
                    spans.extend(NoteSpan(s, max(s, t), c, p, v) for s, v in stack)
                    stack.clear()
    for (c, p), stack in open_notes.items():
        spans.extend(NoteSpan(s, max(s, duration), c, p, v) for s, v in stack)
    spans.sort(key=lambda n: (n.start, n.channel, n.pitch))
    return spans


def used_channels(events: Sequence[MidiEvent]) -> List[int]:
    """Channels (0-15) addressed by channel messages, in ascending order (``[0]`` when none)."""
    chans = sorted({m[0] & 0x0F for _, m in events if 0x80 <= m[0] < 0xF0})
    return chans or [0]
