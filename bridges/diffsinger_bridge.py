#!/usr/bin/env python3
"""
Song Deck SINGING bridge for DiffSinger (OpenVPI) — reference implementation.

Contract (packages/ai/src/contracts.ts, SINGING_BRIDGE_PATHS)::

    GET  /voices             → [{"id", "name", "voice_type", "language", "kind"}]
    POST /synthesize         SingingBridgeRequest       → audio/wav covering 0 … end of the last note
    POST /regenerate_phrase  SingingBridgePhraseRequest → audio/wav covering ONLY [start_seconds, end_seconds]
    GET  /info · GET /health · POST /cancel

How it works
------------
1. The contract notes become an OpenVPI DiffSinger ``.ds`` project: a JSON list with one segment
   per phrase (``offset``, ``text``, ``ph_seq``, ``ph_dur``, ``ph_num``, ``note_seq``,
   ``note_dur``, ``note_slur``, ``f0_seq``, ``f0_timestep``, ``seed``):

   * phonemes — the note's ``phonemes`` when given (ARPAbet-like; stress digits dropped), else a
     ``--dictionary`` entry for the syllable (DiffSinger dictionary format ``syllable<TAB>ph ph``,
     which is how non-English voicebanks work), else a tiny English G2P (lexicon of common lyric
     words + letter rules). ``--phoneme-map`` / ``--phoneme-prefix`` rename them to the
     voicebank's phoneme set (e.g. ``en/aa``).
   * durations — onset consonants sit BEFORE the note onset so the vowel lands on the beat (the
     DiffSinger convention); codas end the note; vowels fill the rest. Consonant lengths come from
     their class (stops 50 ms, nasals/liquids 60 ms, affricates 70 ms, fricatives 80 ms) and shrink
     to fit short notes.
   * pitch — an f0 curve every 5 ms from the note pitches, with short legato glides and the
     per-note vibrato depth/rate from ``expression``. ``_`` (melisma) notes extend the previous
     vowel (``note_slur`` = 1). Other expression values are not mapped (acoustic models differ in
     which variance curves they accept — add ``breathiness``/``energy`` curves in ``build_ds`` if
     yours does).
2. The configured inference command runs in ``--diffsinger-root``; the default is::

       {python} scripts/infer.py acoustic {ds} --exp {exp} --out {out}

   Placeholders: {python} {ds} {exp} {out} {title} {seed} {spk} {voice} {device}. An optional
   ``--variance-command`` (e.g. ``{python} scripts/infer.py variance {ds} --exp {variance_exp}
   --out {out}``) runs first and its ``.ds`` output feeds the acoustic command.
3. The WAV is trimmed/padded to exactly the contract range (a pre-roll of ``--lead-in`` seconds
   lets consonants start before t = 0) and resampled to the requested ``sample_rate``.

Install and run
---------------
::

    git clone https://github.com/openvpi/DiffSinger && cd DiffSinger && pip install -r requirements.txt
    # put an acoustic model (experiment folder) + vocoder in checkpoints/ as the DiffSinger docs describe
    python3 bridges/diffsinger_bridge.py --diffsinger-root ~/DiffSinger --exp my_acoustic_exp \\
        --voice my-voice:"My voice":soprano:en            # http://127.0.0.1:8811

Check the generated project without running inference::

    python3 bridges/diffsinger_bridge.py --print-ds request.json      # a SingingBridgeRequest body

In Song Deck: Settings → Providers → Add provider → Singing synthesis → "DiffSinger (local)".

This is REFERENCE code (not exercised in Song Deck's CI). ``build_ds()`` (contract → .ds) and
``run_inference()`` (the command) are the functions to adapt to your DiffSinger version/voicebank.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__  # noqa: E402
from songdeck_bridge.cli import app_options, build_parser, check_bind, fail, serve, setup_logging  # noqa: E402
from songdeck_bridge.server import BridgeApp, EngineError, HTTPError, RequestContext, command_from_template, json_response, run_command, wav_response  # noqa: E402
from songdeck_bridge.singing import SingingJob, SungNote, parse_singing_request  # noqa: E402
from songdeck_bridge.wav import WavError, fit_length, read_wav, resample_audio, write_wav  # noqa: E402

DEFAULT_PORT = 8811
DEFAULT_COMMAND = "{python} scripts/infer.py acoustic {ds} --exp {exp} --out {out}"
PLACEHOLDERS = ("python", "ds", "exp", "out", "title", "seed", "spk", "voice", "device", "variance_exp")
F0_STEP = 0.005

# ---------------------------------------------------------------------------
# Tiny English G2P (ARPAbet without stress, lowercase)
# ---------------------------------------------------------------------------

ARPABET_VOWELS = frozenset("aa ae ah ao aw ay eh er ey ih iy ow oy uh uw".split())
_STOPS = frozenset("p b t d k g".split())
_AFFRICATES = frozenset("ch jh".split())
_FRICATIVES = frozenset("f v th dh s z sh zh hh".split())

LEXICON: Dict[str, str] = {
    "a": "ah", "i": "ay", "an": "ae n", "the": "dh ah", "you": "y uw", "your": "y ao r", "you're": "y uh r", "me": "m iy",
    "my": "m ay", "we": "w iy", "us": "ah s", "our": "aw er", "he": "hh iy", "she": "sh iy", "it": "ih t", "it's": "ih t s",
    "is": "ih z", "was": "w ah z", "be": "b iy", "are": "aa r", "am": "ae m", "i'm": "ay m", "and": "ae n d", "or": "ao r",
    "of": "ah v", "to": "t uw", "too": "t uw", "two": "t uw", "do": "d uw", "in": "ih n", "into": "ih n t uw", "on": "aa n",
    "at": "ae t", "so": "s ow", "no": "n ow", "go": "g ow", "oh": "ow", "ooh": "uw", "ah": "aa", "la": "l aa", "na": "n aa",
    "yeah": "y eh", "love": "l ah v", "heart": "hh aa r t", "night": "n ay t", "tonight": "t ah n ay t", "light": "l ay t",
    "lights": "l ay t s", "fire": "f ay er", "sky": "s k ay", "home": "hh ow m", "time": "t ay m", "life": "l ay f",
    "walk": "w ao k", "alone": "ah l ow n", "lone": "l ow n", "through": "th r uw", "water": "w ao t er", "carry": "k ae r iy",
    "count": "k aw n t", "counting": "k aw n t ih ng", "come": "k ah m", "some": "s ah m", "one": "w ah n", "what": "w ah t",
    "where": "w eh r", "there": "dh eh r", "their": "dh eh r", "here": "hh iy r", "know": "n ow", "now": "n aw", "how": "hh aw",
    "down": "d aw n", "town": "t aw n", "all": "ao l", "call": "k ao l", "fall": "f ao l", "never": "n eh v er",
    "ever": "eh v er", "forever": "f er eh v er", "baby": "b ey b iy", "dream": "d r iy m", "dreams": "d r iy m z",
    "eyes": "ay z", "world": "w er l d", "feel": "f iy l", "free": "f r iy", "see": "s iy", "again": "ah g eh n",
    "away": "ah w ey", "day": "d ey", "way": "w ey", "say": "s ey", "stay": "s t ey", "rain": "r ey n", "pain": "p ey n",
    "sun": "s ah n", "run": "r ah n", "want": "w aa n t", "need": "n iy d", "can": "k ae n", "can't": "k ae n t",
    "don't": "d ow n t", "won't": "w ow n t", "with": "w ih dh", "without": "w ih dh aw t", "from": "f r ah m", "for": "f ao r",
    "this": "dh ih s", "that": "dh ae t", "these": "dh iy z", "those": "dh ow z", "they": "dh ey", "them": "dh eh m",
    "when": "w eh n", "why": "w ay", "who": "hh uw", "up": "ah p", "out": "aw t", "hold": "hh ow l d", "hand": "hh ae n d",
    "hands": "hh ae n d z", "sing": "s ih ng", "song": "s ao ng", "gone": "g ao n", "long": "l ao ng", "strong": "s t r ao ng",
    "wrong": "r ao ng", "head": "hh eh d", "said": "s eh d", "good": "g uh d", "could": "k uh d", "would": "w uh d",
    "should": "sh uh d", "look": "l uh k", "take": "t ey k", "make": "m ey k", "break": "b r ey k", "blue": "b l uw",
    "true": "t r uw", "star": "s t aa r", "stars": "s t aa r z", "moon": "m uw n", "soul": "s ow l", "cold": "k ow l d",
    "old": "ow l d", "tears": "t ih r z", "fly": "f l ay", "high": "hh ay", "cry": "k r ay", "try": "t r ay", "die": "d ay",
    "lie": "l ay", "mind": "m ay n d", "find": "f ay n d", "kind": "k ay n d", "music": "m y uw z ih k", "ocean": "ow sh ah n",
}

_GRAPHEMES: List[Tuple[str, List[str]]] = [  # longest first
    ("tch", ["ch"]), ("igh", ["ay"]), ("eigh", ["ey"]), ("augh", ["ao"]), ("ough", ["ow"]), ("sch", ["s", "k"]),
    ("ch", ["ch"]), ("sh", ["sh"]), ("th", ["th"]), ("ph", ["f"]), ("wh", ["w"]), ("ck", ["k"]), ("ng", ["ng"]),
    ("qu", ["k", "w"]), ("gh", []), ("kn", ["n"]), ("wr", ["r"]), ("ee", ["iy"]), ("ea", ["iy"]), ("oo", ["uw"]),
    ("ou", ["aw"]), ("oi", ["oy"]), ("oy", ["oy"]), ("ai", ["ey"]), ("ay", ["ey"]), ("au", ["ao"]), ("aw", ["ao"]),
    ("ei", ["ey"]), ("ey", ["ey"]), ("ie", ["iy"]), ("ue", ["uw"]), ("ew", ["uw"]), ("oa", ["ow"]), ("ow", ["ow"]),
    ("er", ["er"]), ("ir", ["er"]), ("ur", ["er"]), ("ar", ["aa", "r"]), ("or", ["ao", "r"]),
]
_GRAPHEMES.sort(key=lambda g: -len(g[0]))
_LETTERS = {"b": "b", "c": "k", "d": "d", "f": "f", "g": "g", "h": "hh", "j": "jh", "k": "k", "l": "l", "m": "m", "n": "n",
            "p": "p", "q": "k", "r": "r", "s": "s", "t": "t", "v": "v", "w": "w", "z": "z"}
_SHORT = {"a": "ae", "e": "eh", "i": "ih", "o": "aa", "u": "ah", "y": "ih"}
_LONG = {"a": "ey", "e": "iy", "i": "ay", "o": "ow", "u": "uw", "y": "ay"}


def g2p_word(word: str) -> List[str]:
    """English word → ARPAbet (lexicon first, then letter rules). Good enough for a reference bridge."""
    w = re.sub(r"[^a-z']", "", word.lower())
    if not w:
        return []
    if w in LEXICON:
        return LEXICON[w].split()
    w = w.replace("'", "")
    magic = len(w) >= 3 and w[-1] == "e" and w[-2] not in "aeiouy" and w[-3] in "aeiouy"
    body = w[:-1] if w.endswith("e") and len(w) > 2 and any(c in "aeiouy" for c in w[:-1]) else w
    vowel_groups = len(re.findall(r"[aeiouy]+", body))
    out: List[str] = []
    i = 0
    while i < len(body):
        c = body[i]
        if i + 1 < len(body) and body[i + 1] == c and c not in "aeiouy":
            i += 1  # doubled consonant
            continue
        hit = None
        for g, ph in _GRAPHEMES:
            if body.startswith(g, i) and not (g in ("kn", "wr") and i != 0):
                hit = (g, ["aw"] if g == "ow" and i + 2 < len(body) else ph)
                break
        if hit:
            out += hit[1]
            i += len(hit[0])
            continue
        if c in "aeiouy":
            if c == "y" and i == 0:
                out.append("y")
            elif c == "y" and i == len(body) - 1:
                out.append("iy" if vowel_groups > 1 else "ay")
            else:
                out.append(_LONG[c] if magic and i == len(body) - 2 else _SHORT[c])
        elif c == "c":
            out.append("s" if i + 1 < len(body) and body[i + 1] in "eiy" else "k")
        elif c == "g":
            out.append("jh" if 0 < i < len(body) - 1 and body[i + 1] in "eiy" else "g")
        elif c == "x":
            out += ["k", "s"]
        elif c == "s" and 0 < i < len(body) - 1 and body[i - 1] in "aeiou" and body[i + 1] in "aeiou":
            out.append("z")
        elif c in _LETTERS:
            out.append(_LETTERS[c])
        i += 1
    if not any(p in ARPABET_VOWELS for p in out):
        out.append("ah")
    return out


def consonant_seconds(ph: str) -> float:
    base = ph.split("/")[-1].lower()
    if base in _STOPS:
        return 0.05
    if base in _AFFRICATES:
        return 0.07
    if base in _FRICATIVES:
        return 0.08
    return 0.06


# ---------------------------------------------------------------------------
# Contract notes → .ds segments
# ---------------------------------------------------------------------------

_NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def note_name(midi: float) -> str:
    m = int(round(midi))
    return f"{_NOTE_NAMES[m % 12]}{m // 12 - 1}"


@dataclass
class Phonology:
    """Phoneme lookup/mapping configuration (see --dictionary, --phoneme-map, --phoneme-prefix, --vowels)."""

    dictionary: Dict[str, List[str]] = field(default_factory=dict)
    phoneme_map: Dict[str, str] = field(default_factory=dict)
    prefix: str = ""
    vowels: frozenset = ARPABET_VOWELS

    def syllable(self, note: SungNote) -> List[str]:
        if note.phonemes:  # ARPAbet-like from Song Deck: "AH0" → "ah"
            return [re.sub(r"\d$", "", p).lower() if re.fullmatch(r"[A-Za-z]+\d?", p) else p for p in note.phonemes]
        text = re.sub(r"[^\w']", "", note.lyric.strip().strip("-").lower())
        if not text:
            return ["aa"]
        if text in self.dictionary:
            return list(self.dictionary[text])
        return g2p_word(text)

    def split(self, phs: List[str]) -> Tuple[List[str], str, List[str]]:
        """(onset consonants, vowel, coda). Without a known vowel, the last phoneme is the nucleus (CV syllables)."""
        for i, p in enumerate(phs):
            if p.split("/")[-1].lower() in self.vowels:
                return phs[:i], p, phs[i + 1:]
        return phs[:-1], phs[-1], []

    def map(self, ph: str) -> str:
        if ph in ("SP", "AP"):
            return ph
        ph = self.phoneme_map.get(ph, ph)
        return ph if (not self.prefix or "/" in ph) else self.prefix + ph


@dataclass
class _Syl:
    notes: List[SungNote]
    onset: List[str]
    vowel: str
    coda: List[str]
    onset_total: float = 0.0
    coda_total: float = 0.0
    region_end: float = 0.0

    @property
    def start(self) -> float:
        return self.notes[0].start

    @property
    def end(self) -> float:
        return self.notes[-1].end


def _phrases(notes: List[SungNote], gap: float) -> List[List[SungNote]]:
    out: List[List[SungNote]] = []
    for n in notes:
        if out and n.start - out[-1][-1].end < gap:
            out[-1].append(n)
        else:
            out.append([n])
    return out


def _f0_curve(seg_start: float, seg_end: float, sung: List[Tuple[float, float, float, Dict[str, Any]]], default_vibrato: float) -> List[float]:
    """f0 (Hz) every F0_STEP seconds: note pitches, 30 ms legato glides, delayed vibrato."""
    count = int(math.ceil((seg_end - seg_start) / F0_STEP)) + 1
    out: List[float] = []
    k = 0
    for i in range(count):
        t = seg_start + i * F0_STEP
        while k + 1 < len(sung) and t >= sung[k + 1][0]:
            k += 1
        s0, e0, p0, ex = sung[k]
        if t < s0:  # before the first note (lead-in rest)
            midi = p0
        elif t >= e0 and k + 1 < len(sung):  # a rest between notes: hold, then move to the next pitch
            nxt = sung[k + 1]
            midi = p0 if t < (e0 + nxt[0]) / 2 else nxt[2]
        else:
            midi = p0
            if k + 1 < len(sung) and sung[k + 1][0] - e0 < 0.03 and t > e0 - 0.03:  # legato glide into the next note
                frac = min(1.0, (t - (e0 - 0.03)) / 0.06)
                midi = p0 + (sung[k + 1][2] - p0) * frac
            if k > 0 and s0 - sung[k - 1][1] < 0.03 and t < s0 + 0.03:
                frac = 0.5 + (t - s0) / 0.06
                midi = sung[k - 1][2] + (p0 - sung[k - 1][2]) * max(0.0, min(1.0, frac))
            dur = e0 - s0
            depth = 0.6 * float(ex.get("vibrato", default_vibrato))
            since = t - s0 - 0.2
            if dur > 0.35 and depth > 0 and since > 0 and t < e0:
                midi += depth * min(1.0, since / 0.15) * math.sin(2.0 * math.pi * float(ex.get("vibrato_rate", 5.5)) * since)
        out.append(440.0 * 2.0 ** ((midi - 69.0) / 12.0))
    return out


def build_ds(notes: List[SungNote], phon: Phonology, seed: int, *, lead_in: float = 0.5, tail: float = 0.3, phrase_gap: float = 0.8,
             default_vibrato: float = 0.25, breaths: bool = True) -> List[Dict[str, Any]]:
    """Contract notes (times relative to the output start, ≥ 0) → DiffSinger .ds segments.

    Invariants per segment: ``sum(ph_dur) == sum(note_dur) == segment length``; one ``ph_num``
    group per non-slur entry of ``note_seq`` (rests included), each starting at that note's onset.
    """
    mono: List[SungNote] = []
    for n in sorted(notes, key=lambda n: n.start):  # monophonic: drop notes starting with the previous one
        if mono and n.start < mono[-1].start + 0.01:
            continue
        mono.append(n)
    segments: List[Dict[str, Any]] = []
    phrases = _phrases(mono, phrase_gap)
    prev_end = 0.0
    for pi, phrase in enumerate(phrases):
        first, last = phrase[0], phrase[-1]
        seg_start = max(prev_end, first.start - lead_in)
        nxt_start = phrases[pi + 1][0].start if pi + 1 < len(phrases) else None
        seg_end = last.end + (tail if nxt_start is None else min(tail, (nxt_start - last.end) / 2.0))
        prev_end = seg_end
        # syllables: a sung note plus the melisma ("_") notes that extend its vowel
        syls: List[_Syl] = []
        for n in phrase:
            if n.is_melisma and syls:
                syls[-1].notes.append(n)
                continue
            onset, vowel, coda = phon.split(phon.syllable(n) or ["aa"])
            syls.append(_Syl([n], onset, vowel, coda))
        for k, sy in enumerate(syls):  # consonants go before the onset, limited by the room available
            want = sum(consonant_seconds(p) for p in sy.onset)
            room = sy.start - (syls[k - 1].start if k else seg_start)
            sy.onset_total = min(want, 0.25, 0.5 * room) if want > 0 else 0.0
            if sy.onset_total < 0.01 * len(sy.onset):
                sy.onset, sy.onset_total = [], 0.0
        for k, sy in enumerate(syls):
            nxt_on = syls[k + 1].start - syls[k + 1].onset_total if k + 1 < len(syls) else float("inf")
            sy.region_end = min(sy.end, nxt_on)
            want = sum(consonant_seconds(p) for p in sy.coda)
            sy.coda_total = min(want, 0.4 * (sy.region_end - sy.start)) if want > 0 else 0.0
            if sy.coda_total < 0.01 * len(sy.coda):
                sy.coda, sy.coda_total = [], 0.0
        events: List[Tuple[str, float, bool]] = []  # (phoneme, start time, starts a ph_num group)
        notes_out: List[List[Any]] = []  # [name, start, end, slur]
        sung: List[Tuple[float, float, float, Dict[str, Any]]] = []
        words: List[str] = []
        cursor = seg_start

        def rest(name: str, t0: float, t1: float) -> None:
            notes_out.append(["rest", t0, t1, 0])
            events.append((name, t0, True))
            words.append(name)

        for k, sy in enumerate(syls):
            on_start = sy.start - sy.onset_total
            if on_start - cursor > 1e-4:  # a rest: SP, and a breath (AP) before the next phrase part
                if breaths and k > 0 and on_start - cursor >= 0.35:
                    rest("SP", cursor, on_start - 0.2)
                    rest("AP", on_start - 0.2, sy.start)
                else:
                    rest("SP", cursor, sy.start)
            elif notes_out:  # legato: the previous note runs up to this onset
                notes_out[-1][2] = sy.start
            t = on_start
            scale = sy.onset_total / sum(consonant_seconds(p) for p in sy.onset) if sy.onset else 0.0
            for p in sy.onset:  # onset consonants belong to the previous group (they precede the note)
                events.append((phon.map(p), t, False))
                t += consonant_seconds(p) * scale
            events.append((phon.map(sy.vowel), sy.start, True))
            words.append(re.sub(r"\s+", "", sy.notes[0].lyric.strip().strip("-")) or sy.vowel)
            for j, n in enumerate(sy.notes):
                n_end = sy.notes[j + 1].start if j + 1 < len(sy.notes) else sy.region_end
                notes_out.append([note_name(n.pitch), n.start, n_end, 1 if j else 0])
            t = sy.region_end - sy.coda_total
            cscale = sy.coda_total / sum(consonant_seconds(p) for p in sy.coda) if sy.coda else 0.0
            for p in sy.coda:
                events.append((phon.map(p), t, False))
                t += consonant_seconds(p) * cscale
            cursor = sy.region_end
        if seg_end - cursor > 1e-4:
            rest("SP", cursor, seg_end)
        else:
            notes_out[-1][2] = seg_end
        for sy in syls:  # sung notes on the final note timeline, for the f0 curve
            for n in sy.notes:
                entry = next(e for e in notes_out if e[0] != "rest" and abs(e[1] - n.start) < 1e-9)
                sung.append((entry[1], entry[2], n.pitch, n.expression))
        bounds = [e[1] for e in events] + [seg_end]
        ph_dur = [max(0.0, bounds[i + 1] - bounds[i]) for i in range(len(events))]
        groups: List[int] = []
        for _ph, _t, starts in events:
            if starts or not groups:
                groups.append(0)
            groups[-1] += 1
        segments.append({
            "offset": round(seg_start, 6),
            "text": " ".join(words),
            "ph_seq": " ".join(e[0] for e in events),
            "ph_dur": " ".join(f"{d:.6f}" for d in ph_dur),
            "ph_num": " ".join(str(g) for g in groups),
            "note_seq": " ".join(n[0] for n in notes_out),
            "note_dur": " ".join(f"{n[2] - n[1]:.6f}" for n in notes_out),
            "note_slur": " ".join(str(n[3]) for n in notes_out),
            "f0_seq": " ".join(f"{f:.1f}" for f in _f0_curve(seg_start, seg_end, sung, default_vibrato)),
            "f0_timestep": str(F0_STEP),
            "input_type": "phoneme",
            "seed": int(seed) & 0x7FFFFFFF,
        })
    return segments


def window_notes(job: SingingJob, pre_roll: float) -> Tuple[List[SungNote], float]:
    """Notes clipped to the job's window and shifted so the window starts at ``pre_roll`` seconds."""
    t0, t1 = job.window
    out: List[SungNote] = []
    for n in job.notes_in_window():
        s, e = max(n.start, t0), min(n.end, t1)
        if e - s > 1e-4:
            out.append(SungNote(n.pitch, s - t0 + pre_roll, e - s, n.lyric, n.velocity, list(n.phonemes), dict(n.expression)))
    return out, t1 - t0


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------


