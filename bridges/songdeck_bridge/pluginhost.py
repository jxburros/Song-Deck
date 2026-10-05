"""
Request parsing shared by instrument plugin hosts (``PLUGIN_HOST_PATHS`` in
``packages/ai/src/contracts.ts``): the real host (``plugin_host_bridge.py``) and the mock
(``mock_bridge.py --role instruments``).

Endpoints::

    GET  /info                → {name, version, formats: [{format, available, backend?, note?}],
                                 capabilities: ["INSTRUMENT_PLUGIN_HOST"], editor?, search_paths?}
    GET  /plugins             → {plugins: [{id, name, format, vendor?, version?, category?, path?, loadable?}]}
    POST /plugins {paths?}    → the same, rescanned (extra files/directories)
    POST /plugins/describe {plugin_id}
                              → plugin + {parameters: [{id, name, value, min?, max?, default?, label?}],
                                          presets?, has_editor?, latency_samples?}
    POST /render  {plugin_id, state_base64?, parameters?, preset?, sample_rate, channels?,
                   duration_seconds, events: [{time_seconds, data}], block_size?}
                              → audio/wav (X-Plugin-Latency, X-Model)
    POST /editor  {plugin_id, state_base64?, parameters?, preset?} → {plugin_id, state_base64?, parameters, preset?}
    POST /state   (same body and answer as /editor, without a window)
    POST /cancel  {job_id?}   → 204

State is applied first, then the preset, then the parameters (the contract order).
"""

from __future__ import annotations

import base64
import binascii
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .midi import MidiEvent, parse_events
from .server import BadRequest, req_int, req_number, req_str

__all__ = [
    "PLUGIN_FORMATS",
    "CAPABILITY",
    "StateRequest",
    "RenderRequest",
    "parse_state_request",
    "parse_render_request",
    "parse_scan_paths",
    "encode_state",
    "state_response",
]

PLUGIN_FORMATS = ("vst3", "au", "vst2", "clap", "lv2", "sf2", "sfz", "wam")
CAPABILITY = "INSTRUMENT_PLUGIN_HOST"
MAX_PLUGIN_ID = 4096


@dataclass
class StateRequest:
    plugin_id: str
    state: Optional[bytes] = None
    parameters: Dict[str, float] = field(default_factory=dict)
    preset: Optional[str] = None


@dataclass
class RenderRequest(StateRequest):
    sample_rate: int = 44100
    channels: int = 2
    duration: float = 0.0
    events: List[MidiEvent] = field(default_factory=list)
    block_size: int = 512

    @property
    def frames(self) -> int:
        return int(round(self.duration * self.sample_rate))


def _decode_state(text: Optional[str]) -> Optional[bytes]:
    if text is None:
        return None
    try:
        return base64.b64decode("".join(text.split()), validate=True)
    except (binascii.Error, ValueError):
        raise BadRequest("'state_base64' is not valid base64") from None


def parse_state_request(body: Dict[str, Any]) -> StateRequest:
    plugin_id = req_str(body, "plugin_id", allow_empty=False, max_len=MAX_PLUGIN_ID)
    state = _decode_state(req_str(body, "state_base64", required=False))
    preset = req_str(body, "preset", required=False, max_len=1024) or None
    raw = body.get("parameters")
    params: Dict[str, float] = {}
    if raw is not None:
        if not isinstance(raw, dict):
            raise BadRequest("'parameters' must be an object of parameter id → number")
        for k, v in raw.items():
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise BadRequest(f"parameters[{k!r}] must be a finite number")
            params[str(k)] = float(v)
    return StateRequest(plugin_id, state, params, preset)


def parse_render_request(body: Dict[str, Any], max_duration: float) -> RenderRequest:
    base = parse_state_request(body)
    sample_rate = req_int(body, "sample_rate", minimum=8000, maximum=192000)
    channels = req_int(body, "channels", required=False, default=2, minimum=1, maximum=8)
    duration = req_number(body, "duration_seconds", exclusive_minimum=0, maximum=max_duration)
    block_size = req_int(body, "block_size", required=False, default=512, minimum=16, maximum=8192)
    events = parse_events(body.get("events"), duration)
    return RenderRequest(
        base.plugin_id,
        base.state,
        base.parameters,
        base.preset,
        sample_rate=sample_rate,
        channels=channels,
        duration=duration,
        events=events,
        block_size=block_size,
    )


def parse_scan_paths(body: Dict[str, Any], max_items: int = 64) -> List[str]:
    raw = body.get("paths")
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > max_items:
        raise BadRequest(f"'paths' must be an array of at most {max_items} strings")
    out: List[str] = []
    for i, p in enumerate(raw):
        if not isinstance(p, str) or not p.strip() or len(p) > MAX_PLUGIN_ID or "\x00" in p:
            raise BadRequest(f"paths[{i}] must be a non-empty file or directory path")
        out.append(p.strip())
    return out


def encode_state(state: Optional[bytes]) -> Optional[str]:
    return base64.b64encode(state).decode("ascii") if state is not None else None


def state_response(
    plugin_id: str, state: Optional[bytes], parameters: Dict[str, float], preset: Optional[str] = None
) -> Dict[str, Any]:
    out: Dict[str, Any] = {"plugin_id": plugin_id, "parameters": parameters}
    if state is not None:
        out["state_base64"] = encode_state(state)
    if preset:
        out["preset"] = preset
    return out
