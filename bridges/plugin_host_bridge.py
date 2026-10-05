#!/usr/bin/env python3
"""
Song Deck INSTRUMENT PLUGIN HOST bridge — renders MIDI through installed instrument plugins
(VST3, Audio Units, VST2, CLAP, LV2, SoundFonts, SFZ), offline, like a DAW "freeze".

Contract (packages/ai/src/contracts.ts, PLUGIN_HOST_PATHS)::

    GET  /info                   → {name, version, formats: [{format, available, backend, note?}],
                                    capabilities: ["INSTRUMENT_PLUGIN_HOST"], editor, search_paths}
    GET  /plugins                → {plugins: [{id, name, format, vendor?, version?, category, path, loadable}]}
    POST /plugins {paths?}       → the same after a rescan (extra files/directories are remembered)
    POST /plugins/describe {plugin_id}
                                 → plugin + {parameters, presets, has_editor, latency_samples}
    POST /render {plugin_id, state_base64?, parameters?, preset?, sample_rate, channels?,
                  duration_seconds, events: [{time_seconds, data: [status, …]}], block_size?}
                                 → audio/wav (32-bit float; X-Plugin-Latency, X-Model: <plugin id>)
    POST /editor {plugin_id, state_base64?, parameters?, preset?}
                                 → {plugin_id, state_base64, parameters, preset?} when the window closes
    POST /state  (same body)     → the same, without a window
    POST /cancel {job_id?} → 204 · GET /health

Formats and backends (the first available backend wins; ``--command FORMAT=TEMPLATE`` overrides)::

    format  backend(s)                                   install
    vst3    pedalboard, else DawDreamer                  pip install pedalboard mido | pip install dawdreamer
    au      pedalboard (macOS)                           pip install pedalboard
    vst2    DawDreamer                                   pip install dawdreamer
    clap    command template (--clap-command)            e.g. a clap-host CLI of your choice
    lv2     command template (--lv2-command)             e.g. a jalv/lv2 render CLI of your choice
    sf2     FluidSynth: pyfluidsynth, else the CLI       pip install pyfluidsynth | apt/brew install fluidsynth
    sfz     sfizz_render (sfizz CLI)                     https://sfz.tools/sfizz
    wam     not hostable here (Web Audio Modules run in the Song Deck studio)

Command templates (no shell: the template is split into arguments first, then the placeholders
are filled) know ``{plugin}`` (file or bundle path), ``{uri}`` (LV2 URI or sub-plugin name),
``{name}``, ``{midi}`` (Standard MIDI File of the events), ``{output}`` (WAV to write),
``{sample_rate}``, ``{duration}``, ``{channels}``, ``{block_size}``, ``{state}`` (file with the
decoded state, empty when none), ``{params}`` (JSON file of the parameters), ``{preset}``,
``{fluidsynth}`` and ``{sfizz}`` (tool paths) and ``{python}``.

Plugin ids are ``<format>:<absolute path>`` plus ``#<sub-plugin name>`` for VST3/AU shells and
``#<URI>`` for LV2. A request may only name a plugin found by the scan, or an existing file or
bundle of that format under a scanned directory (default plugin folders, ``--plugin-path``, or
``paths`` sent to ``POST /plugins``). Nothing else is ever loaded or passed to a command.

Rendering: the output is exactly ``duration_seconds`` long at ``sample_rate`` with ``channels``
channels, already aligned (latency compensated); ``X-Plugin-Latency`` reports the latency the
plugin declared, for information. Requests are idempotent: every request starts from the plugin's
default state, then applies ``state_base64`` → ``preset`` → ``parameters``.

Parameter values are the plugin's normalized values (0..1) for VST3/AU/VST2 (DawDreamer ids are
parameter indices); SoundFont parameters report their own ``min``/``max``. MIDI-CC mapping
pseudo-parameters ("MIDI Ch. 1 CC 7", which DAWs hide) are left out. State blobs:
VST3/AU/VST2 = ``SDPS\x01`` + JSON parameter values + the plugin's own state (pedalboard
``raw_state``, else ``preset_data``; DawDreamer ``save_state``) because some plugins keep parameter
values out of their own state; a blob without that header is applied as the plugin's raw state.
SoundFonts = JSON ``{"bank", "program", "gain", "reverb", "chorus"}``; command plugins = whatever
the request sent (passed to the command as ``{state}``).

Threads: JUCE-based hosts (pedalboard, DawDreamer) only reload/reset plugins on the process's main
thread, and macOS only opens windows there, so ``serve()`` services a main-thread queue and every
pedalboard/DawDreamer request runs on it, one at a time (other backends run on request threads).
Applying a different state can reload the whole plugin (seconds for some plugins); a request with
the same state as the previous one only restores the parameters that changed. Native editors
(pedalboard ``show_editor``) open on that thread and close when the request is cancelled or the
bridge stops; while one is open, other pedalboard/DawDreamer requests wait. ``/info.editor`` is
true on macOS and Windows when pedalboard is installed (``--no-editor`` turns it off); elsewhere
``/editor`` answers 501.

SECURITY: plugins are native code running inside this process (a crashing plugin takes the
bridge down). Only install plugins you trust; the bridge only loads plugins found in its scan
paths.

Install and run::

    pip install pedalboard mido            # VST3 (+ Audio Units on macOS)
    pip install dawdreamer                 # VST2 (and VST3 without pedalboard)
    pip install pyfluidsynth               # SoundFonts (or install the fluidsynth CLI)
    python3 bridges/plugin_host_bridge.py [--plugin-path ~/MyPlugins] [--clap-command "…"]   # :8817

In Song Deck: Settings → Providers → Add provider, preset ``plugin-host-local``.

This is REFERENCE code: the scan, ids, MIDI files, FluidSynth CLI and command plumbing were
exercised against real files and a stand-in renderer; the pedalboard/DawDreamer calls are isolated
in the marked functions below (``pb_*``, ``DawDreamerInstance``) to adapt across versions.
"""

from __future__ import annotations

import json
import os
import plistlib
import re
import shutil
import struct
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from songdeck_bridge import __version__  # noqa: E402
from songdeck_bridge.cli import (  # noqa: E402
    MainThreadRunner,
    app_options,
    build_parser,
    check_bind,
    fail,
    module_available,
    serve,
    setup_logging,
)
from songdeck_bridge.midi import MidiEvent, note_spans, used_channels, write_smf  # noqa: E402
from songdeck_bridge.pluginhost import (  # noqa: E402
    CAPABILITY,
    PLUGIN_FORMATS,
    RenderRequest,
    StateRequest,
    parse_render_request,
    parse_scan_paths,
    parse_state_request,
    state_response,
)
from songdeck_bridge.server import (  # noqa: E402
    BadRequest,
    BridgeApp,
    Busy,
    EngineError,
    NotFound,
    NotSupported,
    RequestContext,
    command_from_template,
    json_response,
    req_str,
    run_command,
    wav_response,
)
from songdeck_bridge.wav import Audio, WavError, fit_length, read_wav, resample_audio, write_wav  # noqa: E402

DEFAULT_PORT = 8817
PLACEHOLDERS = (
    "plugin",
    "uri",
    "name",
    "midi",
    "output",
    "sample_rate",
    "duration",
    "channels",
    "block_size",
    "state",
    "params",
    "preset",
    "fluidsynth",
    "sfizz",
    "python",
)
DEFAULT_SFZ_COMMAND = (
    "{sfizz} --sfz {plugin} --midi {midi} --wav {output} --samplerate {sample_rate} --blocksize {block_size} --use-eot"
)
#: bundle directories (never descended into) and single-file plugins, by extension
BUNDLE_EXTS = {".vst3": "vst3", ".component": "au", ".vst": "vst2", ".clap": "clap", ".lv2": "lv2"}
FILE_EXTS = {".vst3": "vst3", ".clap": "clap", ".sf2": "sf2", ".sf3": "sf2", ".sfz": "sfz"}
VST2_BINARY_EXTS = (".dll", ".so")  # only counted as VST2 inside a VST folder (see is_vst2_binary)
FORMAT_EXTS = {
    "vst3": (".vst3",),
    "au": (".component",),
    "vst2": (".vst", ".dll", ".so"),
    "clap": (".clap",),
    "lv2": (".lv2",),
    "sf2": (".sf2", ".sf3"),
    "sfz": (".sfz",),
}
MAIN_THREAD_BACKENDS = ("pedalboard", "dawdreamer")
INSTALL_HINTS = {
    "pedalboard": "pip install pedalboard mido",
    "dawdreamer": "pip install dawdreamer",
    "fluidsynth": "pip install pyfluidsynth (needs the FluidSynth library) or install the fluidsynth command line",
    "sfizz": "install sfizz (https://sfz.tools/sfizz), which provides sfizz_render, or set --sfz-command",
}
EXTRA_ROOTS_MAX = 64
#: VST3 plugins built with JUCE/DPF expose MIDI-CC mapping parameters that DAWs hide
HIDDEN_PARAM_RE = re.compile(r"^MIDI (Ch\.? ?\d+ )?CC ?\d+$", re.I)


# ===========================================================================
# Search paths
# ===========================================================================


def _env_paths(name: str) -> List[str]:
    return [p for p in (os.environ.get(name) or "").split(os.pathsep) if p.strip()]