def run_inference(segments: List[Dict[str, Any]], voice: Dict[str, Any], seed: int, args: Any, ctx: Optional[RequestContext]) -> bytes:
    """THE engine call: write the .ds, run the (optional variance and) acoustic command(s), return WAV bytes.

    Adapt the command templates (--command / --variance-command) or this function for other
    DiffSinger versions, multi-speaker voicebanks (--spk), or other output locations.
    """
    with tempfile.TemporaryDirectory(prefix="songdeck-diffsinger-") as tmp:
        title = "songdeck"
        ds_path = Path(tmp, "in", f"{title}.ds")
        ds_path.parent.mkdir(parents=True)
        ds_path.write_text(json.dumps(segments, ensure_ascii=False, indent=1), encoding="utf-8")
        if args.dump_ds:
            Path(args.dump_ds).mkdir(parents=True, exist_ok=True)
            Path(args.dump_ds, f"{title}-{seed}.ds").write_text(ds_path.read_text(encoding="utf-8"), encoding="utf-8")
        values = {
            "python": args.python, "title": title, "seed": str(int(seed) & 0x7FFFFFFF), "spk": str(voice.get("speaker") or ""),
            "voice": str(voice["id"]), "device": args.device, "exp": str(voice.get("exp") or args.exp or ""),
            "variance_exp": str(voice.get("variance_exp") or args.variance_exp or ""),
        }
        if args.variance_command:
            vout = Path(tmp, "variance")
            vout.mkdir()
            run_command(command_from_template(args.variance_command, {**values, "ds": str(ds_path), "out": str(vout)}), ctx,
                        cwd=args.diffsinger_root, timeout=args.timeout, name="diffsinger variance")
            produced = sorted(vout.rglob("*.ds"), key=lambda p: p.stat().st_mtime)
            if not produced:
                raise EngineError("the DiffSinger variance command did not write a .ds file")
            ds_path = produced[-1]
        out_dir = Path(tmp, "out")
        out_dir.mkdir()
        run_command(command_from_template(args.command, {**values, "ds": str(ds_path), "out": str(out_dir)}), ctx,
                    cwd=args.diffsinger_root, timeout=args.timeout, name="diffsinger")
        wavs = sorted(out_dir.rglob("*.wav"), key=lambda p: p.stat().st_mtime)
        if not wavs:
            raise EngineError(f"the DiffSinger command did not write a WAV into {out_dir} (check --command)")
        return wavs[-1].read_bytes()


