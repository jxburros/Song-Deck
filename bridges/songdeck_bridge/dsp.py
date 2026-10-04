"""
Small DSP toolkit in pure Python (standard library only).

Used by the mock bridge (deterministic stand-ins for every engine) and by the stdlib fallbacks of
the real-engine bridges (e.g. loudness mastering without pyloudnorm). Everything works on plain
lists of floats; hot loops are list comprehensions, ``itertools.accumulate`` and C-level slicing,
so a few seconds of audio process in well under a second. Accuracy is "useful for integration
testing and previews", not studio grade — except :func:`integrated_loudness`, which follows
ITU-R BS.1770-4 / EBU R128 (K-weighting, 400 ms blocks, absolute and relative gates).

Determinism: nothing here reads the clock or global random state; pass seeded ``random.Random``
instances (see :func:`seeded`).
"""

from __future__ import annotations

import math
import random
import statistics
import zlib
from itertools import accumulate, repeat
from operator import add, mul, sub
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from .wav import Audio, resample

TWO_PI = 2.0 * math.pi
SQRT1_2 = math.sqrt(0.5)
_sumprod = getattr(math, "sumprod", None)  # Python 3.12+: ~3x faster dot products

Check = Optional[Callable[[], None]]


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    """Dot product of two equally long sequences."""
    if _sumprod is not None:
        return _sumprod(a, b)
    return sum(map(mul, a, b))


# ---------------------------------------------------------------------------
# Units and seeds
# ---------------------------------------------------------------------------


def midi_to_hz(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69.0) / 12.0)


def hz_to_midi(f: float) -> float:
    return 69.0 + 12.0 * math.log2(f / 440.0)


def db_to_gain(db: float) -> float:
    return 10.0 ** (db / 20.0)


def gain_to_db(g: float) -> float:
    return 20.0 * math.log10(g) if g > 0 else float("-inf")


def stable_seed(*parts: object) -> int:
    """A 31-bit seed from any values (stable across runs and platforms, unlike ``hash``)."""
    h = 0
    for p in parts:
        h = zlib.crc32(repr(p).encode("utf-8"), h)
    return h & 0x7FFFFFFF


def seeded(*parts: object) -> random.Random:
    return random.Random(stable_seed(*parts))


# ---------------------------------------------------------------------------
# Buffers
# ---------------------------------------------------------------------------


def add_into(dst: List[float], src: Sequence[float], offset: int = 0, gain: float = 1.0) -> None:
    """dst[offset:offset+len(src)] += gain * src (clipped to dst's bounds)."""
    if offset < 0:
        src = src[-offset:]
        offset = 0
    end = min(len(dst), offset + len(src))
    if end <= offset:
        return
    seg = src[: end - offset]
    if gain != 1.0:
        dst[offset:end] = map(add, dst[offset:end], map(mul, seg, repeat(gain)))
    else:
        dst[offset:end] = map(add, dst[offset:end], seg)


def scale(x: Sequence[float], g: float) -> List[float]:
    return list(map(mul, x, repeat(g)))


def blend(a: Sequence[float], b: Sequence[float], wa: float, wb: float) -> List[float]:
    """wa * a + wb * b, element-wise (C-level)."""
    return list(map(add, map(mul, a, repeat(wa)), map(mul, b, repeat(wb))))


def peak(x: Sequence[float]) -> float:
    return max(map(abs, x)) if len(x) else 0.0


def peak_channels(channels: Sequence[Sequence[float]]) -> float:
    return max((peak(ch) for ch in channels), default=0.0)


def rms(x: Sequence[float]) -> float:
    return math.sqrt(dot(x, x) / len(x)) if len(x) else 0.0


def rms_channels(channels: Sequence[Sequence[float]]) -> float:
    n = sum(len(ch) for ch in channels)
    return math.sqrt(sum(dot(ch, ch) for ch in channels) / n) if n else 0.0


def crossfade_weights(n: int) -> List[float]:
    """Equal-power fade-in curve of ``n`` samples (0 → 1)."""
    if n <= 0:
        return []
    return [math.sin(0.5 * math.pi * (i + 0.5) / n) ** 2 for i in range(n)]


# ---------------------------------------------------------------------------
# Wavetable oscillators and envelopes
# ---------------------------------------------------------------------------