def default_search_paths() -> List[Tuple[str, Optional[str]]]:
    """Standard plugin and sound folders of this OS as ``(directory, format hint)``."""
    home = os.path.expanduser("~")
    out: List[Tuple[str, Optional[str]]] = []

    def add(fmt: Optional[str], *dirs: str) -> None:
        out.extend((d, fmt) for d in dirs if d)

    if sys.platform == "darwin":
        for base in ("/Library/Audio/Plug-Ins", os.path.join(home, "Library/Audio/Plug-Ins")):
            add("vst3", os.path.join(base, "VST3"))
            add("au", os.path.join(base, "Components"))
            add("vst2", os.path.join(base, "VST"))
            add("clap", os.path.join(base, "CLAP"))
            add("lv2", os.path.join(base, "LV2"))
        add(
            "sf2",
            "/Library/Audio/Sounds/Banks",
            os.path.join(home, "Library/Audio/Sounds/Banks"),
            os.path.join(home, "Documents/SoundFonts"),
        )
        add("sfz", os.path.join(home, "Documents/SFZ"))
    elif os.name == "nt":
        common = os.environ.get("COMMONPROGRAMFILES") or r"C:\Program Files\Common Files"
        progs = os.environ.get("PROGRAMFILES") or r"C:\Program Files"
        local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        appdata = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
        add("vst3", os.path.join(common, "VST3"), os.path.join(local, "Programs", "Common", "VST3"))
        add(
            "vst2",
            os.path.join(progs, "VSTPlugins"),
            os.path.join(progs, "Steinberg", "VSTPlugins"),
            os.path.join(common, "VST2"),
            os.path.join(common, "Steinberg", "VST2"),
        )
        add("clap", os.path.join(common, "CLAP"), os.path.join(local, "Programs", "Common", "CLAP"))
        add("lv2", os.path.join(common, "LV2"), os.path.join(appdata, "LV2"))
        add("sf2", os.path.join(home, "Documents", "SoundFonts"))
        add("sfz", os.path.join(home, "Documents", "SFZ"))
    else:
        add("vst3", os.path.join(home, ".vst3"), "/usr/lib/vst3", "/usr/local/lib/vst3", "/usr/lib64/vst3")
        add(
            "vst2",
            os.path.join(home, ".vst"),
            "/usr/lib/vst",
            "/usr/local/lib/vst",
            os.path.join(home, ".lxvst"),
            "/usr/lib/lxvst",
        )
        add("clap", os.path.join(home, ".clap"), "/usr/lib/clap", "/usr/local/lib/clap")
        add("lv2", os.path.join(home, ".lv2"), "/usr/lib/lv2", "/usr/local/lib/lv2", "/usr/lib64/lv2")
        add(
            "sf2",
            "/usr/share/sounds/sf2",
            "/usr/share/sounds/sf3",
            "/usr/share/soundfonts",
            os.path.join(home, ".local/share/soundfonts"),
            os.path.join(home, ".soundfonts"),
            os.path.join(home, "Documents/SoundFonts"),
        )
        add("sfz", "/usr/share/sounds/sfz", os.path.join(home, ".local/share/sfz"), os.path.join(home, "Documents/SFZ"))
    for env, fmt in (("VST3_PATH", "vst3"), ("VST_PATH", "vst2"), ("CLAP_PATH", "clap"), ("LV2_PATH", "lv2")):
        add(fmt, *_env_paths(env))
    return out


# ===========================================================================
# Plugins and scanning (no plugin is loaded: names come from file names and bundle metadata)
# ===========================================================================


@dataclass
class Plugin:
    id: str
    name: str
    format: str
    path: str
    sub: Optional[str] = None  # VST3/AU sub-plugin name or LV2 URI
    vendor: Optional[str] = None
    version: Optional[str] = None
    category: str = "unknown"
    extra: Dict[str, Any] = field(default_factory=dict)

    def public(self, loadable: bool) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "name": self.name, "format": self.format}
        if self.vendor:
            out["vendor"] = self.vendor
        if self.version:
            out["version"] = self.version
        out.update(category=self.category, path=self.path, loadable=loadable)
        return out


def plugin_id(fmt: str, path: str, sub: Optional[str] = None) -> str:
    return f"{fmt}:{path}" + (f"#{sub}" if sub else "")


