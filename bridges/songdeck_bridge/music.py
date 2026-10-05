"""
Helpers shared by the music-generation bridges (``MUSIC_BRIDGE_PATHS`` in
``packages/ai/src/contracts.ts``): request parsing (sections, lyrics, WAV fields, model ids),
fitting engine output to the requested length, splicing regenerated ranges into the original, and
reading the audio files engines write (WAV directly; FLAC/MP3/OGG through ffmpeg or the engine's
own Python with soundfile/torchaudio).
"""

from __future__ import annotations

import os
import re
import shutil
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import dsp
from .server import BadRequest, EngineError, NotFound, RequestContext, req_number, req_str, run_command
from .wav import Audio, WavError, decode_base64, fit_length, read_wav, resample_audio, wav_info, wav_layout, write_wav

__all__ = [
    "Section",
    "parse_sections",
    "parse_lyric_blocks",
    "lyrics_text",
    "wav_field",
    "resolve_model",
    "style_prompt",
    "fit_duration",
    "splice_range",
    "splice_extension",
    "find_audio_file",
    "fit_wav_bytes",
    "audio_file_to_wav",
    "lrc_timestamp",
    "env_with_pythonpath",
    "AUDIO_EXTENSIONS",
]

AUDIO_EXTENSIONS = (".wav", ".flac", ".mp3", ".ogg", ".m4a")


@dataclass
class Section:
    name: str
    start: float
    end: float
    prompt: str = ""


def parse_sections(raw: Optional[Sequence[Any]], duration: float) -> List[Section]:
    """Validated contract sections, sorted by start and clipped to ``[0, duration]`` (gaps are kept)."""
    out: List[Section] = []
    for i, s in enumerate(raw or []):
        if not isinstance(s, dict):
            raise BadRequest(f"sections[{i}] must be an object")
        try:
            name = req_str(s, "name", required=False, default="", max_len=200) or f"Section {i + 1}"
            start = req_number(s, "start_seconds", minimum=0)
            end = req_number(s, "end_seconds", minimum=0)
            prompt = req_str(s, "prompt", required=False, default="", max_len=4000) or ""
        except BadRequest as e:
            raise BadRequest(f"sections[{i}]: {e.message}") from None
        if end <= start:
            raise BadRequest(f"sections[{i}]: end_seconds must be greater than start_seconds")
        if start >= duration:
            continue
        out.append(Section(name, start, min(end, duration), prompt))
    out.sort(key=lambda s: s.start)
    return out


_TAG_RE = re.compile(r"^\s*\[([^\]]+)\]\s*$")


