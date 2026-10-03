"""
WAV I/O and small audio helpers using only the standard library (``struct`` + ``array``).

Song Deck sends and receives audio as complete WAV files (base64 inside JSON, raw bytes in
``audio/wav`` responses): PCM 16/24-bit or 32-bit float, any sample rate, mono or stereo. This
module reads every common variant (PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE,
RF64/BW64, streamed files whose sizes are 0 or 0xFFFFFFFF) and writes PCM 16/24/32-bit and
32-bit float.

Python's own ``wave`` module is not used for decoding because it cannot read IEEE-float WAVs
(format 3), which DAWs and ML engines (torchaudio, soundfile) produce all the time.

Audio is held in :class:`Audio`: ``channels`` is a list with one Python ``list`` of floats per
channel, nominally in [-1, 1]. Plain lists keep the toolkit dependency-free; the per-sample work
is done with list comprehensions and C-level slicing so a minute of stereo audio converts in well
under a second.

PCM round trips are exact: a 16-bit sample ``k`` is read as ``k / 32768`` and written back as
``k`` (same for 24/32-bit), so untouched regions of an edited file stay bit-identical.
"""

from __future__ import annotations

import base64
import binascii
import math
import random
import struct
import sys
from array import array
from typing import List, Optional, Sequence

__all__ = [
    "Audio",
    "WavError",
    "read_wav",
    "write_wav",
    "wav_info",
    "decode_base64",
    "encode_base64",
    "audio_from_base64",
    "audio_to_base64",
    "resample",
    "resample_audio",
    "fit_length",
    "silence",
    "interleave",
]

FORMAT_PCM = 0x0001
FORMAT_FLOAT = 0x0003
FORMAT_EXTENSIBLE = 0xFFFE

MAX_CHANNELS = 32
MAX_SAMPLE_RATE = 1_536_000

_LITTLE = sys.byteorder == "little"

# array typecode for 32-bit signed integers ('i' is 4 bytes on every mainstream platform).
_I32 = "i" if array("i").itemsize == 4 else "l"
if array(_I32).itemsize != 4:  # pragma: no cover - exotic platforms only
    raise ImportError("songdeck_bridge.wav needs a 32-bit array typecode")


class WavError(ValueError):
    """The bytes are not a WAV file this module can read (or a parameter is invalid)."""