def _read_json_lenient(path: Path) -> Optional[Any]:
    """moduleinfo.json is JSON5-flavoured (trailing commas, comments); good enough for metadata."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
        text = re.sub(r",(\s*[}\]])", r"\1", text)
        return json.loads(text)
    except (OSError, ValueError):
        return None


def _read_plist(path: Path) -> Dict[str, Any]:
    try:
        with open(path, "rb") as f:
            data = plistlib.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 - malformed plists are just missing metadata
        return {}


def _category_from_vst3(subcats: Any) -> str:
    text = "|".join(subcats) if isinstance(subcats, list) else str(subcats or "")
    if "Instrument" in text or "Synth" in text or "Sampler" in text:
        return "instrument"
    if "Fx" in text:
        return "effect"
    return "unknown"


def describe_vst3_bundle(path: Path) -> List[Plugin]:
    p = str(path)
    name, vendor, version = path.stem, None, None
    plist = _read_plist(path / "Contents" / "Info.plist") if path.is_dir() else {}
    name = str(plist.get("CFBundleName") or name)
    version = plist.get("CFBundleShortVersionString") or plist.get("CFBundleVersion")
    info = _read_json_lenient(path / "Contents" / "Resources" / "moduleinfo.json") if path.is_dir() else None
    classes: List[Dict[str, Any]] = []
    if isinstance(info, dict):
        version = info.get("Version") or version
        factory = info.get("Factory Info") or {}
        if isinstance(factory, dict):
            vendor = factory.get("Vendor") or vendor
        classes = [
            c for c in (info.get("Classes") or []) if isinstance(c, dict) and c.get("Category") == "Audio Module Class"
        ]
    if len(classes) > 1:  # a shell: one id per audio module class
        return [
            Plugin(
                plugin_id("vst3", p, str(c.get("Name"))),
                str(c.get("Name")),
                "vst3",
                p,
                sub=str(c.get("Name")),
                vendor=c.get("Vendor") or vendor,
                version=c.get("Version") or version,
                category=_category_from_vst3(c.get("Sub Categories")),
            )
            for c in classes
            if c.get("Name")
        ]
    category = _category_from_vst3(classes[0].get("Sub Categories")) if classes else "unknown"
    if classes and classes[0].get("Name"):
        name = str(classes[0]["Name"])
    return [Plugin(plugin_id("vst3", p), name, "vst3", p, vendor=vendor, version=version, category=category)]


_AU_TYPES = {"aumu": "instrument", "augn": "instrument", "aufx": "effect", "aumf": "effect", "aumi": "effect"}


def describe_au_bundle(path: Path) -> List[Plugin]:
    p = str(path)
    plist = _read_plist(path / "Contents" / "Info.plist")
    comps = [c for c in (plist.get("AudioComponents") or []) if isinstance(c, dict)]
    version = plist.get("CFBundleShortVersionString")
    out: List[Plugin] = []
    for c in comps:
        full = str(c.get("name") or path.stem)
        vendor, _, short = full.partition(": ")
        if not short:
            vendor, short = "", full
        category = _AU_TYPES.get(str(c.get("type") or ""), "unknown")
        sub = short if len(comps) > 1 else None
        out.append(
            Plugin(
                plugin_id("au", p, sub),
                short,
                "au",
                p,
                sub=sub,
                vendor=vendor or None,
                version=version,
                category=category,
            )
        )
    if not out:
        out.append(Plugin(plugin_id("au", p), str(plist.get("CFBundleName") or path.stem), "au", p, version=version))
    return out


def describe_simple(path: Path, fmt: str) -> List[Plugin]:
    p = str(path)
    plist = _read_plist(path / "Contents" / "Info.plist") if path.is_dir() else {}
    name = str(plist.get("CFBundleName") or path.stem)
    category = "instrument" if fmt in ("sf2", "sfz") else "unknown"
    return [Plugin(plugin_id(fmt, p), name, fmt, p, version=plist.get("CFBundleShortVersionString"), category=category)]


_LV2_SUBJECT_RE = re.compile(r"<([^>\s]+)>\s+a\s+([^;.]+)")
_LV2_NAME_RE = re.compile(r'doap:name\s+"((?:[^"\\]|\\.)*)"')


def describe_lv2_bundle(path: Path) -> List[Plugin]:
    """Plugins declared in ``manifest.ttl`` (``<uri> a lv2:Plugin``; a crude but cheap Turtle read)."""
    try:
        manifest = (path / "manifest.ttl").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    uris: List[Tuple[str, str]] = []
    for m in _LV2_SUBJECT_RE.finditer(manifest):
        if "Plugin" in m.group(2) and m.group(1) not in [u for u, _ in uris]:
            uris.append((m.group(1), m.group(2)))
    out: List[Plugin] = []
    for uri, kinds in uris:
        category = "instrument" if "InstrumentPlugin" in kinds else "unknown"
        name = uri.rstrip("/#").rsplit("/", 1)[-1].rsplit("#", 1)[-1] or path.stem
        if len(uris) == 1:  # cheap enrichment from the bundle's other small Turtle files
            for ttl in sorted(path.glob("*.ttl"))[:8]:
                try:
                    if ttl.stat().st_size > 256 * 1024:
                        continue
                    text = ttl.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if "InstrumentPlugin" in text:
                    category = "instrument"
                m = _LV2_NAME_RE.search(text)
                if m and name == uri.rstrip("/#").rsplit("/", 1)[-1].rsplit("#", 1)[-1]:
                    name = m.group(1)
        out.append(Plugin(plugin_id("lv2", str(path), uri), name, "lv2", str(path), sub=uri, category=category))
    return out


def is_vst2_binary(path: Path, root: Path, hint: Optional[str]) -> bool:
    """``.dll``/``.so`` files are VST2 only inside a VST2 folder (format hint, or a 'vst' path part)."""
    if path.suffix.lower() not in VST2_BINARY_EXTS:
        return False
    if hint == "vst2":
        return True
    if hint is not None:
        return False
    try:
        parts = path.relative_to(root.parent).parts
    except ValueError:
        parts = path.parts
    return any("vst" in part.lower() and "vst3" not in part.lower() for part in parts[:-1])


def describe_path(path: Path, root: Path, hint: Optional[str]) -> List[Plugin]:
    """Plugins in one file or bundle (empty when it is not a plugin)."""
    ext = path.suffix.lower()
    if path.is_dir():
        fmt = BUNDLE_EXTS.get(ext)
        if fmt == "vst3":
            return describe_vst3_bundle(path)
        if fmt == "au":
            return describe_au_bundle(path) if sys.platform == "darwin" or hint == "au" else describe_simple(path, "au")
        if fmt == "lv2":
            return describe_lv2_bundle(path)
        if fmt in ("vst2", "clap"):
            return describe_simple(path, fmt)
        return []
    fmt = FILE_EXTS.get(ext)
    if fmt == "vst3":
        return describe_vst3_bundle(path)
    if fmt:
        return describe_simple(path, fmt)
    if is_vst2_binary(path, root, hint):
        return describe_simple(path, "vst2")
    return []


def walk_plugins(
    root: Path, hint: Optional[str], *, max_depth: int = 6, max_entries: int = 50_000
) -> Iterable[Tuple[Path, List[Plugin]]]:
    """Yield ``(file or bundle, plugins)`` under ``root`` without entering bundles; follows symlinks once."""
    if root.is_file() or root.suffix.lower() in BUNDLE_EXTS:
        found = describe_path(root, root, hint)
        if found:
            yield root, found
        return
    seen = set()
    count = 0
    base_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        real = os.path.realpath(dirpath)
        if real in seen:
            dirnames[:] = []
            continue
        seen.add(real)
        here = Path(dirpath)
        keep = []
        for d in sorted(dirnames):
            count += 1
            sub = here / d
            if Path(d).suffix.lower() in BUNDLE_EXTS:
                found = describe_path(sub, root, hint)
                if found:
                    yield sub, found
            elif len(sub.parts) - base_depth < max_depth and not d.startswith("."):
                keep.append(d)
        dirnames[:] = keep
        for f in sorted(filenames):
            count += 1
            found = describe_path(here / f, root, hint)
            if found:
                yield here / f, found
        if count > max_entries:
            break


def lv2ls_names(lv2_roots: Sequence[str]) -> Dict[str, str]:
    """URI → name from ``lv2ls`` / ``lv2ls -n`` (lilv) when installed; ``{}`` otherwise."""
    tool = shutil.which("lv2ls")
    if not tool or not lv2_roots:
        return {}
    import subprocess

    env = dict(os.environ, LV2_PATH=os.pathsep.join(lv2_roots))
    try:
        uris = subprocess.run([tool], capture_output=True, text=True, timeout=30, env=env).stdout.split()
        names = subprocess.run([tool, "-n"], capture_output=True, text=True, timeout=30, env=env).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return {}
    return dict(zip(uris, names)) if len(uris) == len(names) else {}


def _within(path: str, roots: Iterable[str]) -> bool:
    real = os.path.realpath(path)
    for r in roots:
        rr = os.path.realpath(r)
        try:
            if os.path.commonpath([real, rr]) == rr:
                return True
        except ValueError:  # different drives on Windows
            continue
    return False


class Registry:
    """The cached scan. Ids from requests must resolve to a scanned plugin or to a plugin file under a root."""

    def __init__(
        self, roots: List[Tuple[str, Optional[str]]], *, max_depth: int, deep_scan: Callable[[Plugin], List[Plugin]]
    ):
        self.roots = roots
        self.extra_roots: List[str] = []
        self.max_depth = max_depth
        self.deep_scan = deep_scan
        self.plugins: "OrderedDict[str, Plugin]" = OrderedDict()
        self.scanned_at: Optional[float] = None
        self.scan_seconds: Optional[float] = None
        self._lock = threading.Lock()

    def search_paths(self) -> List[str]:
        out: List[str] = []
        for p, _ in self.roots:
            if p not in out:
                out.append(p)
        return out + [p for p in self.extra_roots if p not in out]

    def all_roots(self) -> List[Tuple[str, Optional[str]]]:
        return list(self.roots) + [(p, None) for p in self.extra_roots]

    def scan(self, extra: Sequence[str] = ()) -> List[Plugin]:
        for p in extra:
            ap = os.path.abspath(os.path.expanduser(p))
            if not os.path.exists(ap):
                raise BadRequest(f"paths: {p} does not exist")
            with self._lock:
                if ap not in self.extra_roots:
                    if len(self.extra_roots) >= EXTRA_ROOTS_MAX:
                        self.extra_roots.pop(0)
                    self.extra_roots.append(ap)
        t0 = time.monotonic()
        found: "OrderedDict[str, Plugin]" = OrderedDict()
        for root, hint in self.all_roots():
            rp = Path(root)
            if not rp.exists():
                continue
            for _path, plugins in walk_plugins(rp, hint, max_depth=self.max_depth):
                for pl in self.deep_scan(plugins[0]) if len(plugins) == 1 else plugins:
                    found.setdefault(pl.id, pl)
        lv2_roots = [r for r, h in self.all_roots() if h in ("lv2", None) and os.path.isdir(r)]
        names = lv2ls_names(lv2_roots) if any(p.format == "lv2" for p in found.values()) else {}
        for pl in found.values():
            if pl.format == "lv2" and pl.sub in names and names[pl.sub].strip():
                pl.name = names[pl.sub].strip()
        with self._lock:
            self.plugins = found
            self.scanned_at = time.time()
            self.scan_seconds = time.monotonic() - t0
        return list(found.values())

    def list(self) -> List[Plugin]:
        if self.scanned_at is None:
            self.scan()
        with self._lock:
            return list(self.plugins.values())

    def get(self, pid: str) -> Plugin:
        if self.scanned_at is None:
            self.scan()
        with self._lock:
            hit = self.plugins.get(pid)
        if hit is not None:
            return hit
        fmt, sep, rest = pid.partition(":")
        if not sep or fmt not in FORMAT_EXTS or not rest:
            raise NotFound(f"unknown plugin_id '{pid}' (ids look like 'vst3:/path/Plugin.vst3'; see GET /plugins)")
        candidates: List[Tuple[str, Optional[str]]] = [(rest, None)]
        candidates += [
            (rest[:i], rest[i + 1 :] or None) for i, c in enumerate(rest) if c == "#"
        ]  # LV2 URIs contain '#'
        for path, sub in candidates:
            if not os.path.isabs(path) or not os.path.exists(path):
                continue
            if not path.lower().endswith(FORMAT_EXTS[fmt]):
                continue
            if not _within(path, [r for r, _ in self.all_roots()]):
                raise NotFound(
                    f"plugin '{pid}' is not under a scanned folder; add its folder with --plugin-path or POST /plugins {{paths}}"
                )
            root_hint = fmt if fmt == "vst2" else None
            for pl in describe_path(Path(path), Path(path).parent, root_hint):
                if pl.format == fmt and (pl.sub == sub or (sub and pl.sub is None)):
                    entry = (
                        pl if pl.sub == sub else Plugin(plugin_id(fmt, path, sub), sub or pl.name, fmt, path, sub=sub)
                    )
                    with self._lock:
                        self.plugins[entry.id] = entry
                    return entry
        raise NotFound(f"unknown plugin_id '{pid}' (not found by the scan; POST /plugins rescans)")


# ===========================================================================
# SoundFont metadata (stdlib RIFF reader: preset list without loading samples)
# ===========================================================================


def read_sf2_presets(path: str) -> List[Tuple[int, int, str]]:
    """``[(bank, program, name)]`` from the ``pdta/phdr`` chunk, sorted; ``[]`` if unreadable."""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
            if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] not in (b"sfbk", b"sfbK"):
                return []
            end = 8 + struct.unpack("<I", head[4:8])[0]
            pos = 12
            while pos + 8 <= end:
                f.seek(pos)
                cid, size = struct.unpack("<4sI", f.read(8))
                if cid == b"LIST" and f.read(4) == b"pdta":
                    sub, sub_end = pos + 12, pos + 8 + size
                    while sub + 8 <= sub_end:
                        f.seek(sub)
                        sid, ssize = struct.unpack("<4sI", f.read(8))
                        if sid == b"phdr":
                            data = f.read(min(ssize, 38 * 65536))
                            out = []
                            for i in range(len(data) // 38 - 1):  # the last record is the "EOP" terminator
                                rec = data[i * 38 : (i + 1) * 38]
                                name = rec[:20].split(b"\x00", 1)[0].decode("latin-1").strip()
                                program, bank = struct.unpack("<HH", rec[20:24])
                                out.append((bank, program, name))
                            return sorted(set(out))
                        sub += 8 + ssize + (ssize & 1)
                pos += 8 + size + (size & 1)
    except (OSError, struct.error):
        return []
    return []


def sf2_preset_label(bank: int, program: int, name: str) -> str:
    return f"{bank:03d}:{program:03d} {name}".strip()


def parse_sf2_preset(label: str, presets: Sequence[Tuple[int, int, str]]) -> Tuple[int, int]:
    m = re.match(r"^\s*(\d{1,3}):(\d{1,3})\b", label)
    if m:
        return int(m.group(1)), int(m.group(2))
    for bank, program, name in presets:
        if name.lower() == label.strip().lower():
            return bank, program
    raise BadRequest(f"unknown preset '{label}' (use a name from /plugins/describe, e.g. '000:000 Piano')")


# ===========================================================================
# Instances (one per loaded plugin; heavy ones are cached in an LRU)
# ===========================================================================


class Instance:
    """A plugin ready to render. Every request: reset → state → preset → parameters (contract order)."""

    backend = "none"
    heavy = False

    def __init__(self, plugin: Plugin, host: "Host"):
        self.plugin = plugin
        self.host = host
        self.lock = threading.Lock()
        self.editor_open = False
        self.preset: Optional[str] = None

    def apply(self, req: StateRequest) -> None:
        self.reset()
        self.preset = None
        if req.state is not None:
            self.set_state(req.state)
        if req.preset:
            self.load_preset(req.preset)
            self.preset = req.preset
        if req.parameters:
            self.set_parameters(req.parameters)

    # -- overridden by backends -----------------------------------------------------------------
    def reset(self) -> None:
        pass

    def set_state(self, data: bytes) -> None:
        raise NotSupported(f"{self.backend}: plugin state is not supported")

    def get_state(self) -> Optional[bytes]:
        return None

    def load_preset(self, name: str) -> None:
        raise BadRequest(f"unknown preset '{name}' (this plugin lists no presets)")

    def presets(self) -> List[str]:
        return []

    def parameters(self) -> List[Dict[str, Any]]:
        return []

    def set_parameters(self, values: Dict[str, float]) -> None:
        if values:
            raise BadRequest(f"unknown parameter(s) {', '.join(values)} (this plugin exposes no parameters)")

    def latency(self) -> int:
        return 0

    def has_editor(self) -> bool:
        return False

    def show_editor(self, close: threading.Event) -> None:
        raise NotSupported("this plugin has no editor in this host")

    def render(self, req: RenderRequest, ctx: RequestContext) -> Audio:
        raise NotSupported(f"{self.backend}: rendering is not supported")

    def close(self) -> None:
        pass

    def parameter_values(self) -> Dict[str, float]:
        return {p["id"]: p["value"] for p in self.parameters()}


def conform(audio: Audio, req: RenderRequest, skip_frames: int = 0) -> Audio:
    """Resample/remix/trim engine output to exactly the requested rate, channels and length."""
    if skip_frames > 0:
        audio = audio.slice(skip_frames)
    if audio.sample_rate != req.sample_rate:
        audio = resample_audio(audio, req.sample_rate)
    audio = audio.with_channels(req.channels)
    out = fit_length(audio, req.frames)
    return Audio(out.sample_rate, out.channels, 32, True)


# ---------------------------------------------------------------------------
# pedalboard (VST3 everywhere, Audio Units on macOS) — ADAPT HERE for other pedalboard versions
# ---------------------------------------------------------------------------


def pb_module() -> Any:
    try:
        import pedalboard  # type: ignore
    except ImportError as e:
        raise EngineError(f"pedalboard is not importable ({e}); {INSTALL_HINTS['pedalboard']}") from None
    return pedalboard


def pb_sub_plugin_names(path: str) -> List[str]:
    """Sub-plugins of a shell file (loads the module, so only used on demand / --deep-scan)."""
    pb = pb_module()
    names: List[str] = []
    for cls_name in ("VST3Plugin", "AudioUnitPlugin"):
        cls = getattr(pb, cls_name, None)
        fn = getattr(cls, "get_plugin_names_for_file", None) if cls is not None else None
        if fn is None:
            continue
        try:
            names = list(fn(path))
        except Exception:  # noqa: BLE001 - wrong format for this class, unreadable file…
            continue
        if names:
            return names
    return names


def pb_load(plugin: Plugin, timeout: float) -> Any:
    pb = pb_module()
    kwargs: Dict[str, Any] = {}
    if plugin.sub:
        kwargs["plugin_name"] = plugin.sub
    try:
        try:
            return pb.load_plugin(plugin.path, initialization_timeout=timeout, **kwargs)
        except TypeError:  # pedalboard < 0.7.6 has no initialization_timeout
            return pb.load_plugin(plugin.path, **kwargs)
    except Exception as e:  # noqa: BLE001 - ImportError/RuntimeError/ValueError depending on version
        msg = str(e)
        if not plugin.sub and ("plugin_name" in msg or "multiple" in msg.lower()):
            try:
                subs = pb_sub_plugin_names(plugin.path)
            except EngineError:
                subs = []
            if subs:
                ids = ", ".join(plugin_id(plugin.format, plugin.path, s) for s in subs)
                raise BadRequest(f"{plugin.name} is a shell with several plugins; use one of: {ids}") from None
        raise EngineError(f"pedalboard could not load {plugin.name}: {type(e).__name__}: {msg}") from None


def pb_param_handles(inst: Any) -> List[Tuple[str, Any]]:
    """``[(stable id, parameter object)]`` — prefers the raw C++ parameters (fast), else ``.parameters``."""
    raw = getattr(inst, "_parameters", None)
    if callable(raw):
        try:
            raw = raw()
        except Exception:  # noqa: BLE001
            raw = None
    out: List[Tuple[str, Any]] = []
    seen: Dict[str, int] = {}
    if isinstance(raw, (list, tuple)) and raw:
        to_name: Optional[Callable[[Any], str]] = None
        try:
            from pedalboard._pedalboard import to_python_parameter_name as to_name  # type: ignore
        except Exception:  # noqa: BLE001 - private helper moved/renamed
            to_name = None
        for p in raw:
            if HIDDEN_PARAM_RE.match(str(getattr(p, "name", "") or "")):
                continue  # MIDI-CC mapping pseudo-parameters (hidden by DAWs)
            try:
                pid = to_name(p) if to_name else str(p.name)
            except Exception:  # noqa: BLE001
                pid = str(getattr(p, "name", "") or "")
            pid = pid or f"param_{len(out)}"
            if pid in seen:
                seen[pid] += 1
                pid = f"{pid}_{seen[pid]}"
            else:
                seen[pid] = 0
            out.append((pid, p))
        return out
    params = getattr(inst, "parameters", None) or {}
    return [(str(k), v) for k, v in params.items() if not HIDDEN_PARAM_RE.match(str(getattr(v, "name", "") or ""))]


def pb_param_info(pid: str, p: Any) -> Dict[str, Any]:
    def attr(name: str, default: Any = None) -> Any:
        try:
            return getattr(p, name)
        except Exception:  # noqa: BLE001
            return default

    value = attr("raw_value", 0.0)
    info: Dict[str, Any] = {"id": pid, "name": str(attr("name", pid) or pid), "value": float(value or 0.0)}
    info.update(min=0.0, max=1.0)
    default = attr("default_raw_value")
    if isinstance(default, (int, float)):
        info["default"] = float(default)
    label = attr("label")
    if label:
        info["label"] = str(label)
    return info


def pb_get_state(inst: Any) -> Optional[bytes]:
    for name in ("raw_state", "preset_data"):
        try:
            data = getattr(inst, name)
        except Exception:  # noqa: BLE001 - property missing or not supported by this plugin
            continue
        if isinstance(data, (bytes, bytearray)) and data:
            return bytes(data)
    return None


def pb_set_state(inst: Any, data: bytes) -> None:
    order = ("preset_data", "raw_state") if data[:4] == b"VST3" else ("raw_state", "preset_data")
    errors = []
    for name in order:
        if not hasattr(type(inst), name):
            continue
        try:
            setattr(inst, name, data)
            return
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {e}")
    raise BadRequest("could not apply 'state_base64' to this plugin (" + ("; ".join(errors) or "no state API") + ")")


def pb_render(inst: Any, events: Sequence[MidiEvent], req: RenderRequest) -> Any:
    """THE pedalboard render call: MIDI ``(bytes, seconds)`` tuples → (channels, frames) float32."""
    messages = [(msg, t) for t, msg in events]
    kwargs: Dict[str, Any] = {
        "duration": req.duration,
        "sample_rate": float(req.sample_rate),
        "num_channels": req.channels,
        "buffer_size": req.block_size,
        "reset": True,
    }
    try:
        return inst(messages, **kwargs)
    except TypeError:
        kwargs.pop("num_channels")  # older pedalboard: always stereo
        return inst(messages, **kwargs)
    except ValueError as e:
        # e.g. "does not support 2-channel output. (… expects 0 input channels and 1 output channels.)":
        # render the plugin's own channel count; conform() remixes to the request afterwards
        m = re.search(r"(\d+) output channels", str(e))
        if not m or int(m.group(1)) in (0, req.channels):
            raise
        kwargs["num_channels"] = int(m.group(1))
        return inst(messages, **kwargs)


def array_to_audio(arr: Any, sample_rate: int, channels_hint: int) -> Audio:
    """(channels, frames) or (frames, channels) array → :class:`Audio`."""
    shape = getattr(arr, "shape", None)
    if shape is None:
        return Audio(sample_rate, [list(map(float, arr))], 32, True)
    if len(shape) == 1:
        rows = [arr]
    elif shape[0] <= 16 and (shape[0] <= shape[1] or shape[0] == channels_hint):
        rows = list(arr)
    else:
        rows = list(arr.T)
    return Audio(sample_rate, [r.astype("float64").tolist() for r in rows], 32, True)


STATE_MAGIC = b"SDPS\x01"


def pack_state(raw: Optional[bytes], params: Dict[str, float]) -> bytes:
    """Song Deck pedalboard state: magic, JSON parameter values, then the plugin's own state.

    Some plugins (DPF-based ones, for example) leave parameter values out of their VST3 state,
    so the values travel next to it and are re-applied when they differ after loading the state.
    """
    head = json.dumps(params, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return STATE_MAGIC + struct.pack("<I", len(head)) + head + (raw or b"")


def unpack_state(blob: bytes) -> Tuple[Optional[bytes], Dict[str, float]]:
    """Inverse of :func:`pack_state`; any other blob is taken as the plugin's raw state."""
    if not blob.startswith(STATE_MAGIC) or len(blob) < len(STATE_MAGIC) + 4:
        return blob, {}
    n = struct.unpack("<I", blob[len(STATE_MAGIC) : len(STATE_MAGIC) + 4])[0]
    start = len(STATE_MAGIC) + 4
    try:
        params = json.loads(blob[start : start + n].decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise BadRequest("'state_base64' is corrupt (bad parameter block)") from None
    if not isinstance(params, dict):
        raise BadRequest("'state_base64' is corrupt (bad parameter block)")
    raw = blob[start + n :]
    return (raw or None), {str(k): float(v) for k, v in params.items() if isinstance(v, (int, float))}


class PedalboardInstance(Instance):
    """A pedalboard plugin. Setting a state can reload the whole plugin (seconds for some) and
    invalidates parameter handles, so: handles are fetched fresh for every use, and when a request
    has the same base state as the previous one, only the parameters it touched are restored."""

    backend = "pedalboard"
    heavy = True

    def __init__(self, plugin: Plugin, host: "Host"):
        super().__init__(plugin, host)
        self.inst = pb_load(plugin, host.args.load_timeout)
        self.default_state = pb_get_state(self.inst)
        self.applied_state: Optional[bytes] = None  # request state blob the plugin currently holds (None = default)
        self.base_values = self._raw_values()  # parameter values right after that base state
        self.touched: Dict[str, float] = {}  # parameters changed since (to restore cheaply)
        self.dirty = False  # preset/editor changed the plugin beyond ``touched``: full state reset needed
        try:
            if getattr(self.inst, "is_instrument", False):
                plugin.category = "instrument"
            elif getattr(self.inst, "is_effect", False) and plugin.category == "unknown":
                plugin.category = "effect"
            plugin.vendor = plugin.vendor or getattr(self.inst, "manufacturer_name", None) or None
            plugin.version = plugin.version or getattr(self.inst, "version", None) or None
        except Exception:  # noqa: BLE001 - metadata is best effort
            pass

    def _handles(self) -> Dict[str, Any]:
        return dict(pb_param_handles(self.inst))  # never cache: a state change invalidates them

    def _raw_values(self) -> Dict[str, float]:
        out = {}
        for pid, h in pb_param_handles(self.inst):
            try:
                out[pid] = float(h.raw_value)
            except Exception:  # noqa: BLE001
                pass
        return out

    def apply(self, req: StateRequest) -> None:
        if self.dirty or req.state != self.applied_state:
            raw, values = unpack_state(req.state) if req.state is not None else (self.default_state, {})
            if raw is not None:
                pb_set_state(self.inst, raw)
            if values:
                handles = self._handles()
                current = self._raw_values()
                for pid, v in values.items():  # only what the raw state did not restore
                    if pid in handles and abs(current.get(pid, -1.0) - v) > 1e-6 and 0.0 <= v <= 1.0:
                        try:
                            handles[pid].raw_value = v
                        except Exception:  # noqa: BLE001 - read-only parameters
                            pass
            self.applied_state = req.state
            self.base_values = self._raw_values()
            self.touched, self.dirty = {}, False
        elif self.touched:
            handles = self._handles()
            for pid in list(self.touched):
                if pid in handles and pid in self.base_values:
                    handles[pid].raw_value = self.base_values[pid]
            self.touched = {}
        self.preset = None
        if req.preset:
            self.dirty = True
            self.load_preset(req.preset)
            self.preset = req.preset
        if req.parameters:
            self.set_parameters(req.parameters)

    def get_state(self) -> Optional[bytes]:
        return pack_state(pb_get_state(self.inst), self._raw_values())

    def _preset_files(self) -> Dict[str, Path]:
        return find_vst3_presets(self.plugin) if self.plugin.format == "vst3" else {}

    def presets(self) -> List[str]:
        return sorted(self._preset_files())

    def load_preset(self, name: str) -> None:
        files = self._preset_files()
        if name not in files:
            raise BadRequest(f"unknown preset '{name}' (available: {', '.join(sorted(files)) or 'none'})")
        try:
            self.inst.load_preset(str(files[name]))
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"could not load preset '{name}': {e}") from None

    def parameters(self) -> List[Dict[str, Any]]:
        return [pb_param_info(pid, p) for pid, p in pb_param_handles(self.inst)]

    def set_parameters(self, values: Dict[str, float]) -> None:
        handles = self._handles()
        for k, v in values.items():
            if k not in handles:
                raise BadRequest(f"unknown parameter '{k}' (see /plugins/describe)")
            if not 0.0 <= v <= 1.0:
                raise BadRequest(f"parameter '{k}' must be a normalized value in 0..1 (got {v})")
        for k, v in values.items():
            try:
                handles[k].raw_value = float(v)
            except Exception as e:  # noqa: BLE001
                self.dirty = True
                raise EngineError(f"could not set parameter '{k}': {e}") from None
            self.touched[k] = float(v)

    def latency(self) -> int:
        try:
            return int(getattr(self.inst, "reported_latency_samples", 0) or 0)
        except Exception:  # noqa: BLE001
            return 0

    def has_editor(self) -> bool:
        return self.host.editor_supported and hasattr(self.inst, "show_editor")

    def show_editor(self, close: threading.Event) -> None:
        self.dirty = True  # the user may change anything in the window
        try:
            self.inst.show_editor(close)
        except TypeError:  # pedalboard < 0.7.5: no close event
            self.inst.show_editor()

    def render(self, req: RenderRequest, ctx: RequestContext) -> Audio:
        try:
            out = pb_render(self.inst, req.events, req)
        except Exception as e:  # noqa: BLE001
            if self.plugin.category == "effect":
                raise BadRequest(f"{self.plugin.name} is an effect, not an instrument: {e}") from None
            raise EngineError(f"{self.plugin.name} failed to render: {type(e).__name__}: {e}") from None
        ctx.check_cancelled()  # the call itself cannot be interrupted; its result is dropped
        return conform(array_to_audio(out, req.sample_rate, req.channels), req)  # pedalboard compensates latency

    def close(self) -> None:
        self.inst = None