# ---------------------------------------------------------------------------
# Configuration and app
# ---------------------------------------------------------------------------


def load_dictionary(path: Optional[str]) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    if not path:
        return out
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t") if "\t" in line else line.split(None, 1)
        if len(parts) == 2 and parts[1].split():
            out[parts[0].strip().lower()] = parts[1].split()
    return out


def load_voices(args: Any) -> Dict[str, Dict[str, Any]]:
    voices: Dict[str, Dict[str, Any]] = {}
    if args.voices_json:
        for v in json.loads(Path(args.voices_json).read_text(encoding="utf-8")):
            if not isinstance(v, dict) or not v.get("id"):
                fail(f"{args.voices_json}: every voice needs an 'id'")
            voices[str(v["id"])] = {"name": v.get("name") or v["id"], "voice_type": v.get("voice_type", ""), "language": v.get("language", "en"),
                                    "kind": v.get("kind", "imported"), **v}
    for spec in args.voice or []:
        parts = spec.split(":")
        vid = parts[0].strip()
        if not vid:
            fail(f"--voice {spec!r}: the id is empty")
        voices[vid] = {"id": vid, "name": (parts[1] if len(parts) > 1 and parts[1] else vid), "voice_type": parts[2] if len(parts) > 2 else "",
                       "language": parts[3] if len(parts) > 3 and parts[3] else "en", "speaker": parts[4] if len(parts) > 4 else "", "kind": "imported"}
    if not voices:
        vid = re.sub(r"[^A-Za-z0-9._-]+", "-", args.exp or "diffsinger").strip("-") or "diffsinger"
        voices[vid] = {"id": vid, "name": f"DiffSinger ({args.exp or 'default'})", "voice_type": args.voice_type, "language": "en", "kind": "imported"}
    return voices