def parse_lyric_blocks(text: str) -> List[Tuple[str, List[str]]]:
    """``"[verse]\\nline…\\n\\n[chorus]\\n…"`` → ``[("verse", [lines]), ("chorus", [...])]``.

    Tags keep their text (lower-cased, e.g. ``"verse 2"``); untagged leading lines are a ``verse``.
    """
    blocks: List[Tuple[str, List[str]]] = []
    tag: Optional[str] = None
    lines: List[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        m = _TAG_RE.match(line)
        if m:
            if tag is not None or lines:
                blocks.append((tag or "verse", lines))
            tag, lines = m.group(1).strip().lower(), []
            continue
        if line:
            lines.append(line)
    if tag is not None or lines:
        blocks.append((tag or "verse", lines))
    return blocks


def lyrics_text(blocks: Sequence[Tuple[str, List[str]]]) -> str:
    """Blocks back to ``[tag]\\nlines`` paragraphs separated by blank lines."""
    return "\n\n".join(f"[{tag}]\n" + "\n".join(lines) for tag, lines in blocks).strip() + "\n"


def wav_field(body: Dict[str, Any], name: str, required: bool = True) -> Optional[bytes]:
    """A base64 WAV field as bytes (header-checked; 400 on bad data)."""
    text = req_str(body, name, required=required)
    if text is None:
        return None
    try:
        data = decode_base64(text, name)
        wav_info(data)
    except WavError as e:
        raise BadRequest(f"{name}: {e}") from None
    return data


def resolve_model(body: Dict[str, Any], model_ids: Sequence[str], default: str) -> str:
    m = req_str(body, "model", required=False, max_len=256)
    if not m:
        return default
    if m not in model_ids:
        raise NotFound(f"unknown model '{m}' (this bridge serves: {', '.join(model_ids)})")
    return m


def style_prompt(prompt: str, bpm: Optional[float] = None, key: Optional[str] = None, sep: str = ", ") -> str:
    """``"<prompt>, 120 bpm, E minor"`` (what most text-conditioned music models expect)."""
    parts = [prompt.strip().rstrip(",")]
    if bpm:
        parts.append(f"{bpm:g} bpm")
    if key:
        parts.append(key.strip())
    return sep.join(p for p in parts if p)


def fit_duration(audio: Audio, seconds: float, fade_s: float = 0.05) -> Audio:
    """Exactly ``seconds`` long: trims (with a short fade-out at the cut) or pads with silence."""
    frames = int(round(seconds * audio.sample_rate))
    trimmed = audio.frames > frames
    out = fit_length(audio, frames)
    if trimmed and fade_s > 0:
        n = min(frames, int(fade_s * audio.sample_rate))
        for ch in out.channels:
            for i in range(n):
                ch[frames - n + i] *= 1.0 - (i + 1) / n
    return out


def splice_range(orig: Audio, gen: Audio, start: float, end: float, xfade_s: float = 0.02) -> Audio:
    """``orig`` with [start, end) replaced by the same range of ``gen`` (crossfades inside the range)."""
    sr = orig.sample_rate
    s = int(round(start * sr))
    e = min(orig.frames, int(round(end * sr)))
    region = gen.slice(int(round(start * gen.sample_rate)), int(round(end * gen.sample_rate)))
    if region.sample_rate != sr:
        region = resample_audio(region, sr)
    region = fit_length(region.with_channels(orig.num_channels), e - s)
    xf = min(int(xfade_s * sr), (e - s) // 4)
    w = dsp.crossfade_weights(xf)
    out = []
    for ch, rg in zip(orig.channels, region.channels):
        rg = list(rg)
        for i in range(xf):
            rg[i] = ch[s + i] * (1.0 - w[i]) + rg[i] * w[i]
            j = e - s - 1 - i
            rg[j] = ch[s + j] * (1.0 - w[i]) + rg[j] * w[i]
        out.append(ch[:s] + rg + ch[e:])
    return orig.like(out)


def splice_extension(orig: Audio, gen: Audio, seconds: float, xfade_s: float = 0.02) -> Audio:
    """``orig`` + the continuation of ``gen`` after the original's length (short crossfade at the seam)."""
    sr = orig.sample_rate
    n = orig.frames
    g = (gen if gen.sample_rate == sr else resample_audio(gen, sr)).with_channels(orig.num_channels)
    tail = fit_length(g.slice(n), int(round(seconds * sr)))
    xf = min(int(xfade_s * sr), n, g.frames)
    w = dsp.crossfade_weights(xf)
    out = []
    for ch, gch, tch in zip(orig.channels, g.channels, tail.channels):
        head = list(ch)
        for i in range(xf):
            j = n - xf + i
            head[j] = ch[j] * (1.0 - w[i]) + gch[j] * w[i]
        out.append(head + list(tch))
    return orig.like(out)


def find_audio_file(
    directory: Path, prefer: Sequence[str] = (), avoid: Sequence[str] = (), exclude: Sequence[Path] = ()
) -> Optional[Path]:
    """The engine's output in ``directory`` (recursive): files whose name contains a ``prefer`` word
    win, then files without an ``avoid`` word; the newest wins among equals."""
    skip = {Path(p).resolve() for p in exclude}
    files = [
        p
        for p in Path(directory).rglob("*")
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS and p.resolve() not in skip
    ]
    if not files:
        return None

    def rank(p: Path) -> Tuple[int, int, float]:
        name = p.name.lower()
        pref = min((i for i, w in enumerate(prefer) if w in name), default=len(prefer))
        bad = 1 if any(w in name for w in avoid) else 0
        return (pref, bad, -p.stat().st_mtime)

    return sorted(files, key=rank)[0]


def _fmt_chunk(data: bytes) -> bytes:
    """The raw ``fmt `` chunk (header included) of a WAV file."""
    pos = 12
    while pos + 8 <= len(data):
        cid = data[pos : pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        if cid == b"fmt ":
            return data[pos : pos + 8 + size]
        if size >= 0xFFFFFFFF:
            break
        pos += 8 + size + (size & 1)
    raise WavError("missing fmt chunk")


def fit_wav_bytes(data: bytes, seconds: float, fade_s: float = 0.02) -> bytes:
    """A WAV of exactly ``seconds``: the samples are cut or zero-padded as bytes (no full decode,
    so long songs stay cheap); a cut gets a short fade-out when the format allows it."""
    lay = wav_layout(data)
    block = lay["container"] * lay["channels"]
    frames = int(round(seconds * lay["sample_rate"]))
    have = lay["frames"]
    body = bytearray(data[lay["offset"] : lay["offset"] + min(have, frames) * block])
    fmt = _fmt_chunk(data)
    if frames > have:
        body += bytes((frames - have) * block) if lay["container"] > 1 else b"\x80" * ((frames - have) * block)
    elif frames < have and fade_s > 0:
        n = min(frames, int(fade_s * lay["sample_rate"]))
        tail_off = (frames - n) * block
        tail = bytes(fmt) + b"data" + struct.pack("<I", n * block) + bytes(body[tail_off:])
        try:
            audio = read_wav(b"RIFF" + struct.pack("<I", 4 + len(tail)) + b"WAVE" + tail)
            for ch in audio.channels:
                for k in range(n):
                    ch[k] *= 1.0 - (k + 1) / n
            faded = write_wav(audio)
            fl = wav_layout(faded)
            if fl["container"] == lay["container"]:
                body[tail_off:] = faded[fl["offset"] : fl["offset"] + n * block]
        except WavError:
            pass  # exotic formats (8-bit, 64-bit float): a plain cut
    chunks = bytes(fmt) + b"data" + struct.pack("<I", len(body)) + bytes(body) + (b"\x00" if len(body) & 1 else b"")
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


_CONVERT_SCRIPT = (
    "import sys\n"
    "src, dst = sys.argv[1:3]\n"
    "try:\n"
    "    import soundfile as sf\n"
    "    data, sr = sf.read(src, dtype='float32', always_2d=True)\n"
    "    sf.write(dst, data, sr, subtype='FLOAT')\n"
    "except Exception:\n"
    "    import torchaudio\n"
    "    wav, sr = torchaudio.load(src)\n"
    "    torchaudio.save(dst, wav, sr, encoding='PCM_F', bits_per_sample=32)\n"
)


def audio_file_to_wav(
    path: Path,
    ctx: Optional[RequestContext] = None,
    *,
    python: Optional[str] = None,
    ffmpeg: Optional[str] = None,
    timeout: float = 600.0,
) -> bytes:
    """WAV bytes of an engine output file. WAV files are returned as they are (after a header
    check); FLAC/MP3/OGG are converted with ``ffmpeg`` (when found) or with ``python`` (the
    engine's interpreter: soundfile, then torchaudio) to 32-bit float WAV."""
    path = Path(path)
    if path.suffix.lower() == ".wav":
        data = path.read_bytes()
        try:
            wav_layout(data)
            return data
        except WavError:
            pass  # a WAV variant the toolkit does not parse: convert below
    with tempfile.TemporaryDirectory(prefix="songdeck-decode-") as tmp:
        dst = Path(tmp, "decoded.wav")
        tool = ffmpeg or shutil.which("ffmpeg")
        errors: List[str] = []
        if tool:
            try:
                run_command(
                    [tool, "-nostdin", "-y", "-loglevel", "error", "-i", str(path), "-c:a", "pcm_f32le", str(dst)],
                    ctx,
                    timeout=timeout,
                    name="ffmpeg",
                )
            except EngineError as e:
                errors.append(e.message)
        if not dst.is_file() and python:
            try:
                run_command([python, "-c", _CONVERT_SCRIPT, str(path), str(dst)], ctx, timeout=timeout, name="decode")
            except EngineError as e:
                errors.append(e.message)
        if not dst.is_file():
            hint = "; ".join(errors) or "install ffmpeg, or soundfile in the engine's Python"
            raise EngineError(f"cannot decode the engine output {path.name} ({hint})")
        data = dst.read_bytes()
    try:
        wav_layout(data)
    except WavError as e:
        raise EngineError(f"the decoded engine output is not readable ({e})") from None
    return data


def lrc_timestamp(t: float) -> str:
    """LRC timestamp ``mm:ss.xx``."""
    t = max(0.0, t)
    m = int(t // 60)
    s = t - 60 * m
    return f"{m:02d}:{s:05.2f}"


def env_with_pythonpath(root: Optional[str]) -> Optional[Dict[str, str]]:
    """``os.environ`` with ``root`` prepended to PYTHONPATH (what engine checkouts' scripts expect)."""
    if not root:
        return None
    env = dict(os.environ)
    env["PYTHONPATH"] = root + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    return env


def engine_check(python: str, modules: Sequence[str], hint: str, cwd: Optional[str] = None) -> Any:
    """A loader body for CLI engines: verify that ``python`` can import ``modules`` (in a subprocess).

    Used with :class:`~songdeck_bridge.server.ModelLoader`, so a missing engine shows up in
    ``/health`` and in the job's error (with ``hint``) instead of stopping the bridge at startup.
    """
    import subprocess

    code = "import " + ", ".join(modules) + "; print('ok')"

    def check() -> str:
        try:
            r = subprocess.run([python, "-c", code], capture_output=True, text=True, timeout=300, cwd=cwd)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise RuntimeError(f"could not run {python}: {e}. {hint}") from None
        if r.returncode != 0:
            last = ((r.stderr or r.stdout).strip().splitlines() or ["no output"])[-1]
            raise RuntimeError(f"{python} cannot import {', '.join(modules)} ({last}). {hint}")
        return python

    return check