def find_vst3_presets(plugin: Plugin) -> Dict[str, Path]:
    """``.vstpreset`` files in the standard VST3 preset folders (``<base>/<vendor>/<plugin name>``) and the bundle."""
    home = Path.home()
    if sys.platform == "darwin":
        bases = [home / "Library/Audio/Presets", Path("/Library/Audio/Presets")]
    elif os.name == "nt":
        bases = [
            home / "Documents" / "VST3 Presets",
            Path(os.environ.get("PROGRAMDATA") or "C:/ProgramData") / "VST3 Presets",
        ]
    else:
        bases = [home / ".vst3" / "presets", Path("/usr/share/vst3/presets"), Path("/usr/local/share/vst3/presets")]
    dirs: List[Path] = []
    for base in bases:
        if base.is_dir():
            dirs += [d for d in base.glob(f"*/{glob_escape(plugin.name)}") if d.is_dir()]
    bundle_presets = Path(plugin.path) / "Contents" / "Resources" / "Presets"
    if bundle_presets.is_dir():
        dirs.append(bundle_presets)
    out: Dict[str, Path] = {}
    for d in dirs:
        for f in sorted(d.rglob("*.vstpreset"))[:2000]:
            out.setdefault(f.stem, f)
    return out


def glob_escape(s: str) -> str:
    return re.sub(r"([*?\[])", r"[\1]", s)