TABLE_SIZE = 4096
_MASK = TABLE_SIZE - 1
_tables: Dict[Tuple[Tuple[int, float], ...], List[float]] = {}

SINE: Tuple[Tuple[int, float], ...] = ((1, 1.0),)


def wavetable(partials: Sequence[Tuple[int, float]]) -> List[float]:
    """One normalized cycle with integer ``(harmonic, amplitude)`` partials (cached)."""
    key = tuple((int(h), float(a)) for h, a in partials)
    t = _tables.get(key)
    if t is None:
        t = [0.0] * TABLE_SIZE
        for h, a in key:
            w = TWO_PI * h / TABLE_SIZE
            t = [v + a * math.sin(w * i) for i, v in enumerate(t)]
        pk = peak(t) or 1.0
        t = [v / pk for v in t]
        _tables[key] = t
    return t


def harmonic_count(freq: float, sample_rate: int, limit: int = 48) -> int:
    """Harmonics that stay below ~0.45 × sample rate (band-limited, no aliasing)."""
    return max(1, min(limit, int(0.45 * sample_rate / max(freq, 1.0))))


def saw_table(freq: float, sample_rate: int, rolloff: float = 1.0, limit: int = 48) -> List[float]:
    n = harmonic_count(freq, sample_rate, limit)
    return wavetable([(h, 1.0 / h**rolloff) for h in range(1, n + 1)])


def osc(table: Sequence[float], freq: float, n: int, sample_rate: int, phase: float = 0.0) -> List[float]:
    """``n`` samples of a fixed-frequency wavetable oscillator (16.16 fixed-point phase)."""
    inc = int(round(freq * TABLE_SIZE / sample_rate * 65536.0))
    p0 = int((phase % 1.0) * TABLE_SIZE * 65536.0)
    if inc <= 0:
        return [table[(p0 >> 16) & _MASK]] * max(0, n)
    return [table[(p >> 16) & _MASK] for p in range(p0, p0 + n * inc, inc)]


def osc_varying(table: Sequence[float], freqs: Sequence[float], sample_rate: int, phase: float = 0.0) -> List[float]:
    """Wavetable oscillator with a per-sample frequency (vibrato, glides, sweeps)."""
    k = TABLE_SIZE / float(sample_rate)
    phases = accumulate([f * k for f in freqs], initial=(phase % 1.0) * TABLE_SIZE)
    out = [table[int(p) & _MASK] for p in phases]
    out.pop()  # accumulate(initial=…) yields one extra value
    return out


def fade_edges(x: List[float], fade_in: int, fade_out: int) -> List[float]:
    """Linear fade-in/out of the first/last samples (in place; returns ``x``)."""
    n = len(x)
    a = min(max(0, fade_in), n)
    for i in range(a):
        x[i] *= (i + 0.5) / a
    r = min(max(0, fade_out), n)
    for i in range(r):
        x[n - 1 - i] *= (i + 0.5) / r
    return x


def decay_envelope(n: int, sample_rate: int, tau: float) -> List[float]:
    """exp(-t / tau) for ``n`` samples (geometric series via C-level accumulate)."""
    if n <= 0:
        return []
    d = math.exp(-1.0 / max(1e-6, tau * sample_rate))
    return list(accumulate([d] * (n - 1), mul, initial=1.0))


def white_noise(n: int, rnd: random.Random) -> List[float]:
    r = rnd.random
    return [r() * 2.0 - 1.0 for _ in range(n)]


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


def biquad(x: Sequence[float], b0: float, b1: float, b2: float, a1: float, a2: float) -> List[float]:
    """Direct-form-I biquad (a0 normalized to 1)."""
    y = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, xi in enumerate(x):
        yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1
        x1 = xi
        y2 = y1
        y1 = yi
        y[i] = yi
    return y