def contract_voice(v: Dict[str, Any]) -> Dict[str, str]:
    return {"id": str(v["id"]), "name": str(v.get("name") or v["id"]), "voice_type": str(v.get("voice_type") or ""),
            "language": str(v.get("language") or ""), "kind": str(v.get("kind") or "imported")}


def make_phonology(args: Any) -> Phonology:
    phon = Phonology(dictionary=load_dictionary(args.dictionary), prefix=args.phoneme_prefix or "")
    if args.phoneme_map:
        phon.phoneme_map = {str(k): str(v) for k, v in json.loads(Path(args.phoneme_map).read_text(encoding="utf-8")).items()}
    if args.vowels:
        phon.vowels = frozenset(args.vowels.split()) | ARPABET_VOWELS
    return phon


def render(job: SingingJob, voice: Dict[str, Any], phon: Phonology, args: Any, ctx: Optional[RequestContext]) -> bytes:
    notes, length = window_notes(job, args.lead_in)
    if not notes:  # nothing to sing in the window: silence of the right length
        from songdeck_bridge.wav import silence

        return write_wav(silence(job.frames(), 1, job.sample_rate))
    segments = build_ds(notes, phon, job.seed, lead_in=args.lead_in, tail=args.tail, phrase_gap=args.phrase_gap,
                        default_vibrato=args.default_vibrato, breaths=not args.no_breaths)
    raw = run_inference(segments, voice, job.seed, args, ctx)
    try:
        audio = read_wav(raw)
    except WavError as e:
        raise EngineError(f"DiffSinger output is not a readable WAV ({e})") from None
    pre = int(round(args.lead_in * audio.sample_rate))
    audio = fit_length(audio.slice(pre), int(round(length * audio.sample_rate)) + 1)
    if audio.sample_rate != job.sample_rate:
        audio = resample_audio(audio, job.sample_rate)
    return write_wav(fit_length(audio.with_channels(1), job.frames()))