# ---------------------------------------------------------------------------
# DawDreamer (VST2; VST3 without pedalboard) — ADAPT HERE for other DawDreamer versions
# ---------------------------------------------------------------------------


class DawDreamerInstance(Instance):
    backend = "dawdreamer"
    heavy = True

    def __init__(self, plugin: Plugin, host: "Host"):
        super().__init__(plugin, host)
        try:
            import dawdreamer  # type: ignore
        except ImportError as e:
            raise EngineError(f"DawDreamer is not importable ({e}); {INSTALL_HINTS['dawdreamer']}") from None
        self.daw = dawdreamer
        self.sample_rate = 0
        self.block_size = 0
        self.engine: Any = None
        self.proc: Any = None
        self.dirty = False  # state/parameters changed since the processor was created
        self._make(44100, 512)

    def _make(self, sample_rate: int, block_size: int) -> None:
        """(Re)create the engine: DawDreamer fixes sample rate and block size per RenderEngine."""
        try:
            self.engine = self.daw.RenderEngine(sample_rate, block_size)
            self.proc = self.engine.make_plugin_processor("plugin", self.plugin.path)
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"DawDreamer could not load {self.plugin.name}: {e}") from None
        self.sample_rate, self.block_size = sample_rate, block_size
        self.dirty = False

    def reset(self) -> None:
        if self.dirty:  # a fresh processor is the plugin's default state (load_state is not always usable)
            self._make(self.sample_rate, self.block_size)

    def get_state(self) -> Optional[bytes]:
        raw: Optional[bytes] = None
        save = getattr(self.proc, "save_state", None)
        if save is not None:
            with tempfile.TemporaryDirectory(prefix="songdeck-dd-") as tmp:
                path = os.path.join(tmp, "state.bin")
                try:
                    save(path)
                    raw = Path(path).read_bytes() if os.path.isfile(path) else None
                except Exception:  # noqa: BLE001
                    raw = None
        return pack_state(raw, {p["id"]: p["value"] for p in self.parameters()})

    def set_state(self, data: bytes) -> None:
        """Plugin state via ``load_state`` (needs an editor UI in some DawDreamer versions), then the
        parameter values stored next to it."""
        raw, values = unpack_state(data)
        self.dirty = True
        load = getattr(self.proc, "load_state", None)
        if raw and load is not None:
            with tempfile.TemporaryDirectory(prefix="songdeck-dd-") as tmp:
                path = os.path.join(tmp, "state.bin")
                Path(path).write_bytes(raw)
                try:
                    load(path)
                except Exception as e:  # noqa: BLE001
                    if not values:
                        raise BadRequest(f"could not apply 'state_base64': {e}") from None
        valid = self._param_indices()
        for k, v in values.items():
            if k in valid and 0.0 <= v <= 1.0:
                self.proc.set_parameter(int(k), float(v))

    def _descriptions(self) -> List[Dict[str, Any]]:
        try:
            desc = self.proc.get_parameters_description()
        except Exception:  # noqa: BLE001
            return []
        return [d for d in desc if not HIDDEN_PARAM_RE.match(str(d.get("name") or ""))]

    def _param_indices(self) -> set:
        return {str(int(d.get("index", -1))) for d in self._descriptions()}

    def parameters(self) -> List[Dict[str, Any]]:
        out = []
        for d in self._descriptions():
            idx = int(d.get("index", len(out)))
            try:
                value = float(self.proc.get_parameter(idx))
            except Exception:  # noqa: BLE001
                value = 0.0
            info: Dict[str, Any] = {
                "id": str(idx),
                "name": str(d.get("name") or idx),
                "value": value,
                "min": 0.0,
                "max": 1.0,
            }
            if isinstance(d.get("defaultValue"), (int, float)):
                info["default"] = float(d["defaultValue"])
            if d.get("label"):
                info["label"] = str(d["label"])
            out.append(info)
        return out

    def set_parameters(self, values: Dict[str, float]) -> None:
        valid = self._param_indices()
        for k, v in values.items():
            if k not in valid:
                raise BadRequest(
                    f"unknown parameter '{k}' (DawDreamer parameter ids are the indices in /plugins/describe)"
                )
            if not 0.0 <= v <= 1.0:
                raise BadRequest(f"parameter '{k}' must be a normalized value in 0..1 (got {v})")
        for k, v in values.items():
            self.dirty = True
            self.proc.set_parameter(int(k), float(v))

    def latency(self) -> int:
        try:
            return int(self.proc.get_latency_samples())
        except Exception:  # noqa: BLE001
            return 0

    def render(self, req: RenderRequest, ctx: RequestContext) -> Audio:
        """THE DawDreamer render: load the events as a MIDI file, render duration + latency, drop the latency."""
        if (req.sample_rate, req.block_size) != (self.sample_rate, self.block_size):
            self._make(req.sample_rate, req.block_size)  # DawDreamer fixes both per engine
            Instance.apply(self, req)
        latency = max(0, self.latency())
        with tempfile.TemporaryDirectory(prefix="songdeck-dd-") as tmp:
            midi = os.path.join(tmp, "events.mid")
            Path(midi).write_bytes(write_smf(req.events, duration=req.duration))
            try:
                self.proc.load_midi(midi, clear_previous=True, beats=False, all_events=True)
            except Exception:  # noqa: BLE001 - older versions: notes only
                self.proc.clear_midi()
                for n in note_spans(req.events, req.duration):
                    self.proc.add_midi_note(n.pitch, n.velocity, n.start, max(1e-3, n.end - n.start))
            try:
                self.engine.load_graph([(self.proc, [])])
                self.engine.render(req.duration + latency / req.sample_rate)
                out = self.engine.get_audio()
            except Exception as e:  # noqa: BLE001
                raise EngineError(f"{self.plugin.name} failed to render: {e}") from None
        ctx.check_cancelled()
        return conform(array_to_audio(out, req.sample_rate, req.channels), req, skip_frames=latency)


