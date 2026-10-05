"""
NumPy audio helpers for engine bridges whose engines already depend on NumPy (Whisper, MusicGen,
Stable Audio…). Long songs as Python float lists cost hundreds of MB; these functions decode and
encode WAV bytes straight from/to NumPy arrays instead. NumPy is passed in (``np``) so that this
module itself imports nothing beyond the standard library.

Arrays are ``float32`` shaped ``(channels, frames)``.
"""

from __future__ import annotations

import math
import struct
from typing import Any, Tuple

from .wav import WavError, wav_layout

__all__ = ["wav_to_numpy", "numpy_to_wav", "resample_np", "fit_np", "to_channels_np"]


def wav_to_numpy(data: bytes, np: Any) -> Tuple[Any, int]:
    """WAV bytes (PCM 8/16/24/32, float 32/64) → ``(array (channels, frames) float32, sample_rate)``."""
    lay = wav_layout(data)
    tag, nch, rate, size = lay["format_tag"], lay["channels"], lay["sample_rate"], lay["container"]
    off, frames = lay["offset"], lay["frames"]
    raw = memoryview(data)[off : off + frames * nch * size]
    if tag == 3 and size in (4, 8):
        x = np.frombuffer(raw, dtype="<f4" if size == 4 else "<f8").astype(np.float32)
    elif tag == 1 and size == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif tag == 1 and size == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif tag == 1 and size == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        x = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float32) / 8388608.0
    elif tag == 1 and size == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise WavError(f"unsupported WAV encoding (format tag {tag}, {size * 8}-bit)")
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    return np.ascontiguousarray(x.reshape(-1, nch).T), int(rate)


def numpy_to_wav(audio: Any, sample_rate: int, np: Any) -> bytes:
    """``(channels, frames)`` (or 1-D mono) array → 32-bit float WAV bytes."""
    a = np.asarray(audio, dtype=np.float32)
    if a.ndim == 1:
        a = a[None, :]
    nch, frames = a.shape
    body = np.nan_to_num(a.T, nan=0.0, posinf=0.0, neginf=0.0).astype("<f4").tobytes()
    block = 4 * nch
    fmt = struct.pack("<HHIIHHH", 3, nch, int(sample_rate), int(sample_rate) * block, block, 32, 0)
    fact = b"fact" + struct.pack("<II", 4, frames)
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt + fact + b"data" + struct.pack("<I", len(body)) + body
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


def resample_np(x: Any, src: int, dst: int, np: Any) -> Any:
    """Resample along the last axis (scipy's polyphase filter when installed, else windowed-sinc + linear)."""
    if int(src) == int(dst) or x.shape[-1] == 0:
        return x.astype(np.float32)
    try:
        from scipy.signal import resample_poly  # type: ignore

        g = math.gcd(int(src), int(dst))
        return resample_poly(x, int(dst) // g, int(src) // g, axis=-1).astype(np.float32)
    except ImportError:
        pass
    y = np.atleast_2d(x).astype(np.float64)
    if dst < src:  # anti-aliasing low-pass
        fc = 0.45 * dst / src
        n = np.arange(-32, 33)
        taps = np.sinc(2 * fc * n) * np.hamming(65)
        taps /= taps.sum()
        y = np.stack([np.convolve(ch, taps, mode="same") for ch in y])
    n_out = int(round(y.shape[-1] * dst / src))
    t = np.arange(n_out) * (src / dst)
    idx = np.arange(y.shape[-1])
    out = np.stack([np.interp(t, idx, ch) for ch in y]).astype(np.float32)
    return out if x.ndim > 1 else out[0]


def fit_np(x: Any, frames: int, np: Any, fade: int = 0) -> Any:
    """Trim (with a ``fade``-frame fade-out at the cut) or zero-pad the last axis to ``frames``."""
    n = x.shape[-1]
    if n >= frames:
        y = x[..., :frames].copy()
        if fade and n > frames:
            k = min(fade, frames)
            y[..., frames - k :] *= np.linspace(1.0, 0.0, k, dtype=np.float32)
        return y
    pad = [(0, 0)] * (x.ndim - 1) + [(0, frames - n)]
    return np.pad(x, pad)


def to_channels_np(x: Any, channels: int, np: Any) -> Any:
    """``(c, n)`` → ``(channels, n)``: mono is duplicated, extra channels are averaged down."""
    x = np.atleast_2d(x)
    if x.shape[0] == channels:
        return x
    if channels == 1:
        return x.mean(axis=0, keepdims=True)
    if x.shape[0] == 1:
        return np.repeat(x, channels, axis=0)
    return x[:channels] if x.shape[0] > channels else np.concatenate([x] + [x[-1:]] * (channels - x.shape[0]))
