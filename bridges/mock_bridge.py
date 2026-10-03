#!/usr/bin/env python3
"""
Song Deck MOCK bridge — every local-model contract, implemented with simple deterministic DSP.

No machine-learning model and no third-party package is involved (Python 3.9+ standard library
only), so anyone can check a Song Deck setup end to end — provider presets, base URLs, auth,
CORS, cancellation, error handling, WAV round trips — before installing real engines. The audio
is deliberately simple; it is a test signal, not music production.

Roles (one per process, on the port of the matching Song Deck preset), or ``--role all``:

=================  =====  ======================  ==================================================
role               port   Song Deck preset        what the mock does
=================  =====  ======================  ==================================================
music              8810   ace-step-local          /info; /generate: seeded additive-synth chord
                                                  progression at bpm/key/duration, one feel per
                                                  section, a hummed line following the lyric
                                                  syllables; /transform: blend with strength;
                                                  /inpaint: only the range changes; /extend;
                                                  /cancel
singing            8811   diffsinger-local        /voices (2 stock voices); /synthesize and
                                                  /regenerate_phrase: sine/sawtooth tones with
                                                  vibrato at the note pitches and times
separation         8812   demucs-local            /separate: complementary frequency bands as
                                                  "stems" (their sum equals the input)
transcription      8813   basic-pitch-local       /transcribe: autocorrelation (NSDF) pitch tracker
                                                  → notes with confidence (monophonic input);
                                                  onset detector for source "drums"
voice-conversion   8814   rvc-local               /voices; /convert: pitch shift (resample +
                                                  overlap-add) + per-voice tone colour
mastering          8815   mastering-local         /master: BS.1770 loudness normalization to the
                                                  target (or the reference's loudness) + limiter
=================  =====  ======================  ==================================================

Every role also answers ``GET /info`` (what Song Deck's "Test connection" and model manager
probe), ``GET /health`` and ``POST /cancel``. Audio responses carry ``X-Seed`` and ``X-Model``.

Examples::

    python3 bridges/mock_bridge.py --role music                    # http://127.0.0.1:8810
    python3 bridges/mock_bridge.py --role all --base-port 8810     # all six roles, 8810-8815
    python3 bridges/mock_bridge.py --role singing --token s3cret   # bearer token required
"""

from __future__ import annotations

import math
import os
import re
import sys
from dataclasses import dataclass, field
from operator import add, mul, sub
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__, dsp  # noqa: E402
from songdeck_bridge.cli import app_options, build_parser, check_bind, fail, serve, setup_logging  # noqa: E402
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    NotFound,
    RequestContext,
    json_response,
    req_audio,
    req_bool,
    req_list,
    req_number,
    req_seed,
    req_str,
    wav_response,
)
from songdeck_bridge.singing import SingingJob, SungNote, parse_singing_request  # noqa: E402
from songdeck_bridge.wav import Audio, encode_base64, fit_length, resample_audio, write_wav  # noqa: E402

#: role → default port (= the Song Deck preset's base URL port) and preset id.
ROLES: Dict[str, Tuple[int, str]] = {
    "music": (8810, "ace-step-local"),
    "singing": (8811, "diffsinger-local"),
    "separation": (8812, "demucs-local"),
    "transcription": (8813, "basic-pitch-local"),
    "voice-conversion": (8814, "rvc-local"),
    "mastering": (8815, "mastering-local"),
}


@dataclass
class MockOptions:
    sample_rate: int = 44100
    max_duration: float = 600.0
    delay: float = 0.0
    music_model: str = "mock-additive"


def _prefixed(prefix: str, fn: Callable[[], Any]) -> Any:
    """Run a field validation, prefixing its 400 message (e.g. ``notes[3]: …``)."""
    try:
        return fn()
    except BadRequest as e:
        raise BadRequest(f"{prefix}: {e.message}") from None


def _info(name: str, role: str, models: List[Dict[str, str]], capabilities: List[str], **extra: Any) -> Dict[str, Any]:
    body = {
        "name": name,
        "version": __version__,
        "models": models,
        "capabilities": capabilities,
        "hardware": {"min_vram_gb": 0},
        "role": role,
        "mock": True,
        "notes": "Song Deck mock bridge: deterministic stdlib DSP for integration testing, not a real model.",
    }
    body.update(extra)
    return body


def _check_length(audio: Audio, opts: MockOptions, field_name: str = "audio_base64") -> None:
    if audio.duration > opts.max_duration:
        raise BadRequest(
            f"'{field_name}' is {audio.duration:.1f} s long; the mock accepts at most {opts.max_duration:.0f} s (--max-duration)"
        )


def _protect_peaks(channels: List[List[float]], ceiling: float = 0.98) -> List[List[float]]:
    pk = dsp.peak_channels(channels)
    if pk > ceiling:
        g = ceiling / pk
        return [dsp.scale(ch, g) for ch in channels]
    return channels


# ===========================================================================
# Music: keys, sections, lyrics → a little arrangement
# ===========================================================================

_PC = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
_ACC = {"": 0, "#": 1, "♯": 1, "##": 2, "x": 2, "b": -1, "♭": -1, "bb": -2}
MODES: Dict[str, List[int]] = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "dorian": [0, 2, 3, 5, 7, 9, 10],
    "phrygian": [0, 1, 3, 5, 7, 8, 10],
    "lydian": [0, 2, 4, 6, 7, 9, 11],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "locrian": [0, 1, 3, 5, 6, 8, 10],
    "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
    "melodic minor": [0, 2, 3, 5, 7, 9, 11],
}
_MODE_ALIASES = {
    "": "major",
    "maj": "major",
    "major": "major",
    "ionian": "major",
    "m": "minor",
    "min": "minor",
    "minor": "minor",
    "aeolian": "minor",
}
_KEY_RE = re.compile(r"^\s*([A-Ga-g])(##|bb|#|b|♯|♭|x)?\s*(.*?)\s*$")
_MINORISH = {"minor", "dorian", "phrygian", "locrian", "harmonic minor", "melodic minor"}

#: Scale-degree progressions (0 = tonic triad), one chord per bar.
PROGRESSIONS = {
    "major": [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 4, 3], [0, 3, 0, 4]],
    "minor": [[0, 5, 2, 6], [0, 3, 4, 0], [0, 6, 5, 6], [0, 3, 5, 4], [0, 5, 3, 4]],
}