# ---------------------------------------------------------------------------
# FluidSynth (SF2/SF3): pyfluidsynth in process, else the fluidsynth command line
# ---------------------------------------------------------------------------


class FluidSynthInstance(Instance):
    backend = "fluidsynth"

    def __init__(self, plugin: Plugin, host: "Host"):
        super().__init__(plugin, host)
        self.font_presets = read_sf2_presets(plugin.path)
        self.default = {
            "bank": self.font_presets[0][0] if self.font_presets else 0,
            "program": self.font_presets[0][1] if self.font_presets else 0,
            "gain": host.args.fluidsynth_gain,
            "reverb": 0.0,
            "chorus": 0.0,
        }
        self.values = dict(self.default)

    def reset(self) -> None:
        self.values = dict(self.default)

    def get_state(self) -> Optional[bytes]:
        return json.dumps(self.values, sort_keys=True, separators=(",", ":")).encode("utf-8")

    def set_state(self, data: bytes) -> None:
        try:
            loaded = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise BadRequest("'state_base64' is not a SoundFont state of this host") from None
        if not isinstance(loaded, dict):
            raise BadRequest("'state_base64' is not a SoundFont state of this host")
        for k in ("bank", "program"):
            if k in loaded:
                v = loaded[k]
                if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= (128 if k == "bank" else 127):
                    raise BadRequest(f"state: '{k}' is out of range")
                self.values[k] = v
        self.set_parameters({k: float(v) for k, v in loaded.items() if k in ("gain", "reverb", "chorus")})

    def presets(self) -> List[str]:
        return [sf2_preset_label(b, p, n) for b, p, n in self.font_presets]

    def load_preset(self, name: str) -> None:
        self.values["bank"], self.values["program"] = parse_sf2_preset(name, self.font_presets)

    def parameters(self) -> List[Dict[str, Any]]:
        g = self.default["gain"]
        return [
            {"id": "gain", "name": "Gain", "value": self.values["gain"], "min": 0.0, "max": 10.0, "default": g},
            {
                "id": "reverb",
                "name": "Reverb on/off",
                "value": self.values["reverb"],
                "min": 0.0,
                "max": 1.0,
                "default": 0.0,
            },
            {
                "id": "chorus",
                "name": "Chorus on/off",
                "value": self.values["chorus"],
                "min": 0.0,
                "max": 1.0,
                "default": 0.0,
            },
        ]

    def set_parameters(self, values: Dict[str, float]) -> None:
        for k, v in values.items():
            if k not in ("gain", "reverb", "chorus"):
                raise BadRequest(f"unknown parameter '{k}' (SoundFont parameters: gain, reverb, chorus)")
            hi = 10.0 if k == "gain" else 1.0
            if not 0.0 <= v <= hi:
                raise BadRequest(f"parameter '{k}' must be in 0..{hi:g}")
            self.values[k] = float(v)

    def _program_messages(self, events: Sequence[MidiEvent]) -> List[bytes]:
        bank, program = int(self.values["bank"]), int(self.values["program"])
        msgs: List[bytes] = []
        for ch in used_channels(events):
            if bank <= 127:
                msgs.append(bytes([0xB0 | ch, 0, bank]))
                msgs.append(bytes([0xB0 | ch, 32, 0]))
            msgs.append(bytes([0xC0 | ch, program]))
        return msgs

    def render(self, req: RenderRequest, ctx: RequestContext) -> Audio:
        if self.host.fluidsynth_mode == "python":
            return self._render_python(req, ctx)
        return self._render_cli(req, ctx)

    def _render_cli(self, req: RenderRequest, ctx: RequestContext) -> Audio:
        """THE fluidsynth CLI call: ``fluidsynth -ni -F out.wav -r SR -g GAIN font.sf2 in.mid``."""
        with tempfile.TemporaryDirectory(prefix="songdeck-fluid-") as tmp:
            midi, out = Path(tmp, "events.mid"), Path(tmp, "out.wav")
            midi.write_bytes(write_smf(req.events, duration=req.duration, prepend=self._program_messages(req.events)))
            cmd = [self.host.fluidsynth_cli, "-ni", "-F", str(out), "-T", "wav", "-O", "float"]
            cmd += ["-r", str(req.sample_rate), "-g", f"{self.values['gain']:g}"]
            cmd += [
                "-R",
                "1" if self.values["reverb"] >= 0.5 else "0",
                "-C",
                "1" if self.values["chorus"] >= 0.5 else "0",
            ]
            cmd += ["-z", str(max(64, req.block_size))] + list(self.host.args.fluidsynth_arg or [])
            cmd += [self.plugin.path, str(midi)]
            run_command(cmd, ctx, timeout=self.host.args.timeout, name="fluidsynth")
            if not out.is_file():
                raise EngineError("fluidsynth finished without writing the WAV file")
            try:
                audio = read_wav(out.read_bytes())
            except WavError as e:
                raise EngineError(f"fluidsynth output is not readable ({e})") from None
        return conform(audio, req)

    def _render_python(self, req: RenderRequest, ctx: RequestContext) -> Audio:
        """THE pyfluidsynth path: drive the synth event by event and pull samples in between."""
        import fluidsynth  # type: ignore

        sr = req.sample_rate
        fs = fluidsynth.Synth(gain=float(self.values["gain"]), samplerate=float(sr))
        try:
            for opt, key in (("synth.reverb.active", "reverb"), ("synth.chorus.active", "chorus")):
                try:
                    fs.setting(opt, 1 if self.values[key] >= 0.5 else 0)
                except Exception:  # noqa: BLE001 - older pyfluidsynth / FluidSynth
                    pass
            sfid = fs.sfload(self.plugin.path)
            if sfid < 0:
                raise EngineError(f"FluidSynth could not load {self.plugin.path}")
            for ch in used_channels(req.events):
                fs.program_select(ch, sfid, int(self.values["bank"]), int(self.values["program"]))
            left: List[float] = []
            right: List[float] = []
            done = 0

            def pull(frames: int) -> None:
                nonlocal done
                while frames > 0:
                    k = min(frames, 8192)
                    s = fs.get_samples(k)
                    vals = s.tolist() if hasattr(s, "tolist") else list(s)
                    left.extend(v / 32768.0 for v in vals[0::2])
                    right.extend(v / 32768.0 for v in vals[1::2])
                    frames -= k
                    done += k
                    ctx.check_cancelled()

            for t, msg in req.events:
                pull(int(round(t * sr)) - done)
                kind, ch = msg[0] & 0xF0, msg[0] & 0x0F
                if kind == 0x90 and msg[2]:
                    fs.noteon(ch, msg[1], msg[2])
                elif kind in (0x80, 0x90):
                    fs.noteoff(ch, msg[1])
                elif kind == 0xB0:
                    fs.cc(ch, msg[1], msg[2])
                elif kind == 0xC0:
                    fs.program_change(ch, msg[1])
                elif kind == 0xE0:
                    fs.pitch_bend(ch, (msg[1] | (msg[2] << 7)) - 8192)
            pull(req.frames - done)
        finally:
            try:
                fs.delete()
            except Exception:  # noqa: BLE001
                pass
        return conform(Audio(sr, [left, right], 32, True), req)


# ---------------------------------------------------------------------------
# Command-line renderers (CLAP, LV2, SFZ via sfizz_render, anything with --command)
# ---------------------------------------------------------------------------