class Audio:
    """Decoded audio: ``channels[c][i]`` is sample ``i`` of channel ``c`` (float, nominally -1..1).

    ``bits`` / ``is_float`` remember the source encoding so edits can be written back in the same
    format (keeping untouched samples bit-identical).
    """

    __slots__ = ("sample_rate", "channels", "bits", "is_float")

    def __init__(self, sample_rate: int, channels: List[List[float]], bits: int = 16, is_float: bool = False):
        if not channels:
            raise WavError("audio needs at least one channel")
        n = len(channels[0])
        for ch in channels:
            if len(ch) != n:
                raise WavError("all channels must have the same length")
        sr = int(round(sample_rate))
        if sr <= 0 or sr > MAX_SAMPLE_RATE:
            raise WavError(f"invalid sample rate {sample_rate}")
        self.sample_rate = sr
        self.channels = [ch if isinstance(ch, list) else list(ch) for ch in channels]
        self.bits = bits
        self.is_float = is_float

    @property
    def frames(self) -> int:
        return len(self.channels[0])

    @property
    def num_channels(self) -> int:
        return len(self.channels)

    @property
    def duration(self) -> float:
        return self.frames / float(self.sample_rate)

    def copy(self) -> "Audio":
        return Audio(self.sample_rate, [list(ch) for ch in self.channels], self.bits, self.is_float)

    def like(self, channels: List[List[float]]) -> "Audio":
        """New audio with the same sample rate and source format but other samples."""
        return Audio(self.sample_rate, channels, self.bits, self.is_float)

    def mono(self) -> List[float]:
        """Average of all channels (a new list)."""
        if len(self.channels) == 1:
            return list(self.channels[0])
        k = 1.0 / len(self.channels)
        return [sum(frame) * k for frame in zip(*self.channels)]

    def with_channels(self, count: int) -> "Audio":
        """Up/down-mix to ``count`` channels (mono is duplicated; extra channels are averaged)."""
        if count == len(self.channels):
            return self.copy()
        if count < 1:
            raise WavError("channel count must be >= 1")
        if count == 1:
            return self.like([self.mono()])
        if len(self.channels) == 1:
            src = self.channels[0]
            return self.like([list(src) for _ in range(count)])
        if count < len(self.channels):
            return self.like([list(ch) for ch in self.channels[:count]])
        extra = [list(self.channels[-1]) for _ in range(count - len(self.channels))]
        return self.like([list(ch) for ch in self.channels] + extra)

    def slice(self, start: int, end: Optional[int] = None) -> "Audio":
        """Frames [start, end) (clamped)."""
        n = self.frames
        start = max(0, min(n, int(start)))
        end = n if end is None else max(start, min(n, int(end)))
        return self.like([ch[start:end] for ch in self.channels])

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        kind = "float" if self.is_float else f"pcm{self.bits}"
        return f"Audio({self.sample_rate} Hz, {self.num_channels} ch, {self.frames} frames, {kind})"


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def _parse_chunks(data: bytes):
    """Return (fmt tuple, data offset, data length). Raises WavError."""
    n = len(data)
    if n < 12:
        raise WavError("not a WAV file (too short)")
    riff = data[0:4]
    if riff not in (b"RIFF", b"RF64", b"BW64") or data[8:12] != b"WAVE":
        raise WavError("not a RIFF/WAVE file")
    pos = 12
    fmt = None
    data_off = None
    data_len = 0
    ds64_data_size = None
    while pos + 8 <= n:
        cid = data[pos : pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        body = pos + 8
        if cid == b"ds64" and size >= 16 and body + 16 <= n:
            ds64_data_size = struct.unpack_from("<Q", data, body + 8)[0]
        elif cid == b"fmt ":
            if size < 16 or body + 16 > n:
                raise WavError("fmt chunk is truncated")
            tag, nch, rate, _byte_rate, block_align, bits = struct.unpack_from("<HHIIHH", data, body)
            if tag == FORMAT_EXTENSIBLE:
                if size < 40 or body + 26 > n:
                    raise WavError("WAVE_FORMAT_EXTENSIBLE fmt chunk is truncated")
                tag = struct.unpack_from("<H", data, body + 24)[0]  # SubFormat GUID's first two bytes
            fmt = (tag, nch, rate, block_align, bits)
        elif cid == b"data":
            if size == 0xFFFFFFFF and ds64_data_size is not None:
                size = ds64_data_size
            if size in (0, 0xFFFFFFFF) or body + size > n:
                size = n - body  # streamed (unknown size) or truncated file: take what is there
            data_off, data_len = body, size
            if fmt is not None:
                break
        if size >= 0xFFFFFFFF:
            break
        pos = body + size + (size & 1)  # chunks are word aligned
    if fmt is None:
        raise WavError("missing fmt chunk")
    if data_off is None:
        raise WavError("missing data chunk")
    return fmt, data_off, data_len


def wav_info(data: bytes) -> dict:
    """Header facts without decoding samples: sample_rate, channels, bits, float, frames, duration."""
    if not isinstance(data, bytes):
        data = bytes(data)
    (tag, nch, rate, block_align, bits), _off, length = _parse_chunks(data)
    if not nch or not rate:
        raise WavError("fmt chunk has zero channels or sample rate")
    align = block_align or max(1, bits // 8) * nch
    frames = length // align
    return {
        "sample_rate": rate,
        "channels": nch,
        "bits": bits,
        "float": tag == FORMAT_FLOAT,
        "format_tag": tag,
        "frames": frames,
        "duration": frames / float(rate),
    }


def _sanitize(values: List[float]) -> List[float]:
    """Replace NaN/inf (only when present; the check is a single C-level sum)."""
    total = sum(values)  # NaN/inf propagate (and huge values overflow to inf)
    if math.isfinite(total):
        return values
    return [v if (v == v and -1e30 < v < 1e30) else 0.0 for v in values]


def read_wav(data: bytes) -> Audio:
    """Decode WAV bytes (PCM 8/16/24/32-bit, float 32/64, extensible, RF64) into :class:`Audio`."""
    if isinstance(data, memoryview):
        data = data.tobytes()
    elif isinstance(data, bytearray):
        data = bytes(data)
    if not isinstance(data, bytes):
        raise WavError("WAV data must be bytes")
    (tag, nch, rate, block_align, bits), off, length = _parse_chunks(data)
    if nch < 1 or nch > MAX_CHANNELS:
        raise WavError(f"unsupported channel count {nch}")
    if rate < 1 or rate > MAX_SAMPLE_RATE:
        raise WavError(f"unsupported sample rate {rate}")
    container = (block_align // nch) if block_align and block_align % nch == 0 else (bits + 7) // 8
    if tag == FORMAT_FLOAT:
        if container not in (4, 8):
            raise WavError(f"unsupported float WAV ({bits}-bit); use 32-bit float")
    elif tag == FORMAT_PCM:
        if container not in (1, 2, 3, 4):
            raise WavError(f"unsupported PCM WAV ({bits}-bit); use 16/24-bit PCM or 32-bit float")
    else:
        raise WavError(f"unsupported WAV encoding (format tag 0x{tag:04x}); use PCM 16/24-bit or 32-bit float")
    frames = length // (container * nch)
    raw = data[off : off + frames * container * nch]
    if tag == FORMAT_FLOAT:
        arr = array("f" if container == 4 else "d")
        arr.frombytes(raw)
        if not _LITTLE:
            arr.byteswap()
        inter = _sanitize(arr.tolist())
        out_bits, is_float = 32, True
    elif container == 2:
        arr = array("h")
        arr.frombytes(raw)
        if not _LITTLE:
            arr.byteswap()
        k = 1.0 / 32768.0
        inter = [v * k for v in arr]
        out_bits, is_float = 16, False
    elif container == 3:
        count = frames * nch
        buf = bytearray(count * 4)  # 24-bit little-endian → left-justified int32
        buf[1::4] = raw[0::3]
        buf[2::4] = raw[1::3]
        buf[3::4] = raw[2::3]
        arr = array(_I32)
        arr.frombytes(bytes(buf))
        if not _LITTLE:
            arr.byteswap()
        k = 1.0 / 2147483648.0
        inter = [v * k for v in arr]
        out_bits, is_float = 24, False
    elif container == 4:
        arr = array(_I32)
        arr.frombytes(raw)
        if not _LITTLE:
            arr.byteswap()
        k = 1.0 / 2147483648.0
        inter = [v * k for v in arr]
        out_bits, is_float = 32, False
    else:  # 8-bit unsigned
        k = 1.0 / 128.0
        inter = [(v - 128) * k for v in raw]
        out_bits, is_float = 16, False  # written back as 16-bit
    channels = [inter] if nch == 1 else [inter[c::nch] for c in range(nch)]
    return Audio(rate, channels, out_bits, is_float)


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def interleave(channels: Sequence[Sequence[float]]) -> List[float]:
    """[[L0, L1…], [R0, R1…]] → [L0, R0, L1, R1, …] (C-level slice assignment)."""
    nch = len(channels)
    if nch == 1:
        return list(channels[0])
    frames = len(channels[0])
    out = [0.0] * (frames * nch)
    for c, ch in enumerate(channels):
        out[c::nch] = ch
    return out


def _fmt_chunk(tag: int, nch: int, rate: int, bits: int) -> bytes:
    block_align = nch * (bits // 8)
    if tag == FORMAT_FLOAT:
        return b"fmt " + struct.pack("<IHHIIHHH", 18, tag, nch, rate, rate * block_align, block_align, bits, 0)
    return b"fmt " + struct.pack("<IHHIIHH", 16, tag, nch, rate, rate * block_align, block_align, bits)


def write_wav(
    audio: Audio, bits: Optional[int] = None, is_float: Optional[bool] = None, dither: bool = False, seed: int = 0
) -> bytes:
    """Encode :class:`Audio` as WAV bytes.

    ``bits``/``is_float`` default to the audio's source format. PCM is 16, 24 or 32-bit (values are
    clipped to full scale); float is 32-bit IEEE. ``dither`` adds deterministic TPDF dither (±1 LSB)
    before quantizing to 16-bit or less.
    """
    use_float = audio.is_float if is_float is None else bool(is_float)
    nbits = 32 if use_float else int(bits or audio.bits or 16)
    if not use_float and nbits not in (16, 24, 32):
        raise WavError(f"unsupported output bit depth {nbits} (use 16, 24 or 32)")
    nch = audio.num_channels
    frames = audio.frames
    rate = audio.sample_rate
    inter = interleave(audio.channels)
    if use_float:
        inter = _sanitize(inter)
        lim = 3.0e38
        if inter and max(map(abs, inter)) > lim:
            inter = [lim if v > lim else (-lim if v < -lim else v) for v in inter]
        arr = array("f", inter)
        if not _LITTLE:
            arr.byteswap()
        payload = arr.tobytes()
        tag = FORMAT_FLOAT
    else:
        full = float(1 << (nbits - 1))
        hi = (full - 1.0) / full
        inter = _sanitize(inter)
        if dither and nbits <= 16 and inter:
            rnd = random.Random(seed).random
            lsb = 1.0 / full
            inter = [v + (rnd() - rnd()) * lsb for v in inter]
        if inter and (max(inter) > hi or min(inter) < -1.0):
            inter = [hi if v > hi else (-1.0 if v < -1.0 else v) for v in inter]
        off = full + 0.5
        fi = int(full)
        ints = [int(v * full + off) - fi for v in inter]  # floor(v * full + 0.5), v >= -1
        if nbits == 16:
            arr = array("h", ints)
            if not _LITTLE:
                arr.byteswap()
            payload = arr.tobytes()
        else:
            arr = array(_I32, ints)
            if not _LITTLE:
                arr.byteswap()
            b = arr.tobytes()
            if nbits == 32:
                payload = b
            else:
                out = bytearray(len(ints) * 3)
                out[0::3] = b[0::4]
                out[1::3] = b[1::4]
                out[2::3] = b[2::4]
                payload = bytes(out)
        tag = FORMAT_PCM
    fmt = _fmt_chunk(tag, nch, rate, nbits)
    fact = b"fact" + struct.pack("<II", 4, frames) if tag == FORMAT_FLOAT else b""
    pad = b"\x00" if len(payload) & 1 else b""
    data_hdr = b"data" + struct.pack("<I", len(payload))
    riff_size = 4 + len(fmt) + len(fact) + len(data_hdr) + len(payload) + len(pad)
    return b"".join((b"RIFF", struct.pack("<I", riff_size), b"WAVE", fmt, fact, data_hdr, payload, pad))


# ---------------------------------------------------------------------------
# Base64 (audio inside JSON)
# ---------------------------------------------------------------------------

_URLSAFE = str.maketrans("-_", "+/")


def decode_base64(text: object, field: str = "audio_base64") -> bytes:
    """Decode standard base64 (tolerates whitespace, missing padding, URL-safe alphabet, data: URLs)."""
    if not isinstance(text, str):
        raise WavError(f"{field} must be a base64 string")
    s = text.strip()
    if s.startswith("data:"):
        comma = s.find(",")
        s = s[comma + 1 :] if comma >= 0 else ""
    if " " in s or "\n" in s or "\r" in s or "\t" in s:
        s = "".join(s.split())
    if "-" in s or "_" in s:
        s = s.translate(_URLSAFE)
    s = s.rstrip("=")
    if len(s) % 4 == 1:
        raise WavError(f"{field} is not valid base64 (bad length)")
    s += "=" * (-len(s) % 4)
    try:
        return base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        raise WavError(f"{field} is not valid base64") from None


def encode_base64(data: bytes) -> str:
    """Standard base64 (RFC 4648, padded, no line breaks) — what Song Deck expects."""
    return base64.b64encode(data).decode("ascii")


def audio_from_base64(text: object, field: str = "audio_base64") -> Audio:
    """base64 WAV → :class:`Audio` (WavError messages name the field)."""
    raw = decode_base64(text, field)
    if not raw:
        raise WavError(f"{field} is empty")
    try:
        return read_wav(raw)
    except WavError as e:
        raise WavError(f"{field}: {e}") from None


def audio_to_base64(audio: Audio, bits: Optional[int] = None, is_float: Optional[bool] = None) -> str:
    return encode_base64(write_wav(audio, bits=bits, is_float=is_float))


# ---------------------------------------------------------------------------
# Resampling and length helpers
# ---------------------------------------------------------------------------


def _box_smooth(x: List[float], width: int) -> List[float]:
    """Centered moving average (C-level cumulative sums); used as a cheap anti-alias filter."""
    if width <= 1 or len(x) < 2:
        return list(x)
    from itertools import accumulate

    half = width // 2
    padded = [x[0]] * half + list(x) + [x[-1]] * (width - half)
    cs = [0.0]
    cs.extend(accumulate(padded))
    k = 1.0 / width
    n = len(x)
    return [(cs[i + width] - cs[i]) * k for i in range(n)]


def resample(samples: Sequence[float], src_rate: float, dst_rate: float, quality: str = "cubic") -> List[float]:
    """Resample one channel from ``src_rate`` to ``dst_rate``.

    ``quality``: ``"linear"`` or ``"cubic"`` (4-point Catmull-Rom). Downsampling first applies a
    two-pass moving-average low-pass so content above the new Nyquist is attenuated. Good enough
    for analysis, previews and mock rendering — use a proper resampler (soxr, libsamplerate) for
    mastering-grade conversions.
    """
    x = list(samples)
    if not x or src_rate == dst_rate:
        return x
    if src_rate <= 0 or dst_rate <= 0:
        raise WavError("sample rates must be > 0")
    ratio = float(src_rate) / float(dst_rate)  # input samples per output sample
    n_out = max(1, int(round(len(x) / ratio)))
    if ratio > 1.0:
        width = int(math.ceil(ratio))
        x = _box_smooth(_box_smooth(x, width), width)
    last = len(x) - 1
    if last == 0:
        return [x[0]] * n_out
    out = [0.0] * n_out
    if quality == "linear":
        for i in range(n_out):
            p = i * ratio
            k = int(p)
            if k >= last:
                out[i] = x[last]
                continue
            a = x[k]
            out[i] = a + (p - k) * (x[k + 1] - a)
        return out
    for i in range(n_out):
        p = i * ratio
        k = int(p)
        t = p - k
        x1 = x[k] if k <= last else x[last]
        x0 = x[k - 1] if k >= 1 else x1
        x2 = x[k + 1] if k + 1 <= last else x[last]
        x3 = x[k + 2] if k + 2 <= last else x[last]
        out[i] = x1 + 0.5 * t * (x2 - x0 + t * (2.0 * x0 - 5.0 * x1 + 4.0 * x2 - x3 + t * (3.0 * (x1 - x2) + x3 - x0)))
    return out


def resample_audio(audio: Audio, dst_rate: int, quality: str = "cubic") -> Audio:
    if int(dst_rate) == audio.sample_rate:
        return audio.copy()
    chans = [resample(ch, audio.sample_rate, dst_rate, quality) for ch in audio.channels]
    return Audio(int(dst_rate), chans, audio.bits, audio.is_float)


def fit_length(audio: Audio, frames: int) -> Audio:
    """Pad with silence or truncate to exactly ``frames`` frames."""
    frames = max(0, int(frames))
    n = audio.frames
    if frames == n:
        return audio.copy()
    if frames < n:
        return audio.like([ch[:frames] for ch in audio.channels])
    pad = [0.0] * (frames - n)
    return audio.like([ch + pad for ch in audio.channels])


def silence(frames: int, channels: int = 1, sample_rate: int = 44100, bits: int = 16, is_float: bool = False) -> Audio:
    return Audio(sample_rate, [[0.0] * max(0, int(frames)) for _ in range(max(1, channels))], bits, is_float)