SECTION_ENERGY = [
    ("pre", 0.65),
    ("chorus", 0.9),
    ("hook", 0.9),
    ("drop", 1.0),
    ("verse", 0.55),
    ("bridge", 0.6),
    ("breakdown", 0.4),
    ("break", 0.4),
    ("solo", 0.8),
    ("intro", 0.35),
    ("outro", 0.3),
    ("interlude", 0.45),
    ("refrain", 0.85),
]
_CALM = re.compile(r"\b(calm|soft|quiet|gentle|ambient|chill|sparse|minimal|lullaby|mellow)\b", re.I)
_LOUD = re.compile(r"\b(loud|energetic|aggressive|big|heavy|intense|powerful|peak|anthemic|explosive)\b", re.I)


def parse_key(text: str) -> Optional[Tuple[int, str]]:
    """ "E minor", "F# major", "Bb", "c#m", "D Dorian", "A harmonic minor" → (tonic pitch class, mode)."""
    m = _KEY_RE.match(text or "")
    if not m:
        return None
    pc = (_PC[m.group(1).lower()] + _ACC.get(m.group(2) or "", 0)) % 12
    rest = m.group(3).strip().lower()
    if rest == "-":
        return pc, "minor"
    rest = re.sub(r"[\s_-]+", " ", rest)
    mode = _MODE_ALIASES.get(rest, rest if rest in MODES else None)
    return (pc, mode) if mode else None


def key_from_prompt(prompt: str) -> Tuple[int, str]:
    m = re.search(r"\b([A-G](?:#|b)?)\s*(major|minor|maj|min)\b", prompt or "")
    if m:
        parsed = parse_key(f"{m.group(1)} {m.group(2)}")
        if parsed:
            return parsed
    if re.search(r"\b(sad|dark|melanchol\w*|minor|moody|emo|gloomy|haunting)\b", prompt or "", re.I):
        return 9, "minor"
    return 0, "major"


def bpm_from_text(text: str) -> Optional[float]:
    m = re.search(r"(\d{2,3}(?:\.\d+)?)\s*bpm", text or "", re.I)
    return max(40.0, min(240.0, float(m.group(1)))) if m else None


def section_kind(name: str) -> str:
    s = re.sub(r"[^a-z]+", "", (name or "").lower())
    for kind, _ in SECTION_ENERGY:
        if s.startswith(kind) or kind in s:
            return kind
    return "verse" if not s else s


def section_energy(kind: str, *texts: str) -> float:
    e = dict(SECTION_ENERGY).get(kind, 0.55)
    for t in texts:
        if t and _CALM.search(t):
            e -= 0.15
        if t and _LOUD.search(t):
            e += 0.15
    return max(0.15, min(1.0, e))


def count_syllables(line: str) -> int:
    total = 0
    for word in re.findall(r"[A-Za-z']+", line):
        w = word.lower()
        n = len(re.findall(r"[aeiouy]+", w))
        if w.endswith("e") and n > 1 and not w.endswith(("le", "ee", "ye")):
            n -= 1
        total += max(1, n)
    return total


def parse_lyrics(text: str) -> List[Tuple[str, List[str]]]:
    """ "[verse]\\nline…\\n\\n[chorus]\\n…" → [(kind, [lines]), …]."""
    blocks: List[Tuple[str, List[str]]] = []
    tag, lines = "verse", []
    for raw in (text or "").splitlines():
        line = raw.strip()
        m = re.fullmatch(r"\[([^\]]+)\]", line)
        if m:
            if lines:
                blocks.append((tag, lines))
            tag, lines = section_kind(m.group(1)), []
            continue
        if line:
            lines.append(line)
    if lines:
        blocks.append((tag, lines))
    return blocks


@dataclass
class Section:
    name: str
    start: float
    end: float
    prompt: str = ""


@dataclass
class MusicSpec:
    sample_rate: int
    duration: float
    seed: int
    bpm: float
    tonic: int
    mode: str
    sections: List[Section]
    prompt: str = ""
    negative_prompt: str = ""
    lyrics: List[Tuple[str, List[str]]] = field(default_factory=list)
    instrumental: bool = True
    lofi: bool = False


def parse_sections(raw: Sequence[Any], duration: float) -> List[Section]:
    parsed: List[Section] = []
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            raise BadRequest(f"sections[{i}] must be an object")
        name = _prefixed(f"sections[{i}]", lambda: req_str(s, "name", required=False, default=f"Section {i + 1}"))
        start = _prefixed(f"sections[{i}]", lambda: req_number(s, "start_seconds", minimum=0))
        end = _prefixed(f"sections[{i}]", lambda: req_number(s, "end_seconds", minimum=0))
        if end <= start:
            raise BadRequest(f"sections[{i}]: end_seconds must be greater than start_seconds")
        prompt = _prefixed(f"sections[{i}]", lambda: req_str(s, "prompt", required=False, default=""))
        parsed.append(Section(name or f"Section {i + 1}", start, end, prompt or ""))
    parsed.sort(key=lambda s: s.start)
    out: List[Section] = []
    cursor = 0.0
    for s in parsed:
        start, end = max(s.start, cursor), min(s.end, duration)
        if end - start < 1e-6:
            continue
        if start - cursor > 1e-6:
            out.append(Section("Interlude", cursor, start))
        out.append(Section(s.name, start, end, s.prompt))
        cursor = end
    if duration - cursor > 1e-6:
        out.append(Section("Interlude" if out else "Song", cursor, duration))
    return out