def _rbj(kind: str, fc: float, sample_rate: int, q: float) -> Tuple[float, float, float, float, float]:
    fc = min(max(fc, 1.0), 0.49 * sample_rate)
    w0 = TWO_PI * fc / sample_rate
    cw = math.cos(w0)
    alpha = math.sin(w0) / (2.0 * q)
    if kind == "lowpass":
        b0, b1, b2 = (1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0
    else:
        b0, b1, b2 = (1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0
    a0 = 1.0 + alpha
    return b0 / a0, b1 / a0, b2 / a0, (-2.0 * cw) / a0, (1.0 - alpha) / a0


def lowpass(x: Sequence[float], sample_rate: int, fc: float, q: float = SQRT1_2) -> List[float]:
    """12 dB/oct Butterworth low-pass (RBJ biquad)."""
    return biquad(x, *_rbj("lowpass", fc, sample_rate, q))


def highpass(x: Sequence[float], sample_rate: int, fc: float, q: float = SQRT1_2) -> List[float]:
    return biquad(x, *_rbj("highpass", fc, sample_rate, q))


def one_pole_lowpass(x: Sequence[float], sample_rate: int, fc: float) -> List[float]:
    a = 1.0 - math.exp(-TWO_PI * min(fc, 0.49 * sample_rate) / sample_rate)
    y = [0.0] * len(x)
    s = 0.0
    for i, xi in enumerate(x):
        s += a * (xi - s)
        y[i] = s
    return y


def tilt(x: Sequence[float], sample_rate: int, amount: float, pivot_hz: float = 900.0) -> List[float]:
    """Spectral tilt: amount > 0 brightens, < 0 darkens (about ±6 dB at the extremes for ±1)."""
    if abs(amount) < 1e-6:
        return list(x)
    low = one_pole_lowpass(x, sample_rate, pivot_hz)
    gl = 1.0 - 0.5 * amount
    gh = 1.0 + 0.5 * amount
    return [lo * gl + (v - lo) * gh for v, lo in zip(x, low)]


def split_bands(x: Sequence[float], sample_rate: int, cutoffs: Sequence[float]) -> List[List[float]]:
    """Complementary band split: ``len(cutoffs) + 1`` bands whose sum equals ``x`` (to rounding)."""
    bands: List[List[float]] = []
    rest = list(x)
    for fc in sorted(cutoffs):
        low = lowpass(rest, sample_rate, fc)
        bands.append(low)
        rest = list(map(sub, rest, low))
    bands.append(rest)
    return bands


# ---------------------------------------------------------------------------
# Loudness (ITU-R BS.1770-4 / EBU R128) and limiting
# ---------------------------------------------------------------------------


def _k_weighting(sample_rate: int) -> Tuple[Tuple[float, ...], Tuple[float, ...]]:
    """K-weighting biquads for any sample rate (same formulas as libebur128)."""
    fs = float(sample_rate)
    f0, g, q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = math.tan(math.pi * f0 / fs)
    vh = 10.0 ** (g / 20.0)
    vb = vh**0.4996667741545416
    a0 = 1.0 + k / q + k * k
    shelf = (
        (vh + vb * k / q + k * k) / a0,
        2.0 * (k * k - vh) / a0,
        (vh - vb * k / q + k * k) / a0,
        2.0 * (k * k - 1.0) / a0,
        (1.0 - k / q + k * k) / a0,
    )
    f0, q = 38.13547087602444, 0.5003270373238773
    k = math.tan(math.pi * f0 / fs)
    d = 1.0 + k / q + k * k
    hp = (1.0, -2.0, 1.0, 2.0 * (k * k - 1.0) / d, (1.0 - k / q + k * k) / d)
    return shelf, hp


def k_weight(x: Sequence[float], sample_rate: int) -> List[float]:
    shelf, hp = _k_weighting(sample_rate)
    return biquad(biquad(x, *shelf), *hp)


def integrated_loudness(channels: Sequence[Sequence[float]], sample_rate: int, check: Check = None) -> float:
    """Integrated loudness in LUFS (−inf for silence). Channel weights are 1 (mono/stereo)."""
    frames = len(channels[0]) if channels else 0
    if frames == 0:
        return float("-inf")
    block = int(round(0.4 * sample_rate))
    hop = int(round(0.1 * sample_rate))
    starts = list(range(0, frames - block + 1, hop)) if frames >= block else [0]
    width = block if frames >= block else frames
    powers: Optional[List[float]] = None
    for ch in channels:
        if check:
            check()
        y = k_weight(ch, sample_rate)
        cs = [0.0]
        cs.extend(accumulate(map(mul, y, y)))
        z = [(cs[s + width] - cs[s]) / width for s in starts]
        powers = z if powers is None else list(map(add, powers, z))
    assert powers is not None
    loud = [(-0.691 + 10.0 * math.log10(p)) if p > 0 else float("-inf") for p in powers]
    above_abs = [p for p, lk in zip(powers, loud) if lk > -70.0]
    if not above_abs:
        return float("-inf")
    rel = -0.691 + 10.0 * math.log10(sum(above_abs) / len(above_abs)) - 10.0
    gated = [p for p, lk in zip(powers, loud) if lk > -70.0 and lk > rel]
    if not gated:
        return float("-inf")
    return -0.691 + 10.0 * math.log10(sum(gated) / len(gated))


def limit(
    channels: Sequence[Sequence[float]],
    sample_rate: int,
    ceiling: float,
    release_s: float = 0.08,
    block_s: float = 0.003,
) -> List[List[float]]:
    """Look-ahead peak limiter: no sample exceeds ``ceiling`` (linear); smooth release.

    Gains are computed per ~3 ms block (one block of look-ahead) and interpolated linearly, so the
    gain reduction starts before the peak and recovers with the release time constant.
    """
    n = len(channels[0]) if channels else 0
    if n == 0:
        return [list(ch) for ch in channels]
    if peak_channels(channels) <= ceiling:
        return [list(ch) for ch in channels]
    b = max(16, int(sample_rate * block_s))
    nb = (n + b - 1) // b
    req = []
    for k in range(nb):
        pk = max(peak(ch[k * b : (k + 1) * b]) for ch in channels)
        req.append(1.0 if pk <= ceiling else ceiling / pk)
    rc = 1.0 - math.exp(-b / max(1.0, release_s * sample_rate))
    bounds = [1.0] * (nb + 1)
    g = 1.0
    for k in range(nb + 1):
        target = min(req[k - 1] if k >= 1 else 1.0, req[k] if k < nb else 1.0)
        g += (1.0 - g) * rc
        if target < g:
            g = target
        bounds[k] = g
    gains: List[float] = []
    for k in range(nb):
        g0, g1 = bounds[k], bounds[k + 1]
        length = min(b, n - k * b)
        if g0 == g1:
            gains.extend([g0] * length)
        else:
            step = (g1 - g0) / b
            gains.extend([g0 + step * j for j in range(length)])
    out = [list(map(mul, ch, gains)) for ch in channels]
    if peak_channels(out) > ceiling:  # interpolation rounding only
        out = [[ceiling if v > ceiling else (-ceiling if v < -ceiling else v) for v in ch] for ch in out]
    return out


#: Song Deck mastering targets (spec §42): integrated loudness (LUFS) and sample-peak ceiling (dBFS).
MASTERING_TARGETS: Dict[str, Dict[str, float]] = {
    "streaming": {"lufs": -14.0, "ceiling_db": -1.0, "bits": 24},
    "cd": {"lufs": -9.0, "ceiling_db": -0.3, "bits": 16},
    "loud-rock": {"lufs": -8.0, "ceiling_db": -0.3, "bits": 24},
    "dynamic": {"lufs": -18.0, "ceiling_db": -1.0, "bits": 24},
    "podcast": {"lufs": -16.0, "ceiling_db": -1.0, "bits": 24},
    "demo": {"lufs": -12.0, "ceiling_db": -1.0, "bits": 24},
}


def master(
    audio: Audio, target: str, reference: Optional[Audio] = None, check: Check = None
) -> Tuple[Audio, Dict[str, float]]:
    """Loudness-normalize to the target (or to the reference's loudness) and peak-limit.

    Returns the mastered audio (24-bit PCM, or 16-bit for ``cd``) and a report.
    """
    spec = MASTERING_TARGETS[target]
    ceiling_db = spec["ceiling_db"]
    target_lufs = spec["lufs"]
    report: Dict[str, float] = {}
    if reference is not None:
        ref_lufs = integrated_loudness(reference.channels, reference.sample_rate, check)
        if math.isfinite(ref_lufs):
            target_lufs = max(-24.0, min(-6.0, ref_lufs))
            report["reference_lufs"] = round(ref_lufs, 2)
    measured = integrated_loudness(audio.channels, audio.sample_rate, check)
    report["input_lufs"] = round(measured, 2) if math.isfinite(measured) else -999.0
    report["target_lufs"] = target_lufs
    report["ceiling_db"] = ceiling_db
    if not math.isfinite(measured):
        gain_db = 0.0  # silence: nothing to normalize
    else:
        gain_db = max(-24.0, min(24.0, target_lufs - measured))
    report["gain_db"] = round(gain_db, 2)
    g = db_to_gain(gain_db)
    chans = [scale(ch, g) for ch in audio.channels]
    if check:
        check()
    chans = limit(chans, audio.sample_rate, db_to_gain(ceiling_db))
    out = Audio(audio.sample_rate, chans, int(spec["bits"]), False)
    out_lufs = integrated_loudness(out.channels, out.sample_rate, check)
    report["output_lufs"] = round(out_lufs, 2) if math.isfinite(out_lufs) else -999.0
    report["output_peak_db"] = (
        round(gain_to_db(peak_channels(out.channels)), 2) if peak_channels(out.channels) > 0 else -999.0
    )
    return out, report


# ---------------------------------------------------------------------------
# Pitch tracking (McLeod NSDF) and note segmentation
# ---------------------------------------------------------------------------


def _nsdf_peak(frame: List[float], lag_min: int, lag_max: int, k: float = 0.9) -> Tuple[float, float]:
    """(lag, clarity) of the McLeod pitch peak, or (0, 0) when unvoiced."""
    w = len(frame)
    cs = [0.0]
    cs.extend(accumulate(map(mul, frame, frame)))
    total = cs[w]
    lag_max = min(lag_max, w - 2)
    nsdf = [1.0]
    for tau in range(1, lag_max + 2):
        m = cs[w - tau] + (total - cs[tau])
        nsdf.append(2.0 * dot(frame[: w - tau], frame[tau:]) / m if m > 1e-12 else 0.0)
    # skip the zero-lag lobe, then collect the maximum of each positive lobe
    i = 1
    n = len(nsdf)
    while i < n and nsdf[i] > 0.0:
        i += 1
    maxima: List[Tuple[int, float]] = []
    while i < n - 1:
        while i < n - 1 and nsdf[i] <= 0.0:
            i += 1
        best_i, best_v = -1, 0.0
        while i < n - 1 and nsdf[i] > 0.0:
            if nsdf[i] > best_v:
                best_i, best_v = i, nsdf[i]
            i += 1
        # keep true local maxima inside the lag range (a lobe cut off at lag_max may still be rising)
        if lag_min <= best_i <= lag_max and nsdf[best_i] >= nsdf[best_i + 1]:
            maxima.append((best_i, best_v))
    if not maxima:
        return 0.0, 0.0
    refined: List[Tuple[float, float]] = []
    for idx, _v in maxima:  # parabolic interpolation: true peak position and height between integer lags
        a, b, c = nsdf[idx - 1], nsdf[idx], nsdf[idx + 1]
        den = a - 2.0 * b + c
        shift = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
        shift = max(-0.5, min(0.5, shift))
        refined.append((idx + shift, b - 0.25 * (a - c) * shift))
    top = max(v for _, v in refined)
    for lag, v in refined:
        if v >= k * top:
            return lag, v
    return 0.0, 0.0


def track_pitch(
    x: Sequence[float],
    sample_rate: int,
    fmin: float = 60.0,
    fmax: float = 1000.0,
    hop_s: float = 0.01,
    gate_db: float = -50.0,
    relative_gate_db: float = -35.0,
    min_clarity: float = 0.6,
    check: Check = None,
) -> Dict[str, object]:
    """Monophonic f0 track. Returns ``times``, ``f0`` (0 = unvoiced), ``clarity``, ``rms``, ``hop``."""
    fmax = max(fmin * 2.0, fmax)
    factor = max(1, int(sample_rate // (fmax * 6.0)))  # work at ~6× fmax: keeps the lag search small
    work_sr = sample_rate / factor
    y = resample(x, sample_rate, work_sr, "linear") if factor > 1 else list(x)
    w = max(128, int(math.ceil(2.2 * work_sr / fmin / 32.0)) * 32)  # ≥ 2 periods of the lowest pitch
    hop = max(1, int(round(hop_s * work_sr)))
    lag_min = max(2, int(work_sr / fmax))
    lag_max = int(math.ceil(work_sr / fmin))
    starts = list(range(0, max(0, len(y) - w) + 1, hop)) if len(y) >= w else ([0] if y else [])
    if len(y) < w and y:
        y = y + [0.0] * (w - len(y))
    cs = [0.0]
    cs.extend(accumulate(map(mul, y, y)))
    frame_rms = [math.sqrt(max(0.0, (cs[s + w] - cs[s]) / w)) for s in starts]
    loudest = max(frame_rms, default=0.0)
    gate = max(db_to_gain(gate_db), loudest * db_to_gain(relative_gate_db))
    times: List[float] = []
    f0s: List[float] = []
    clar: List[float] = []
    for j, s in enumerate(starts):
        if check and j % 32 == 0:
            check()
        times.append((s + w / 2.0) / work_sr)
        if frame_rms[j] < gate:
            f0s.append(0.0)
            clar.append(0.0)
            continue
        frame = y[s : s + w]
        mu = sum(frame) / w
        if abs(mu) > 1e-9:
            frame = [v - mu for v in frame]
        lag, c = _nsdf_peak(frame, lag_min, lag_max)
        if lag <= 0 or c < min_clarity:
            f0s.append(0.0)
            clar.append(max(0.0, c))
            continue
        f0s.append(work_sr / lag)
        clar.append(min(1.0, c))
    return {"times": times, "f0": f0s, "clarity": clar, "rms": frame_rms, "hop": hop / work_sr}


def notes_from_pitch(
    track: Dict[str, object], *, min_note_s: float = 0.06, split_semitones: float = 0.6, max_gap_frames: int = 1
) -> List[Dict[str, float]]:
    """Segment an f0 track into notes ``{pitch, start, end, velocity, confidence}``."""
    times: List[float] = track["times"]  # type: ignore[assignment]
    f0: List[float] = track["f0"]  # type: ignore[assignment]
    clar: List[float] = track["clarity"]  # type: ignore[assignment]
    lvl: List[float] = track["rms"]  # type: ignore[assignment]
    hop: float = track["hop"]  # type: ignore[assignment]
    midi = [hz_to_midi(f) if f > 0 else None for f in f0]
    smoothed: List[Optional[float]] = list(midi)
    for i, m in enumerate(midi):  # 5-frame median over voiced neighbours removes octave blips
        if m is None:
            continue
        win = [v for v in midi[max(0, i - 2) : i + 3] if v is not None]
        smoothed[i] = statistics.median(win)
    notes: List[Dict[str, float]] = []
    cur: Optional[Dict[str, list]] = None

    def finish(note: Optional[Dict[str, list]]) -> None:
        if not note or not note["idx"]:
            return
        first, last = note["idx"][0], note["idx"][-1]
        start = max(0.0, times[first] - hop / 2.0)
        end = times[last] + hop / 2.0
        if end - start < min_note_s:
            return
        vals = note["m"]
        med = statistics.median(vals)
        spread = statistics.pstdev(vals) if len(vals) > 1 else 0.0
        clarity = sum(clar[i] for i in note["idx"]) / len(note["idx"])
        stability = max(0.0, 1.0 - spread / 0.5)
        level = max(lvl[i] for i in note["idx"])
        db = gain_to_db(level) if level > 0 else -90.0
        velocity = int(round(max(1.0, min(127.0, 40.0 + 87.0 * (db + 40.0) / 40.0))))
        notes.append(
            {
                "pitch": int(round(med)),
                "start": round(start, 4),
                "end": round(end, 4),
                "velocity": velocity,
                "confidence": round(max(0.0, min(1.0, clarity * (0.6 + 0.4 * stability))), 3),
            }
        )

    gap = 0
    for i, m in enumerate(smoothed):
        if m is None:
            gap += 1
            if cur is not None and gap > max_gap_frames:
                finish(cur)
                cur = None
            continue
        if cur is None:
            cur = {"idx": [i], "m": [m]}
            gap = 0
            continue
        ref = statistics.median(cur["m"][-15:])
        if abs(m - ref) >= split_semitones:
            nxt = smoothed[i + 1] if i + 1 < len(smoothed) else None
            if nxt is None or abs(nxt - ref) >= split_semitones:
                finish(cur)
                cur = {"idx": [i], "m": [m]}
                gap = 0
            continue  # a one-frame excursion is ignored
        prev_level = lvl[i - 1] if i >= 1 else 0.0
        if gap == 0 and prev_level > 0 and lvl[i] > 2.0 * prev_level and (i - cur["idx"][0]) * hop >= min_note_s:
            finish(cur)  # re-articulated note of the same pitch
            cur = {"idx": [i], "m": [m]}
            continue
        cur["idx"].append(i)
        cur["m"].append(m)
        gap = 0
    finish(cur)
    return notes


# ---------------------------------------------------------------------------
# Drum onsets, tempo and key estimates
# ---------------------------------------------------------------------------


def drum_hits(x: Sequence[float], sample_rate: int, check: Check = None) -> List[Dict[str, float]]:
    """Energy-flux onsets classified by band: low → kick (36), mid → snare (38), high → hi-hat (42)."""
    low = one_pole_lowpass(x, sample_rate, 150.0)
    lowmid = one_pole_lowpass(x, sample_rate, 5000.0)
    high = [a - b for a, b in zip(x, lowmid)]
    mid = [a - b for a, b in zip(lowmid, low)]
    if check:
        check()
    hop = max(1, int(sample_rate * 0.01))
    bands = []
    for band in (low, mid, high):
        cs = [0.0]
        cs.extend(accumulate(map(mul, band, band)))
        bands.append([(cs[min(len(band), s + hop)] - cs[s]) / hop for s in range(0, len(band), hop)])
    total = [a + b + c for a, b, c in zip(*bands)]
    loudest = max(total, default=0.0)
    if loudest <= 0:
        return []
    hits: List[Dict[str, float]] = []
    last = -1.0
    for i in range(1, len(total) - 1):
        prev = sum(total[max(0, i - 5) : i]) / max(1, min(5, i))
        if total[i] < loudest * 1e-3 or total[i] < 2.5 * prev or total[i] < total[i + 1]:
            continue
        t = i * hop / sample_rate
        if t - last < 0.05:
            continue
        rise = [bands[k][i] - bands[k][i - 1] for k in range(3)]
        weights = (rise[0] * 1.0, rise[1] * 2.0, rise[2] * 6.0)  # high bands carry less energy
        k = max(range(3), key=lambda j: weights[j])
        db = 10.0 * math.log10(total[i] / loudest)
        hits.append(
            {
                "pitch": (36, 38, 42)[k],
                "start": round(t, 4),
                "end": round(t + 0.1, 4),
                "velocity": int(max(1, min(127, round(127 + 3.0 * db)))),
                "confidence": 0.5,
            }
        )
        last = t
    return hits


def estimate_tempo(onsets: Sequence[float], lo_bpm: float = 60.0, hi_bpm: float = 200.0) -> Optional[float]:
    """Tempo from onset times by autocorrelating a smoothed onset train (None if < 6 onsets)."""
    pts = sorted(t for t in onsets if t >= 0)
    if len(pts) < 6:
        return None
    res = 0.01
    length = int(pts[-1] / res) + 8
    train = [0.0] * length
    for t in pts:
        i = int(round(t / res))
        for d, wgt in ((-2, 0.25), (-1, 0.6), (0, 1.0), (1, 0.6), (2, 0.25)):  # ~20 ms Gaussian
            if 0 <= i + d < length:
                train[i + d] += wgt
    best_bpm, best_score = None, 0.0
    bpm = lo_bpm
    while bpm <= hi_bpm + 1e-9:
        lag = 60.0 / bpm / res
        score = 0.0
        for mult, wgt in ((1, 1.0), (2, 0.5), (4, 0.25)):
            lg = int(round(lag * mult))
            if 0 < lg < length:
                score += wgt * dot(train[:-lg], train[lg:])
        score *= math.exp(-0.5 * (math.log2(bpm / 120.0) / 0.9) ** 2)  # gentle prior toward ~120 BPM
        if score > best_score:
            best_bpm, best_score = bpm, score
        bpm += 0.5
    return round(best_bpm, 1) if best_bpm and best_score > 0 else None


_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
_MAJOR_NAMES = ("C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
_MINOR_NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B")


def _corr(a: Sequence[float], b: Sequence[float]) -> float:
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    da = [v - ma for v in a]
    db = [v - mb for v in b]
    den = math.sqrt(dot(da, da) * dot(db, db))
    return dot(da, db) / den if den > 0 else 0.0


def estimate_key(notes: Sequence[Dict[str, float]]) -> Optional[Tuple[str, float]]:
    """Krumhansl–Kessler key estimate from notes (duration-weighted); ``(name, confidence)``."""
    hist = [0.0] * 12
    for n in notes:
        hist[int(n["pitch"]) % 12] += max(0.0, float(n["end"]) - float(n["start"]))
    if sum(1 for v in hist if v > 0) < 3:
        return None
    scores = []
    for tonic in range(12):
        rot = hist[tonic:] + hist[:tonic]
        scores.append((_corr(rot, _MAJOR), f"{_MAJOR_NAMES[tonic]} major"))
        scores.append((_corr(rot, _MINOR), f"{_MINOR_NAMES[tonic]} minor"))
    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    confidence = max(0.0, min(1.0, 0.5 * best[0] + 2.0 * (best[0] - second[0])))
    return best[1], round(confidence, 3)


# ---------------------------------------------------------------------------
# Pitch shifting (resample + overlap-add time stretch)
# ---------------------------------------------------------------------------


def time_stretch(
    y: Sequence[float], out_len: int, sample_rate: int, grain_s: float = 0.04, tolerance_s: float = 0.01
) -> List[float]:
    """WSOLA time stretch of ``y`` to ``out_len`` samples (Hann grains, 50 % overlap).

    Each grain is taken near its nominal position, shifted by up to ``tolerance_s`` so that it
    lines up (max cross-correlation) with the natural continuation of the previous grain — this
    keeps waveform periods intact, so pitch is preserved (plain overlap-add smears it). The search
    runs on a 4× decimated signal first, then is refined at full resolution.
    """
    if out_len <= 0:
        return []
    if not y:
        return [0.0] * out_len
    n = max(64, int(grain_s * sample_rate)) & ~1
    hs = n // 2
    tol = max(4, int(tolerance_s * sample_rate))
    win = [0.5 - 0.5 * math.cos(TWO_PI * i / n) for i in range(n)]  # periodic Hann: shifted copies sum to 1
    ratio = len(y) / float(out_len)
    pad = hs + tol
    yp = [0.0] * pad + list(y) + [0.0] * (n + pad + 8)
    yd = yp[::4]
    out = [0.0] * (out_len + n + hs)
    prev = -1
    k = 0
    while k * hs < out_len + hs:
        ss = k * hs
        nominal = int(round(ss * ratio)) + tol  # yp coordinates (the first `pad` samples are zeros)
        sa = nominal
        if prev >= 0:
            target = yp[prev + hs : prev + n]  # what naturally followed the previous grain (overlap region)
            if any(target):
                td = target[::4]
                lo, hi = (nominal - tol) // 4, (nominal + tol) // 4
                best_c, best_v = nominal // 4, float("-inf")
                for c in range(max(0, lo), hi + 1):
                    v = dot(yd[c : c + len(td)], td)
                    if v > best_v:
                        best_c, best_v = c, v
                best, best_v = best_c * 4, float("-inf")
                for c in range(max(0, best_c * 4 - 3), best_c * 4 + 4):
                    cand = yp[c : c + hs]
                    v = dot(cand, target) / math.sqrt(dot(cand, cand) + 1e-12)
                    if v > best_v:
                        best, best_v = c, v
                sa = best
        grain = yp[sa : sa + n]
        if len(grain) < n:
            grain = grain + [0.0] * (n - len(grain))
        out[ss : ss + n] = map(add, out[ss : ss + n], map(mul, grain, win))
        prev = sa
        k += 1
    return out[hs : hs + out_len]


def pitch_shift(x: Sequence[float], sample_rate: int, semitones: float) -> List[float]:
    """Shift pitch by ``semitones`` keeping the duration (resample, then OLA back to length)."""
    if abs(semitones) < 1e-6 or not x:
        return list(x)
    r = 2.0 ** (semitones / 12.0)
    faster = resample(x, r, 1.0, "cubic")  # read r× faster → pitch × r, length / r
    return time_stretch(faster, len(x), sample_rate)