class CommandInstance(Instance):
    """Runs a configured command per render; the state and parameters are passed through files."""

    backend = "command"

    def __init__(self, plugin: Plugin, host: "Host", template: str, backend_name: str = "command"):
        super().__init__(plugin, host)
        self.template = template
        self.backend = backend_name
        self.state: Optional[bytes] = None
        self.values: Dict[str, float] = {}

    def reset(self) -> None:
        self.state, self.values = None, {}

    def set_state(self, data: bytes) -> None:
        self.state = data

    def get_state(self) -> Optional[bytes]:
        return self.state

    def load_preset(self, name: str) -> None:
        pass  # passed to the command as {preset}

    def set_parameters(self, values: Dict[str, float]) -> None:
        self.values.update(values)  # passed to the command as {params}

    def parameter_values(self) -> Dict[str, float]:
        return dict(self.values)

    def render(self, req: RenderRequest, ctx: RequestContext) -> Audio:
        """THE command call: write MIDI/state/params files, run the template, read {output}."""
        with tempfile.TemporaryDirectory(prefix="songdeck-plugin-") as tmp:
            midi, out = Path(tmp, "events.mid"), Path(tmp, "output.wav")
            state, params = Path(tmp, "state.bin"), Path(tmp, "params.json")
            midi.write_bytes(write_smf(req.events, duration=req.duration))
            state.write_bytes(self.state or b"")
            params.write_text(json.dumps(self.values, sort_keys=True), encoding="utf-8")
            values = {
                "plugin": self.plugin.path,
                "uri": self.plugin.sub or "",
                "name": self.plugin.name,
                "midi": str(midi),
                "output": str(out),
                "sample_rate": str(req.sample_rate),
                "duration": f"{req.duration:g}",
                "channels": str(req.channels),
                "block_size": str(req.block_size),
                "state": str(state),
                "params": str(params),
                "preset": self.preset or "",
                "fluidsynth": self.host.fluidsynth_cli or "fluidsynth",
                "sfizz": self.host.sfizz_cli or "sfizz_render",
                "python": sys.executable,
            }
            run_command(
                command_from_template(self.template, values),
                ctx,
                cwd=tmp,
                timeout=self.host.args.timeout,
                name=self.backend,
            )
            if not out.is_file():
                produced = [p for p in Path(tmp).rglob("*.wav")]
                if not produced:
                    raise EngineError(
                        f"the {self.plugin.format} command finished without writing {{output}} (check the template)"
                    )
                out = produced[0]
            try:
                audio = read_wav(out.read_bytes())
            except WavError as e:
                raise EngineError(f"the {self.plugin.format} command output is not a readable WAV ({e})") from None
        return conform(audio, req)


# ===========================================================================
# The host: backend choice, instance cache, HTTP routes
# ===========================================================================


class Host:
    def __init__(self, args: Any):
        self.args = args
        disabled = set(args.disable_backend or [])
        self.commands: Dict[str, str] = dict(args.commands)
        self.has_pedalboard = "pedalboard" not in disabled and module_available("pedalboard")
        self.has_dawdreamer = "dawdreamer" not in disabled and module_available("dawdreamer")
        self.fluidsynth_cli = args.fluidsynth or shutil.which("fluidsynth")
        self.sfizz_cli = args.sfizz_render or shutil.which("sfizz_render")
        py_fluid = module_available("fluidsynth") and module_available("numpy")
        if py_fluid and args.fluidsynth_mode in ("auto", "python"):
            try:
                import fluidsynth  # type: ignore  # noqa: F401  (needs the native library too)
            except Exception:  # noqa: BLE001 - ImportError/OSError when libfluidsynth is missing
                py_fluid = False
        if "fluidsynth" in disabled:
            self.fluidsynth_mode = None
        elif args.fluidsynth_mode == "python":
            self.fluidsynth_mode = "python" if py_fluid else None
        elif args.fluidsynth_mode == "cli":
            self.fluidsynth_mode = "cli" if self.fluidsynth_cli else None
        else:
            self.fluidsynth_mode = "python" if py_fluid else ("cli" if self.fluidsynth_cli else None)
        if "sfizz" not in disabled and self.sfizz_cli and "sfz" not in self.commands:
            self.sfz_default = DEFAULT_SFZ_COMMAND
        else:
            self.sfz_default = None
        self.editor_supported = (
            not args.no_editor and self.has_pedalboard and (sys.platform == "darwin" or os.name == "nt")
        )
        self.runner = MainThreadRunner()  # serviced by serve(): JUCE plugins and editor windows live there
        roots: List[Tuple[str, Optional[str]]] = [] if args.no_default_paths else default_search_paths()
        roots = [(os.path.abspath(os.path.expanduser(p)), None) for p in args.plugin_path] + roots
        self.registry = Registry(roots, max_depth=args.scan_depth, deep_scan=self._deep_scan)
        self._cache: "OrderedDict[str, Instance]" = OrderedDict()
        self._cache_lock = threading.Lock()
        self._render_slots = threading.Semaphore(max(1, args.max_renders))

    # -- backends ---------------------------------------------------------------------------------
    def backend_for(self, fmt: str) -> Tuple[Optional[str], str]:
        """(backend name or None, note) for a format."""
        if fmt in self.commands:
            return "command", "rendered by the configured command template"
        if fmt == "vst3":
            if self.has_pedalboard:
                return "pedalboard", ""
            if self.has_dawdreamer:
                return "dawdreamer", ""
            return (
                None,
                f"install pedalboard ({INSTALL_HINTS['pedalboard']}) or DawDreamer ({INSTALL_HINTS['dawdreamer']})",
            )
        if fmt == "au":
            if sys.platform != "darwin":
                return None, "Audio Units exist on macOS only"
            if self.has_pedalboard:
                return "pedalboard", ""
            return None, INSTALL_HINTS["pedalboard"]
        if fmt == "vst2":
            if self.has_dawdreamer:
                return "dawdreamer", ""
            return None, f"VST2 needs DawDreamer: {INSTALL_HINTS['dawdreamer']} (or --command vst2=TEMPLATE)"
        if fmt == "sf2":
            if self.fluidsynth_mode:
                return (
                    "fluidsynth",
                    "pyfluidsynth" if self.fluidsynth_mode == "python" else f"CLI {self.fluidsynth_cli}",
                )
            return None, INSTALL_HINTS["fluidsynth"]
        if fmt == "sfz":
            if self.sfz_default:
                return "sfizz", f"sfizz_render at {self.sfizz_cli}"
            return None, INSTALL_HINTS["sfizz"]
        if fmt in ("clap", "lv2"):
            return (
                None,
                f"no {fmt.upper()} renderer configured: start the bridge with --{fmt}-command '<template>' (see bridges/README.md)",
            )
        if fmt == "wam":
            return None, "Web Audio Modules run inside the Song Deck studio, not in this host"
        return None, "unsupported format"

    def formats(self) -> List[Dict[str, Any]]:
        out = []
        for fmt in PLUGIN_FORMATS:
            backend, note = self.backend_for(fmt)
            entry: Dict[str, Any] = {"format": fmt, "available": backend is not None}
            if backend:
                entry["backend"] = backend
            if note:
                entry["note"] = note
            out.append(entry)
        return out

    def loadable(self, plugin: Plugin) -> bool:
        return self.backend_for(plugin.format)[0] is not None

    def _deep_scan(self, plugin: Plugin) -> List[Plugin]:
        """--deep-scan: list the sub-plugins of VST3/AU shells (this loads the module)."""
        if not self.args.deep_scan or plugin.format not in ("vst3", "au") or not self.has_pedalboard:
            return [plugin]
        try:
            subs = pb_sub_plugin_names(plugin.path)
        except Exception:  # noqa: BLE001
            return [plugin]
        if len(subs) <= 1:
            return [plugin]
        return [
            Plugin(
                plugin_id(plugin.format, plugin.path, s),
                s,
                plugin.format,
                plugin.path,
                sub=s,
                vendor=plugin.vendor,
                version=plugin.version,
            )
            for s in subs
        ]

    # -- instances ------------------------------------------------------------------------------------
    def _create(self, plugin: Plugin) -> Instance:
        backend, note = self.backend_for(plugin.format)
        if backend is None:
            raise NotSupported(f"{plugin.format} plugins cannot be loaded here: {note}")
        if backend == "command":
            return CommandInstance(plugin, self, self.commands[plugin.format])
        if backend == "sfizz":
            return CommandInstance(plugin, self, self.sfz_default or DEFAULT_SFZ_COMMAND, "sfizz")
        if backend == "fluidsynth":
            return FluidSynthInstance(plugin, self)
        if backend == "pedalboard":
            return PedalboardInstance(plugin, self)
        return DawDreamerInstance(plugin, self)

    def instance(self, plugin: Plugin) -> Instance:
        with self._cache_lock:
            inst = self._cache.get(plugin.id)
            if inst is not None:
                self._cache.move_to_end(plugin.id)
                return inst
        inst = self._create(plugin)  # loading can take seconds: outside the cache lock
        if not inst.heavy:
            return inst
        with self._cache_lock:
            existing = self._cache.get(plugin.id)
            if existing is not None:
                inst.close()
                return existing
            self._cache[plugin.id] = inst
            while len(self._cache) > max(1, self.args.max_loaded):
                old_id, old = next(iter(self._cache.items()))
                if old.lock.locked() or old.editor_open:
                    break
                self._cache.pop(old_id)
                old.close()
        return inst

    def run(self, plugin: Plugin, ctx: RequestContext, fn: Callable[[Instance], Any]) -> Any:
        """Load the plugin (cached) and run ``fn(instance)`` under its lock.

        pedalboard and DawDreamer (JUCE) plugins only reload/reset on the main thread, so their
        whole critical section runs there (through the runner serviced by ``serve()``); requests
        for other backends run on the request thread.
        """

        def body() -> Any:
            ctx.check_cancelled()  # cancelled while queued for the main thread: skip
            inst = self.instance(plugin)
            self.acquire(inst, ctx)
            try:
                return fn(inst)
            finally:
                inst.lock.release()

        if self.backend_for(plugin.format)[0] in MAIN_THREAD_BACKENDS:
            return self.runner.call(body)
        return body()

    def acquire(self, inst: Instance, ctx: RequestContext) -> None:
        if inst.editor_open:
            raise Busy(f"the editor of {inst.plugin.name} is open; close it first")
        while not inst.lock.acquire(timeout=0.2):
            ctx.check_cancelled()
            if inst.editor_open:
                raise Busy(f"the editor of {inst.plugin.name} is open; close it first")

    def loaded(self) -> List[str]:
        with self._cache_lock:
            return list(self._cache)

    def close(self) -> None:
        with self._cache_lock:
            items = list(self._cache.values())
            self._cache.clear()
        for inst in items:
            inst.close()