class _Kit:
    """Three seeded one-shot drum samples (kick, snare, hat)."""

    def __init__(self, sample_rate: int, seed: int):
        sr = sample_rate
        rnd = dsp.seeded(seed, "kit")
        n = int(0.25 * sr)
        sweep = [45.0 + 65.0 * math.exp(-i / (0.03 * sr)) for i in range(n)]
        kick = dsp.osc_varying(dsp.wavetable(dsp.SINE), sweep, sr)
        self.kick = list(map(mul, kick, dsp.decay_envelope(n, sr, 0.12)))
        n = int(0.18 * sr)
        noise = dsp.white_noise(n, rnd)
        noise = [a - b for a, b in zip(noise, dsp.one_pole_lowpass(noise, sr, 1500.0))]
        body = dsp.osc(dsp.wavetable(dsp.SINE), 190.0, n, sr)
        env_n, env_b = dsp.decay_envelope(n, sr, 0.05), dsp.decay_envelope(n, sr, 0.04)
        self.snare = [0.7 * a * ea + 0.5 * b * eb for a, ea, b, eb in zip(noise, env_n, body, env_b)]
        n = int(0.05 * sr)
        noise = dsp.white_noise(n, rnd)
        noise = [a - b for a, b in zip(noise, dsp.one_pole_lowpass(noise, sr, 6000.0))]
        self.hat = [a * e for a, e in zip(noise, dsp.decay_envelope(n, sr, 0.012))]
        for name in ("kick", "snare", "hat"):
            buf = getattr(self, name)
            dsp.fade_edges(buf, 8, int(0.004 * sr))
            pk = dsp.peak(buf) or 1.0
            setattr(self, name, dsp.scale(buf, 1.0 / pk))