def build_app(args: Any) -> BridgeApp:
    app = BridgeApp("DiffSinger singing bridge", role="singing", **app_options(args))
    voices = load_voices(args)
    phon = make_phonology(args)

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        exps = sorted({str(v.get("exp") or args.exp or "default") for v in voices.values()})
        return json_response({
            "name": app.name,
            "version": __version__,
            "models": [{"id": e, "name": f"DiffSinger acoustic model '{e}'"} for e in exps],
            "capabilities": ["SINGING_SYNTHESIS", "MIDI_CONDITIONING", "LYRIC_CONDITIONING", "REGION_GENERATION"],
            "voices": [contract_voice(v) for v in voices.values()],
            "hardware": {"min_vram_gb": 0},
        })

    @app.route("GET", "/voices")
    def list_voices(ctx: RequestContext):
        return json_response([contract_voice(v) for v in voices.values()])

    def job_route(phrase: bool):
        def handler(ctx: RequestContext):
            job = parse_singing_request(ctx.json_object(), phrase=phrase, voice_ids=voices, max_duration=args.max_duration)
            voice = voices[job.voice_id]

            def work():
                wav = render(job, voice, phon, args, ctx)
                return wav_response(wav, seed=job.seed, model=str(voice.get("exp") or args.exp or "diffsinger"), headers={"X-Voice-Id": job.voice_id})

            return work

        return handler

    app.add_route("POST", "/synthesize", job_route(False), job=True)
    app.add_route("POST", "/regenerate_phrase", job_route(True), job=True)
    return app


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser("Song Deck singing bridge for OpenVPI DiffSinger (reference implementation).", DEFAULT_PORT, prog="diffsinger_bridge.py")
    d = p.add_argument_group("DiffSinger")
    d.add_argument("--diffsinger-root", default=None, help="OpenVPI DiffSinger checkout (working directory of the command)")
    d.add_argument("--exp", default=None, help="acoustic experiment name (checkpoints/<exp>) used by the default command")
    d.add_argument("--variance-exp", default=None, help="variance experiment for --variance-command ({variance_exp})")
    d.add_argument("--python", default=sys.executable, help="interpreter of the DiffSinger environment ({python})")
    d.add_argument("--command", default=DEFAULT_COMMAND, help=f"acoustic inference command template (default: {DEFAULT_COMMAND!r})")
    d.add_argument("--variance-command", default=None, help="optional variance command template run first; its .ds feeds --command")
    d.add_argument("--voice", action="append", default=[], metavar="ID[:NAME[:VOICE_TYPE[:LANG[:SPEAKER]]]]", help="a voice to list (repeatable)")
    d.add_argument("--voices-json", default=None, help="JSON list of voices: {id, name, voice_type, language, kind, speaker?, exp?}")
    d.add_argument("--voice-type", default="soprano", help="voice type of the default voice (default soprano)")
    d.add_argument("--dictionary", default=None, help="DiffSinger-style dictionary (syllable<TAB>phonemes) looked up before the English G2P")
    d.add_argument("--phoneme-map", default=None, help="JSON object renaming phonemes, e.g. {\"aa\": \"a\"}")
    d.add_argument("--phoneme-prefix", default="", help="prefix added to every phoneme except SP/AP (e.g. 'en/')")
    d.add_argument("--vowels", default=None, help="extra vowel phonemes (space separated) for non-ARPAbet phoneme sets")
    d.add_argument("--lead-in", type=float, default=0.5, help="silence before each phrase in seconds (default 0.5)")
    d.add_argument("--tail", type=float, default=0.3, help="silence after each phrase in seconds (default 0.3)")
    d.add_argument("--phrase-gap", type=float, default=0.8, help="rests at least this long start a new segment (default 0.8 s)")
    d.add_argument("--default-vibrato", type=float, default=0.25, help="vibrato depth 0..1 when a note has none (default 0.25)")
    d.add_argument("--no-breaths", action="store_true", help="do not insert AP breaths in longer rests")
    d.add_argument("--dump-ds", default=None, metavar="DIR", help="also save every generated .ds file into DIR (debugging)")
    d.add_argument("--print-ds", default=None, metavar="REQUEST.json", help="print the .ds for a SingingBridgeRequest file and exit (no server, no inference)")
    d.add_argument("--max-duration", type=float, default=600.0, help="longest output in seconds (default 600)")
    d.add_argument("--timeout", type=float, default=1800.0, help="seconds before an inference command is killed (default 1800)")
    args = p.parse_args(argv)
    setup_logging(args)
    for ph in re.findall(r"\{([a-z_]+)\}", (args.command or "") + " " + (args.variance_command or "")):
        if ph not in PLACEHOLDERS:
            fail(f"unknown placeholder {{{ph}}} in the command template (known: {', '.join('{' + x + '}' for x in PLACEHOLDERS)})")
    if args.print_ds:
        try:
            body = json.loads(Path(args.print_ds).read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            fail(f"--print-ds: cannot read {args.print_ds}: {e}")
        if not isinstance(body, dict):
            fail("--print-ds: the file must hold a SingingBridgeRequest JSON object")
        voices = load_voices(args)
        body.setdefault("voice_id", next(iter(voices)))
        try:
            job = parse_singing_request(body, phrase="start_seconds" in body, voice_ids=voices, max_duration=args.max_duration)
        except HTTPError as e:
            fail(f"--print-ds: {e.message}")
        notes, _ = window_notes(job, args.lead_in)
        print(json.dumps(build_ds(notes, make_phonology(args), job.seed, lead_in=args.lead_in, tail=args.tail, phrase_gap=args.phrase_gap,
                                  default_vibrato=args.default_vibrato, breaths=not args.no_breaths), indent=1))
        return 0
    check_bind(args)
    if not args.diffsinger_root or not Path(args.diffsinger_root).is_dir():
        fail("--diffsinger-root must point to an OpenVPI DiffSinger checkout (git clone https://github.com/openvpi/DiffSinger)")
    if args.command == DEFAULT_COMMAND:
        if not Path(args.diffsinger_root, "scripts", "infer.py").is_file():
            fail(f"{args.diffsinger_root}/scripts/infer.py not found — is this an OpenVPI DiffSinger checkout? (or pass --command)")
        if not args.exp and not args.voices_json:
            fail("--exp is required (the acoustic experiment folder name under checkpoints/)")
    return serve([(build_app(args), args.host, args.port)])


if __name__ == "__main__":
    sys.exit(main())