def describe_body(host: Host, plugin: Plugin, inst: Instance) -> Dict[str, Any]:
    out = plugin.public(host.loadable(plugin))
    out.update(
        parameters=inst.parameters(),
        presets=inst.presets(),
        has_editor=inst.has_editor(),
        latency_samples=inst.latency(),
        backend=inst.backend,
    )
    return out


def build_app(host: Host) -> BridgeApp:
    args = host.args
    app = BridgeApp("Song Deck plugin host", role="instruments", **app_options(args))
    app.expose_headers += ", X-Plugin-Latency"
    app.health_extra = lambda: {
        "plugins_scanned": len(host.registry.plugins),
        "scan_seconds": round(host.registry.scan_seconds or 0.0, 3),
        "loaded_plugins": host.loaded(),
        "editor": host.editor_supported,
    }
    app.on_close(host.close)

    def plugin_of(body: Dict[str, Any]) -> Plugin:
        return host.registry.get(req_str(body, "plugin_id", allow_empty=False, max_len=4096))

    @app.route("GET", "/info")
    def info(ctx: RequestContext):
        return json_response(
            {
                "name": app.name,
                "version": __version__,
                "models": [],
                "formats": host.formats(),
                "capabilities": [CAPABILITY],
                "editor": host.editor_supported,
                "search_paths": host.registry.search_paths(),
                "hardware": {"min_vram_gb": 0},
            }
        )

    @app.route("GET", "/plugins")
    def plugins(ctx: RequestContext):
        return json_response({"plugins": [p.public(host.loadable(p)) for p in host.registry.list()]})

    @app.route("POST", "/plugins")
    def rescan(ctx: RequestContext):
        extra = parse_scan_paths(ctx.json_object(allow_empty=True))
        found = host.registry.scan(extra)
        return json_response({"plugins": [p.public(host.loadable(p)) for p in found]})

    @app.job("POST", "/plugins/describe")
    def describe(ctx: RequestContext):
        plugin = plugin_of(ctx.json_object())

        def work():
            def fn(inst: Instance) -> Any:
                inst.apply(StateRequest(plugin.id))
                return describe_body(host, plugin, inst)

            return json_response(host.run(plugin, ctx, fn))

        return work

    @app.job("POST", "/state")
    def state(ctx: RequestContext):
        req = parse_state_request(ctx.json_object())
        plugin = host.registry.get(req.plugin_id)

        def work():
            def fn(inst: Instance) -> Any:
                inst.apply(req)
                return state_response(plugin.id, inst.get_state(), inst.parameter_values(), inst.preset)

            return json_response(host.run(plugin, ctx, fn))

        return work

    @app.job("POST", "/editor")
    def editor(ctx: RequestContext):
        req = parse_state_request(ctx.json_object())
        plugin = host.registry.get(req.plugin_id)
        if not host.editor_supported:
            raise NotSupported(
                "plugin editors are not available here (they need pedalboard on macOS or Windows; --no-editor disables them)"
            )
        if host.backend_for(plugin.format)[0] != "pedalboard":
            raise NotSupported(f"{plugin.format} plugins have no editor in this host")

        def work():
            close = threading.Event()
            ctx.on_cancel(close.set)  # client gone or POST /cancel → the window closes
            host.runner.add_interrupt(close.set)  # bridge shutdown → the window closes

            def fn(inst: Instance) -> Any:  # on the main thread (macOS requires it for windows)
                inst.apply(req)
                inst.editor_open = True
                try:
                    inst.show_editor(close)
                finally:
                    inst.editor_open = False
                return state_response(plugin.id, inst.get_state(), inst.parameter_values(), inst.preset)

            try:
                body = host.run(plugin, ctx, fn)
            finally:
                host.runner.remove_interrupt(close.set)
            ctx.check_cancelled()
            return json_response(body)

        return work

    @app.job("POST", "/render")
    def render(ctx: RequestContext):
        req = parse_render_request(ctx.json_object(), args.max_duration)
        plugin = host.registry.get(req.plugin_id)
        backend, note = host.backend_for(plugin.format)
        if backend is None:
            raise NotSupported(f"{plugin.format} plugins cannot be rendered here: {note}")

        def work():
            while not host._render_slots.acquire(timeout=0.2):
                ctx.check_cancelled()
            try:

                def fn(inst: Instance) -> Tuple[Audio, int]:
                    inst.apply(req)
                    return inst.render(req, ctx), inst.latency()

                audio, latency = host.run(plugin, ctx, fn)
            finally:
                host._render_slots.release()
            ctx.check_cancelled()
            return wav_response(write_wav(audio), model=plugin.id, headers={"X-Plugin-Latency": str(latency)})

        return work

    return app


def parse_commands(args: Any) -> Dict[str, str]:
    commands: Dict[str, str] = {}
    for item in args.command or []:
        fmt, sep, tpl = item.partition("=")
        fmt = fmt.strip().lower()
        if not sep or fmt not in FORMAT_EXTS or not tpl.strip():
            fail(f"--command expects FORMAT=TEMPLATE with FORMAT one of {', '.join(FORMAT_EXTS)} (got {item!r})")
        commands[fmt] = tpl
    for fmt in ("clap", "lv2", "vst2", "sf2", "sfz"):
        tpl = getattr(args, f"{fmt}_command", None)
        if tpl:
            commands[fmt] = tpl
    for fmt, tpl in commands.items():
        for ph in re.findall(r"\{([A-Za-z_]+)\}", tpl):
            if ph not in PLACEHOLDERS:
                fail(
                    f"unknown placeholder {{{ph}}} in the {fmt} command (known: {', '.join('{' + x + '}' for x in PLACEHOLDERS)})"
                )
    return commands


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = build_parser(
        "Song Deck instrument plugin host: renders MIDI through VST3/AU/VST2/CLAP/LV2 plugins, SoundFonts and SFZ.",
        DEFAULT_PORT,
        prog="plugin_host_bridge.py",
        engine_flags=False,
    )
    p.set_defaults(max_jobs=2)  # one slot stays free for an open editor window
    h = p.add_argument_group("plugin host")
    h.add_argument(
        "--plugin-path", action="append", default=[], metavar="DIR", help="extra folder (or file) to scan; repeatable"
    )
    h.add_argument("--no-default-paths", action="store_true", help="scan only --plugin-path (and request paths)")
    h.add_argument("--scan-depth", type=int, default=6, help="how deep to look into folders (default 6)")
    h.add_argument(
        "--deep-scan", action="store_true", help="load VST3/AU shells while scanning to list their sub-plugins"
    )
    h.add_argument(
        "--command",
        action="append",
        default=[],
        metavar="FORMAT=TEMPLATE",
        help="render FORMAT with a command template; repeatable",
    )
    h.add_argument("--clap-command", default=None, metavar="TEMPLATE", help="render CLAP plugins with this command")
    h.add_argument("--lv2-command", default=None, metavar="TEMPLATE", help="render LV2 plugins with this command")
    h.add_argument(
        "--vst2-command",
        default=None,
        metavar="TEMPLATE",
        help="render VST2 plugins with this command (instead of DawDreamer)",
    )
    h.add_argument(
        "--sf2-command",
        default=None,
        metavar="TEMPLATE",
        help="render SoundFonts with this command (instead of FluidSynth)",
    )
    h.add_argument(
        "--sfz-command",
        default=None,
        metavar="TEMPLATE",
        help=f"render SFZ with this command (default: {DEFAULT_SFZ_COMMAND!r})",
    )
    h.add_argument(
        "--disable-backend",
        action="append",
        default=[],
        choices=["pedalboard", "dawdreamer", "fluidsynth", "sfizz"],
        help="never use this backend; repeatable",
    )
    h.add_argument("--fluidsynth", default=None, metavar="PATH", help="fluidsynth executable (default: from PATH)")
    h.add_argument(
        "--fluidsynth-mode",
        choices=["auto", "python", "cli"],
        default="auto",
        help="pyfluidsynth or the CLI (default auto: pyfluidsynth first)",
    )
    h.add_argument(
        "--fluidsynth-gain", type=float, default=0.5, help="default SoundFont gain (FluidSynth -g; default 0.5)"
    )
    h.add_argument(
        "--fluidsynth-arg", action="append", default=[], metavar="ARG", help="extra fluidsynth CLI argument; repeatable"
    )
    h.add_argument("--sfizz-render", default=None, metavar="PATH", help="sfizz_render executable (default: from PATH)")
    h.add_argument("--no-editor", action="store_true", help="never open native plugin editor windows")
    h.add_argument("--max-loaded", type=int, default=4, help="plugin instances kept loaded (LRU; default 4)")
    h.add_argument("--max-renders", type=int, default=1, help="renders that run at the same time (default 1)")
    h.add_argument(
        "--load-timeout", type=float, default=10.0, help="seconds a plugin may take to initialize (default 10)"
    )
    h.add_argument("--max-duration", type=float, default=1800.0, help="longest render in seconds (default 1800)")
    h.add_argument(
        "--timeout", type=float, default=1800.0, help="seconds before a render command is killed (default 1800)"
    )
    args = p.parse_args(argv)
    setup_logging(args)
    check_bind(args)
    args.commands = parse_commands(args)
    for path in args.plugin_path:
        if not os.path.exists(os.path.expanduser(path)):
            fail(f"--plugin-path {path} does not exist")
    host = Host(args)
    for fmt in host.formats():
        print(
            f"  {fmt['format']:5s} {'yes' if fmt['available'] else 'no ':3s} {fmt.get('backend', '-'):11s} {fmt.get('note', '')}",
            file=sys.stderr,
        )
    found = host.registry.scan()
    print(
        f"plugin host: {len(found)} plugin(s) found in {len(host.registry.search_paths())} search path(s)",
        file=sys.stderr,
    )
    app = build_app(host)
    return serve([(app, args.host, args.port)], main_thread=host.runner)


if __name__ == "__main__":
    sys.exit(main())