def _triad(spec: MusicSpec, degree: int) -> List[int]:
    steps = MODES[spec.mode]
    return [spec.tonic + steps[(degree + k) % 7] + 12 * ((degree + k) // 7) for k in (0, 2, 4)]


def _near(pc: int, center: int, lo: int, hi: int) -> int:
    p = center - ((center - pc) % 12)
    if center - p > 6:
        p += 12
    while p < lo:
        p += 12
    while p > hi:
        p -= 12
    return p


def render_music(spec: MusicSpec, check: Callable[[], None]) -> Audio:
    """Render the spec to stereo 16-bit-format audio of exactly ``duration`` seconds."""
    sr = spec.sample_rate
    n = int(round(spec.duration * sr))
    mid = [0.0] * n
    side = [0.0] * n
    beat = 60.0 / spec.bpm
    bar_len = 4.0 * beat
    kit = _Kit(sr, spec.seed)
    pad_table = dsp.wavetable(
        ((1, 1.0), (2, 0.2), (3, 0.05)) if spec.lofi else ((1, 1.0), (2, 0.4), (3, 0.25), (4, 0.1), (6, 0.05))
    )
    lead_table = dsp.wavetable(((1, 1.0), (2, 0.1), (3, 0.03)))
    progressions = PROGRESSIONS["minor" if spec.mode in _MINORISH else "major"]
    neg = (spec.negative_prompt or "").lower()
    used: Dict[str, int] = {}
    for si, sec in enumerate(spec.sections):
        rnd = dsp.seeded(spec.seed, "section", si, sec.name, round(sec.start, 3))
        kind = section_kind(sec.name)
        energy = section_energy(kind, sec.prompt, spec.prompt)
        prog = rnd.choice(progressions)
        text = f"{sec.prompt} {spec.prompt}".lower()
        drums_on = energy >= 0.4 and "drum" not in neg and "no drums" not in text
        bass_on = "bass" not in neg and "no bass" not in text
        lines: List[str] = []
        if not spec.instrumental and spec.lyrics:
            candidates = [b for b in spec.lyrics if b[0] == kind]
            if candidates:
                lines = candidates[used.get(kind, 0) % len(candidates)][1]
                used[kind] = used.get(kind, 0) + 1
        melody_pitch = _near(spec.tonic + MODES[spec.mode][4], 67, 60, 76)
        t = sec.start
        bar = 0
        while t < sec.end - 1e-9:
            check()
            t_end = min(sec.end, t + bar_len)
            a = int(round(t * sr))
            length = max(1, int(round(t_end * sr)) - a)
            chord = _triad(spec, prog[bar % len(prog)])
            # pad: three voices spread across the stereo field
            pad_gain = 0.11 * (0.6 + 0.4 * energy)
            for pitch, pan in zip(chord, (-0.45, 0.0, 0.45)):
                f = dsp.midi_to_hz(_near(pitch % 12, 60, 52, 67))
                seg = dsp.osc(pad_table, f, length, sr, phase=rnd.random())
                dsp.fade_edges(seg, int(0.03 * sr), int(0.06 * sr))
                dsp.add_into(mid, seg, a, pad_gain)
                if pan:
                    dsp.add_into(side, seg, a, pad_gain * pan)
            # bass on the chord root
            if bass_on:
                root = _near(chord[0] % 12, 40, 33, 47)
                step = beat / 2.0 if energy >= 0.7 else beat
                bt = 0.0
                while t + bt < t_end - 1e-9:
                    ba = int(round((t + bt) * sr))
                    bl = max(1, min(int(round(step * 0.9 * sr)), int(round(t_end * sr)) - ba))
                    pitch = root + (12 if energy >= 0.7 and int(round(bt / step)) % 4 == 3 else 0)
                    f = dsp.midi_to_hz(pitch)
                    seg = dsp.osc(dsp.saw_table(f, sr, rolloff=1.6, limit=14), f, bl, sr)
                    seg = list(map(mul, seg, dsp.decay_envelope(bl, sr, 0.35)))
                    dsp.fade_edges(seg, int(0.004 * sr), int(0.02 * sr))
                    dsp.add_into(mid, seg, ba, 0.26 * (0.7 + 0.3 * energy))
                    bt += step
            # drums
            if drums_on:
                g = 0.55 + 0.45 * energy
                hits = [(0.0, kit.kick, 0.9), (2.0, kit.kick, 0.85)]
                if energy >= 0.75:
                    hits.append((2.5, kit.kick, 0.6))
                if energy >= 0.5:
                    hits += [(1.0, kit.snare, 0.55), (3.0, kit.snare, 0.6)]
                hat_step = 0.5 if energy >= 0.55 else 1.0
                hb = 0.0
                while hb < 4.0 - 1e-9:
                    hits.append((hb, kit.hat, 0.22 if (hb * 2) % 2 == 0 else 0.15))
                    hb += hat_step
                for pos, sample, vel in hits:
                    ht = t + pos * beat
                    if ht >= t_end - 1e-9:
                        continue
                    ha = int(round(ht * sr))
                    dsp.add_into(mid, sample, ha, vel * g * 0.6)
                    if sample is kit.hat:
                        dsp.add_into(side, sample, ha, vel * g * 0.25)
            # a hummed line that follows the syllables of this section's lyric lines
            if lines and bar < len(lines) * 2 and bar % 2 == 0:
                line = lines[(bar // 2) % len(lines)]
                syl = max(1, count_syllables(line))
                note_len = min(beat / 2.0, (2.0 * bar_len) / syl)
                chord_pcs = {p % 12 for p in chord}
                scale_pcs = [(spec.tonic + s) % 12 for s in MODES[spec.mode]]
                for k in range(syl):
                    nt = t + k * note_len
                    if nt >= sec.end - 1e-9:
                        break
                    move = rnd.choice((-2, -1, -1, 0, 1, 1, 2))
                    candidates = [p for p in range(58, 79) if p % 12 in scale_pcs]
                    idx = min(range(len(candidates)), key=lambda j: abs(candidates[j] - melody_pitch))
                    melody_pitch = candidates[max(0, min(len(candidates) - 1, idx + move))]
                    if k == 0 and melody_pitch % 12 not in chord_pcs:
                        melody_pitch = _near(next(iter(sorted(chord_pcs))), melody_pitch, 58, 78)
                    la = int(round(nt * sr))
                    ll = max(1, min(int(round(note_len * 0.92 * sr)), n - la))
                    f = dsp.midi_to_hz(melody_pitch)
                    vib = [f * (1.0 + 0.006 * math.sin(2.0 * math.pi * 5.0 * i / sr)) for i in range(ll)]
                    seg = dsp.osc_varying(lead_table, vib, sr, phase=rnd.random())
                    dsp.fade_edges(seg, int(0.015 * sr), int(0.04 * sr))
                    dsp.add_into(mid, seg, la, 0.16 * (0.7 + 0.3 * energy))
            t = t_end
            bar += 1
    left = list(map(add, mid, side))
    right = list(map(sub, mid, side))
    if spec.lofi:
        check()
        hiss_rnd = dsp.seeded(spec.seed, "hiss")
        left = [v + 0.004 * (hiss_rnd.random() - 0.5) for v in dsp.one_pole_lowpass(left, sr, 3200.0)]
        right = [v + 0.004 * (hiss_rnd.random() - 0.5) for v in dsp.one_pole_lowpass(right, sr, 3200.0)]
    return Audio(sr, [left, right], 16, False)


def _match_rms(chans: List[List[float]], target_rms: float, max_db: float = 12.0) -> List[List[float]]:
    cur = dsp.rms_channels(chans)
    if cur <= 1e-9 or target_rms <= 1e-9:
        return chans
    g = max(dsp.db_to_gain(-max_db), min(dsp.db_to_gain(max_db), target_rms / cur))
    return [dsp.scale(ch, g) for ch in chans]


def _as_channels(audio: Audio, count: int) -> List[List[float]]:
    return audio.with_channels(count).channels


MUSIC_CAPABILITIES = [
    "TEXT_TO_MUSIC",
    "AUDIO_TO_AUDIO",
    "LYRIC_CONDITIONING",
    "VOCAL_GENERATION",
    "INSTRUMENTAL_ONLY",
    "SECTION_GENERATION",
    "REFERENCE_AUDIO",
    "STEM_CONDITIONING",
    "INPAINTING",
    "OUTPAINTING",
    "REGION_GENERATION",
]
MUSIC_MODELS = [
    {"id": "mock-additive", "name": "Mock additive synth (Song Deck test bridge)"},
    {"id": "mock-additive-lofi", "name": "Mock additive synth, lo-fi variant"},
]


def build_music_app(opts: MockOptions, common: Dict[str, Any]) -> BridgeApp:
    app = BridgeApp("Song Deck mock music bridge", role="music", **common)
    model_ids = [m["id"] for m in MUSIC_MODELS]

    def resolve_model(body: Dict[str, Any]) -> str:
        model = req_str(body, "model", required=False)
        if not model:
            return opts.music_model
        if model not in model_ids:
            raise NotFound(f"unknown model '{model}' (available: {', '.join(model_ids)})")
        return model

    def key_of(body: Dict[str, Any], prompt: str) -> Tuple[int, str]:
        key = req_str(body, "key", required=False)
        if key:
            parsed = parse_key(key)
            if not parsed:
                raise BadRequest(f"'key': unrecognized key {key!r} (examples: 'E minor', 'F# major', 'Bb', 'D Dorian')")
            return parsed
        return key_from_prompt(prompt)

    def synth(
        sample_rate: int,
        duration: float,
        seed: int,
        prompt: str,
        model: str,
        *,
        bpm: Optional[float] = None,
        key: Optional[Tuple[int, str]] = None,
        sections: Optional[List[Section]] = None,
        negative: str = "",
        lyrics: str = "",
        instrumental: bool = True,
        check: Callable[[], None],
    ) -> Audio:
        tonic, mode = key or key_from_prompt(prompt)
        spec = MusicSpec(
            sample_rate=sample_rate,
            duration=duration,
            seed=seed,
            bpm=bpm or bpm_from_text(prompt) or 100.0,
            tonic=tonic,
            mode=mode,
            sections=sections or [Section("Song", 0.0, duration, "")],
            prompt=prompt,
            negative_prompt=negative,
            lyrics=parse_lyrics(lyrics),
            instrumental=instrumental,
            lofi=model.endswith("lofi"),
        )
        return render_music(spec, check)

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            _info(
                app.name,
                "music",
                MUSIC_MODELS,
                MUSIC_CAPABILITIES,
                default_model=opts.music_model,
                sample_rate=opts.sample_rate,
            )
        )

    @app.job("POST", "/generate")
    def generate(ctx: RequestContext):
        body = ctx.json_object()
        prompt = req_str(body, "prompt")
        negative = req_str(body, "negative_prompt", required=False, default="")
        lyrics = req_str(body, "lyrics", required=False, default="")
        duration = req_number(body, "duration_seconds", exclusive_minimum=0, maximum=opts.max_duration)
        seed, _ = req_seed(body)
        bpm = req_number(body, "bpm", required=False, minimum=20, maximum=400)
        key = key_of(body, prompt)
        sections = parse_sections(req_list(body, "sections", required=False, default=[]), duration)
        guide = req_audio(body, "guide_audio_base64", required=False)
        reference = req_audio(body, "reference_audio_base64", required=False)
        strength = req_number(body, "strength", required=False, default=0.5, minimum=0, maximum=1)
        instrumental = req_bool(body, "instrumental", default=False)
        model = resolve_model(body)

        def work():
            ctx.sleep(opts.delay)
            audio = synth(
                opts.sample_rate,
                duration,
                seed,
                prompt,
                model,
                bpm=bpm,
                key=key,
                sections=sections,
                negative=negative,
                lyrics=lyrics,
                instrumental=instrumental or not lyrics.strip(),
                check=ctx.check_cancelled,
            )
            chans = audio.channels
            pk = dsp.peak_channels(chans)
            if pk > 0:
                chans = [dsp.scale(ch, 0.89 / pk) for ch in chans]  # −1 dBFS
            if guide is not None:  # follow the guide: strength = how far the output may depart from it
                ctx.check_cancelled()
                g = fit_length(resample_audio(guide, opts.sample_rate).with_channels(2), audio.frames)
                chans = [dsp.blend(gc, sc, 1.0 - strength, strength) for gc, sc in zip(g.channels, chans)]
            if reference is not None:  # match the reference's level
                chans = _match_rms(chans, dsp.rms_channels(reference.channels))
            out = audio.like(_protect_peaks(chans))
            return wav_response(write_wav(out, bits=16), seed=seed, model=model)

        return work

    @app.job("POST", "/transform")
    def transform(ctx: RequestContext):
        body = ctx.json_object()
        audio = req_audio(body, "audio_base64")
        prompt = req_str(body, "prompt")
        strength = req_number(body, "strength", minimum=0, maximum=1)
        seed, _ = req_seed(body)
        model = resolve_model(body)
        _check_length(audio, opts)

        def work():
            ctx.sleep(opts.delay)
            new = synth(
                audio.sample_rate, audio.frames / audio.sample_rate, seed, prompt, model, check=ctx.check_cancelled
            )
            new_ch = _match_rms(_as_channels(new, audio.num_channels), dsp.rms_channels(audio.channels))
            src = audio.channels
            if re.search(r"\b(warm|dark|lo-?fi|muffled|vintage)\b", prompt, re.I):
                src = [dsp.tilt(ch, audio.sample_rate, -0.8) for ch in src]
            elif re.search(r"\b(bright|airy|crisp|sparkl\w*)\b", prompt, re.I):
                src = [dsp.tilt(ch, audio.sample_rate, 0.8) for ch in src]
            mixed = [dsp.blend(s, m, 1.0 - strength, strength) for s, m in zip(src, new_ch)]
            out = audio.like(_protect_peaks(mixed, 0.999))
            return wav_response(write_wav(out), seed=seed, model=model)

        return work

    @app.job("POST", "/inpaint")
    def inpaint(ctx: RequestContext):
        body = ctx.json_object()
        audio = req_audio(body, "audio_base64")
        start = req_number(body, "start_seconds", minimum=0)
        end = req_number(body, "end_seconds", minimum=0)
        prompt = req_str(body, "prompt")
        seed, _ = req_seed(body)
        model = resolve_model(body)
        _check_length(audio, opts)
        if end <= start:
            raise BadRequest("'end_seconds' must be greater than 'start_seconds'")
        if start >= audio.duration:
            raise BadRequest(f"'start_seconds' ({start}) is beyond the end of the audio ({audio.duration:.3f} s)")

        def work():
            ctx.sleep(opts.delay)
            sr = audio.sample_rate
            s = int(round(start * sr))
            e = min(audio.frames, int(round(end * sr)))
            length = e - s
            new = synth(sr, length / sr, seed, prompt, model, check=ctx.check_cancelled)
            region_rms = dsp.rms_channels([ch[s:e] for ch in audio.channels])
            if region_rms < 1e-6:  # silent region: use the surroundings' level
                region_rms = dsp.rms_channels([ch[max(0, s - sr) : min(audio.frames, e + sr)] for ch in audio.channels])
            new_ch = _protect_peaks(_match_rms(_as_channels(new, audio.num_channels), region_rms), 0.999)
            xf = min(int(0.02 * sr), length // 4)
            w = dsp.crossfade_weights(xf)
            out = []
            for ch, region in zip(audio.channels, new_ch):
                region = list(region)
                for i in range(xf):  # crossfades stay INSIDE the range: everything outside is untouched
                    region[i] = ch[s + i] * (1.0 - w[i]) + region[i] * w[i]
                    j = length - 1 - i
                    region[j] = ch[s + j] * (1.0 - w[i]) + region[j] * w[i]
                out.append(ch[:s] + region + ch[e:])
            return wav_response(
                write_wav(audio.like(out)), seed=seed, model=model
            )  # same format → untouched samples are bit-identical

        return work

    @app.job("POST", "/extend")
    def extend(ctx: RequestContext):
        body = ctx.json_object()
        audio = req_audio(body, "audio_base64")
        prompt = req_str(body, "prompt")
        seconds = req_number(body, "duration_seconds", exclusive_minimum=0, maximum=opts.max_duration)
        seed, _ = req_seed(body)
        model = resolve_model(body)
        _check_length(audio, opts)

        def work():
            ctx.sleep(opts.delay)
            sr = audio.sample_rate
            new = synth(sr, seconds, seed, prompt, model, check=ctx.check_cancelled)
            tail_rms = dsp.rms_channels([ch[-2 * sr :] for ch in audio.channels]) or 0.2
            new_ch = _protect_peaks(_match_rms(_as_channels(new, audio.num_channels), tail_rms), 0.999)
            fade = int(0.03 * sr)
            out = []
            for ch, ext in zip(audio.channels, new_ch):
                ext = dsp.fade_edges(list(ext), fade, 0)
                out.append(ch + ext)
            return wav_response(write_wav(audio.like(out)), seed=seed, model=model)

        return work

    return app


# ===========================================================================
# Singing
# ===========================================================================

SINGING_VOICES = [
    {"id": "mock-soprano", "name": "Mock Soprano (sine)", "voice_type": "soprano", "language": "en", "kind": "stock"},
    {"id": "mock-tenor", "name": "Mock Tenor (sawtooth)", "voice_type": "tenor", "language": "en", "kind": "stock"},
]
_ONSETS = {"soft": 0.06, "normal": 0.025, "hard": 0.006, "scoop": 0.03}
_RELEASES = {"normal": 0.04, "falling": 0.08, "rising": 0.06, "breathy": 0.1, "cut": 0.005}


def synth_note(note: SungNote, sr: int, voice_id: str, seed: int, glide_from: Optional[float]) -> List[float]:
    """One sung note: tone at the note pitch, vibrato, onset/release shapes, breath noise."""
    n = max(1, int(round(note.duration * sr)))
    e = note.expression
    f0 = dsp.midi_to_hz(note.pitch)
    rnd = dsp.seeded(seed, "note", round(note.start, 4), round(note.pitch, 3))
    depth = 2.0 ** (0.5 * float(e.get("vibrato", 0.25)) / 12.0) - 1.0  # vibrato 1.0 = ±½ semitone
    w = 2.0 * math.pi * float(e.get("vibrato_rate", 5.5)) / sr
    ph = rnd.random() * 2.0 * math.pi
    delay, ramp = int(0.15 * sr), int(0.15 * sr)
    freqs = [
        f0
        * (
            1.0
            + depth * math.sin(w * i + ph) * (0.0 if i < delay else (1.0 if i >= delay + ramp else (i - delay) / ramp))
        )
        for i in range(n)
    ]
    onset = str(e.get("onset", "normal"))
    release = str(e.get("release", "normal"))
    if glide_from is not None or onset == "scoop":
        k = min(n, int((0.06 if glide_from is not None else 0.08) * sr))
        r0 = 2.0 ** (((glide_from - note.pitch) if glide_from is not None else -1.0) / 12.0)
        for i in range(k):
            freqs[i] *= r0 + (1.0 - r0) * (i / k)
    if release in ("falling", "rising"):
        k = min(n, int(0.12 * sr))
        r1 = 2.0 ** ((-2.0 if release == "falling" else 1.0) / 12.0)
        for i in range(k):
            freqs[n - k + i] *= 1.0 + (r1 - 1.0) * (i / k)
    if voice_id == "mock-tenor":
        table = dsp.saw_table(f0, sr, rolloff=1.8 - 0.6 * float(e.get("tension", 0.4)), limit=40)
    else:
        table = dsp.wavetable(((1, 1.0), (2, 0.12), (3, 0.04)))
    seg = dsp.osc_varying(table, freqs, sr, phase=rnd.random())
    gain = 0.5 * (note.velocity / 127.0) ** 1.2 * (0.55 + 0.45 * float(e.get("energy", 0.7)))
    attack = 0.004 if glide_from is not None else _ONSETS.get(onset, 0.025)
    rel = _RELEASES.get(release, 0.04)
    seg = dsp.scale(seg, gain)
    breath = float(e.get("breathiness", 0.1))
    if breath > 0.01:
        noise = dsp.white_noise(n, rnd)
        noise = [a - b for a, b in zip(noise, dsp.one_pole_lowpass(noise, sr, 1200.0))]
        level = breath * 0.3 * gain
        if release == "breathy":
            seg = [v + level * x * (1.0 + 2.0 * i / n) for i, (v, x) in enumerate(zip(seg, noise))]
        else:
            seg = [v + level * x for v, x in zip(seg, noise)]
    return dsp.fade_edges(seg, int(attack * sr), int(rel * sr))


def render_singing(
    notes: List[SungNote], sr: int, voice_id: str, seed: int, t0: float, frames: int, check: Callable[[], None]
) -> List[float]:
    """Mono buffer covering [t0, t0 + frames/sr); notes are rendered whole and clipped to the window,
    so a phrase render equals the same slice of a full render (same seed)."""
    out = [0.0] * frames
    t1 = t0 + frames / sr
    prev_pitch: Optional[float] = None
    for i, note in enumerate(sorted(notes, key=lambda nt: nt.start)):
        if i % 8 == 0:
            check()
        legato = note.is_melisma  # "_": glide from the previous note, no new attack
        if note.end > t0 and note.start < t1:
            seg = synth_note(note, sr, voice_id, seed, prev_pitch if legato else None)
            dsp.add_into(out, seg, int(round(note.start * sr)) - int(round(t0 * sr)))
        prev_pitch = note.pitch
    return out


def build_singing_app(opts: MockOptions, common: Dict[str, Any]) -> BridgeApp:
    app = BridgeApp("Song Deck mock singing bridge", role="singing", **common)
    voices = {v["id"]: v for v in SINGING_VOICES}

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            _info(
                app.name,
                "singing",
                [{"id": "mock-singer", "name": "Mock singer (sine/sawtooth tones)"}],
                ["SINGING_SYNTHESIS", "MIDI_CONDITIONING", "LYRIC_CONDITIONING", "REGION_GENERATION"],
                voices=SINGING_VOICES,
            )
        )

    @app.route("GET", "/voices")
    def list_voices(ctx: RequestContext):
        return json_response(SINGING_VOICES)

    def render(ctx: RequestContext, job: SingingJob):
        ctx.sleep(opts.delay)
        t0, _ = job.window
        mono = render_singing(job.notes, job.sample_rate, job.voice_id, job.seed, t0, job.frames(), ctx.check_cancelled)
        return wav_response(
            write_wav(Audio(job.sample_rate, [mono], 16)),
            seed=job.seed,
            model="mock-singer",
            headers={"X-Voice-Id": job.voice_id},
        )

    @app.job("POST", "/synthesize")
    def synthesize(ctx: RequestContext):
        job = parse_singing_request(ctx.json_object(), phrase=False, voice_ids=voices, max_duration=opts.max_duration)
        return lambda: render(ctx, job)  # covers 0 … end of the last note

    @app.job("POST", "/regenerate_phrase")
    def regenerate_phrase(ctx: RequestContext):
        job = parse_singing_request(ctx.json_object(), phrase=True, voice_ids=voices, max_duration=opts.max_duration)
        return lambda: render(ctx, job)  # covers ONLY [start_seconds, end_seconds]

    return app


# ===========================================================================
# Transcription
# ===========================================================================

#: f0 search range per source (Hz). Narrow ranges keep the pure-Python tracker fast.
PITCH_RANGES = {
    "bass": (30.0, 400.0),
    "vocals": (70.0, 1100.0),
    "melody": (70.0, 1100.0),
    "guitar": (75.0, 1100.0),
    "piano": (40.0, 1050.0),
    "mix": (55.0, 1000.0),
    "other": (55.0, 1000.0),
}


def build_transcription_app(opts: MockOptions, common: Dict[str, Any]) -> BridgeApp:
    app = BridgeApp("Song Deck mock transcription bridge", role="transcription", **common)

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            _info(
                app.name,
                "transcription",
                [{"id": "mock-autocorrelation", "name": "Mock autocorrelation pitch tracker (monophonic)"}],
                ["AUDIO_TRANSCRIPTION", "AUDIO_TO_MIDI", "PITCH_TRACKING"],
                sources=sorted(list(PITCH_RANGES) + ["drums"]),
            )
        )

    @app.job("POST", "/transcribe")
    def transcribe(ctx: RequestContext):
        body = ctx.json_object()
        audio = req_audio(body, "audio_base64")
        source = (req_str(body, "source", required=False, default="mix") or "mix").strip().lower()
        if source not in PITCH_RANGES and source != "drums":
            source = "other"
        _check_length(audio, opts)

        def work():
            ctx.sleep(opts.delay)
            x = audio.mono()
            if source == "drums":
                notes = dsp.drum_hits(x, audio.sample_rate, ctx.check_cancelled)
            else:
                fmin, fmax = PITCH_RANGES[source]
                track = dsp.track_pitch(x, audio.sample_rate, fmin, fmax, check=ctx.check_cancelled)
                notes = dsp.notes_from_pitch(track)
            result: Dict[str, Any] = {"notes": notes}
            tempo = dsp.estimate_tempo([n["start"] for n in notes])
            if tempo:
                result["tempo"] = tempo
            if source != "drums":
                key = dsp.estimate_key(notes)
                if key:
                    result["key"] = key[0]
            return json_response(result, headers={"X-Model": "mock-autocorrelation"})

        return work

    return app


# ===========================================================================
# Separation
# ===========================================================================

STEMS_4 = ["drums", "bass", "vocals", "other"]
STEMS_6 = STEMS_4 + ["guitar", "piano"]
CROSSOVERS = [150.0, 300.0, 3400.0, 8000.0]  # → low | low-mid | mid | high | top


def _band_stems(
    bands_mid: List[List[float]], bands_side: Optional[List[List[float]]], six: bool
) -> Dict[str, Tuple[List[float], Optional[List[float]]]]:
    """Assign bands to stems as (mid part, side part). The parts of all stems sum to the input."""
    low, lowmid, midb, high, top = bands_mid
    zero = [0.0] * len(low)
    s = bands_side

    def plus(*xs: List[float]) -> List[float]:
        out = list(xs[0])
        for x in xs[1:]:
            out = list(map(add, out, x))
        return out

    if not six:
        return {
            "bass": (low, s[0] if s else None),
            "vocals": (midb, zero if s else None),  # vocals ≈ the centred speech band
            "other": (plus(lowmid, high), plus(s[1], s[2], s[3]) if s else None),
            "drums": (top, s[4] if s else None),
        }
    return {
        "bass": (low, s[0] if s else None),
        "piano": (lowmid, s[1] if s else None),
        "vocals": (midb, zero if s else None),
        "guitar": (zero, s[2] if s else None),  # the side (wide) part of the mid band
        "other": (high, s[3] if s else None),
        "drums": (top, s[4] if s else None),
    }


def build_separation_app(opts: MockOptions, common: Dict[str, Any]) -> BridgeApp:
    app = BridgeApp("Song Deck mock separation bridge", role="separation", **common)

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            _info(
                app.name,
                "separation",
                [
                    {"id": "mock-bandsplit-4", "name": "Mock band split (4 stems)"},
                    {"id": "mock-bandsplit-6", "name": "Mock band split (6 stems)"},
                ],
                ["SOURCE_SEPARATION", "VOCAL_ISOLATION", "STEM_OUTPUT"],
                stems=STEMS_6,
            )
        )

    @app.job("POST", "/separate")
    def separate(ctx: RequestContext):
        body = ctx.json_object()
        audio = req_audio(body, "audio_base64")
        raw = req_list(body, "stems", required=False, default=None) or list(STEMS_4)
        stems: List[str] = []
        for i, s in enumerate(raw):
            if not isinstance(s, str) or s.strip().lower() not in STEMS_6:
                raise BadRequest(f"stems[{i}]: unknown stem {s!r} (supported: {', '.join(STEMS_6)})")
            if s.strip().lower() not in stems:
                stems.append(s.strip().lower())
        _check_length(audio, opts)

        def work():
            ctx.sleep(opts.delay)
            six = any(s in ("guitar", "piano") for s in stems)
            sr = audio.sample_rate
            per_channel: List[Dict[str, List[float]]] = []
            if audio.num_channels == 2:
                left, right = audio.channels
                mid = dsp.blend(left, right, 0.5, 0.5)
                side = dsp.blend(left, right, 0.5, -0.5)
                bm = dsp.split_bands(mid, sr, CROSSOVERS)
                ctx.check_cancelled()
                bs = dsp.split_bands(side, sr, CROSSOVERS)
                parts = _band_stems(bm, bs, six)
                lchan = {k: list(map(add, pm, ps)) for k, (pm, ps) in parts.items()}
                rchan = {k: list(map(sub, pm, ps)) for k, (pm, ps) in parts.items()}
                per_channel = [lchan, rchan]
            else:
                for ch in audio.channels:
                    ctx.check_cancelled()
                    parts = _band_stems(dsp.split_bands(ch, sr, CROSSOVERS), None, six)
                    per_channel.append({k: pm for k, (pm, _) in parts.items()})
            ctx.check_cancelled()
            out: Dict[str, str] = {}
            for name in stems:
                out[name] = encode_base64(write_wav(Audio(sr, [pc[name] for pc in per_channel], 32, True)))
            if len(stems) == 1:  # Demucs --two-stems convention: the requested stem + everything else
                name = stems[0]
                rest = [list(map(sub, ch, pc[name])) for ch, pc in zip(audio.channels, per_channel)]
                out[f"no_{name}"] = encode_base64(write_wav(Audio(sr, rest, 32, True)))
            model = "mock-bandsplit-6" if six else "mock-bandsplit-4"
            return json_response({"stems": out, "model": model}, headers={"X-Model": model})

        return work

    return app


# ===========================================================================
# Voice conversion
# ===========================================================================

VC_VOICES = [
    {"id": "mock-alto", "name": "Mock Alto (bright)", "voice_type": "alto", "language": "en", "kind": "stock"},
    {
        "id": "mock-baritone",
        "name": "Mock Baritone (dark)",
        "voice_type": "baritone",
        "language": "en",
        "kind": "stock",
    },
    {
        "id": "mock-user-voice",
        "name": "My trained voice (mock example)",
        "voice_type": "tenor",
        "language": "en",
        "kind": "user-trained",
    },
]
_VC_TILT = {"mock-alto": 0.6, "mock-baritone": -0.6, "mock-user-voice": 0.0}


def build_voice_conversion_app(opts: MockOptions, common: Dict[str, Any]) -> BridgeApp:
    app = BridgeApp("Song Deck mock voice-conversion bridge", role="voice-conversion", **common)
    voices = {v["id"]: v for v in VC_VOICES}

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            _info(
                app.name,
                "voice-conversion",
                [{"id": "mock-voice-conversion", "name": "Mock voice conversion (pitch shift + tone colour)"}],
                ["VOICE_CONVERSION"],
                voices=VC_VOICES,
            )
        )

    @app.route("GET", "/voices")
    def list_voices(ctx: RequestContext):
        return json_response(VC_VOICES)

    @app.job("POST", "/convert")
    def convert(ctx: RequestContext):
        body = ctx.json_object()
        audio = req_audio(body, "audio_base64")
        voice_id = req_str(body, "target_voice_id", allow_empty=False)
        if voice_id not in voices:
            raise NotFound(f"unknown target_voice_id '{voice_id}' (available: {', '.join(voices)})")
        shift = req_number(body, "pitch_shift", required=False, default=0.0, minimum=-36, maximum=36)
        _check_length(audio, opts)

        def work():
            ctx.sleep(opts.delay)
            chans = []
            for ch in audio.channels:
                ctx.check_cancelled()
                y = dsp.pitch_shift(ch, audio.sample_rate, shift)
                chans.append(dsp.tilt(y, audio.sample_rate, _VC_TILT.get(voice_id, 0.0)))
            out = audio.like(_protect_peaks(chans, 0.999))
            return wav_response(write_wav(out), seed=0, model="mock-voice-conversion", headers={"X-Voice-Id": voice_id})

        return work

    return app


# ===========================================================================
# Mastering
# ===========================================================================


def build_mastering_app(opts: MockOptions, common: Dict[str, Any]) -> BridgeApp:
    app = BridgeApp("Song Deck mock mastering bridge", role="mastering", **common)

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            _info(
                app.name,
                "mastering",
                [{"id": "mock-mastering", "name": "Mock loudness mastering (BS.1770 + limiter)"}],
                ["MASTERING", "REFERENCE_AUDIO"],
                targets=dsp.MASTERING_TARGETS,
            )
        )

    @app.job("POST", "/master")
    def master(ctx: RequestContext):
        body = ctx.json_object()
        audio = req_audio(body, "audio_base64")
        target = req_str(body, "target", choices=list(dsp.MASTERING_TARGETS))
        reference = req_audio(body, "reference_audio_base64", required=False)
        _check_length(audio, opts)

        def work():
            ctx.sleep(opts.delay)
            out, report = dsp.master(audio, target, reference, ctx.check_cancelled)
            bits = int(dsp.MASTERING_TARGETS[target]["bits"])
            wav = write_wav(out, bits=bits, dither=bits == 16, seed=0)
            headers = {
                "X-Integrated-LUFS": f"{report['output_lufs']:.2f}",
                "X-Gain-dB": f"{report['gain_db']:.2f}",
                "X-Target-LUFS": f"{report['target_lufs']:.2f}",
            }
            return wav_response(wav, seed=0, model="mock-mastering", headers=headers)

        return work

    return app


BUILDERS: Dict[str, Callable[[MockOptions, Dict[str, Any]], BridgeApp]] = {
    "music": build_music_app,
    "singing": build_singing_app,
    "separation": build_separation_app,
    "transcription": build_transcription_app,
    "voice-conversion": build_voice_conversion_app,
    "mastering": build_mastering_app,
}


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser(
        "Song Deck mock bridge: implements every local-model contract with deterministic stdlib DSP (no ML models).",
        None,
        prog="mock_bridge.py",
        epilog="Ports follow the Song Deck presets: " + ", ".join(f"{r} {p}" for r, (p, _) in ROLES.items()) + ".",
    )
    m = parser.add_argument_group("mock")
    m.add_argument(
        "--role",
        choices=list(ROLES) + ["all"],
        default="music",
        help="which bridge to run (default music); 'all' runs every role",
    )
    m.add_argument(
        "--base-port",
        type=int,
        default=8810,
        help="with --role all: first port; roles use base+0 … base+5 in preset order "
        "(music, singing, separation, transcription, voice-conversion, mastering); 0 = any free ports",
    )
    m.add_argument("--sample-rate", type=int, default=44100, help="sample rate of generated music (default 44100)")
    m.add_argument(
        "--max-duration", type=float, default=600.0, help="longest audio accepted/generated in seconds (default 600)"
    )
    m.add_argument(
        "--delay",
        type=float,
        default=0.0,
        help="simulated engine latency per job in seconds (cancellable; for testing cancel flows)",
    )
    args = parser.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    if not 8000 <= args.sample_rate <= 192000:
        fail("--sample-rate must be between 8000 and 192000")
    if args.model and args.model not in [x["id"] for x in MUSIC_MODELS]:
        fail(f"--model must be one of: {', '.join(x['id'] for x in MUSIC_MODELS)}")
    opts = MockOptions(
        sample_rate=args.sample_rate,
        max_duration=max(1.0, args.max_duration),
        delay=max(0.0, args.delay),
        music_model=args.model or "mock-additive",
    )
    common = app_options(args)
    roles = list(ROLES) if args.role == "all" else [args.role]
    bindings = []
    for role in roles:
        app = BUILDERS[role](opts, common)
        if args.role == "all":
            port = 0 if args.base_port == 0 else args.base_port + (ROLES[role][0] - 8810)
        else:
            port = args.port if args.port is not None else ROLES[role][0]
        bindings.append((app, args.host, port))
    return serve(bindings)


if __name__ == "__main__":
    sys.exit(main())
