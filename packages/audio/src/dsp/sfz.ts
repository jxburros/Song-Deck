/**
 * SFZ parser (user soundfonts / sample libraries, spec §28) → SampleInstrument.
 *
 * Supports <control>/<global>/<master>/<group>/<region> inheritance, comments, #define variables,
 * note names (c4 = 60, honouring octave_offset/note_offset), sample paths with spaces, and the
 * opcodes: sample, default_path, key, lokey, hikey, pitch_keycenter, lovel, hivel, tune, transpose,
 * volume, pan, pitch_keytrack, amp_veltrack, loop_mode/loopmode, loop_start/loopstart,
 * loop_end/loopend, offset, end, ampeg_attack/hold/decay/sustain/release, group, off_by, trigger,
 * seq_length, seq_position, lorand, hirand.
 */
import type { AudioData } from '../types';
import type { SampleInstrument, SampleLoopMode, SampleZone } from './sampler';

const NOTE_INDEX: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function parseNote(v: string, octaveOffset: number, noteOffset: number): number | undefined {
  const s = v.trim().toLowerCase();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10) + noteOffset;
  const m = /^([a-g])([#b♯♭]?)(-?\d+)$/.exec(s);
  if (!m) return undefined;
  let n = NOTE_INDEX[m[1]];
  if (m[2] === '#' || m[2] === '♯') n += 1;
  if (m[2] === 'b' || m[2] === '♭') n -= 1;
  const oct = parseInt(m[3], 10) + octaveOffset;
  return (oct + 1) * 12 + n + noteOffset;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ');
}

type Opcodes = Record<string, string>;

/** Parse SFZ text. `resolveSample` maps a (default_path-joined, '/'-separated) path to audio. */
export function parseSfz(text: string, resolveSample: (path: string) => AudioData | undefined): SampleInstrument {
  let src = stripComments(text);
  // #define $NAME value
  const defines: Record<string, string> = {};
  src = src.replace(/#define\s+(\$[A-Za-z0-9_]+)\s+([^\s]+)/g, (_m, k: string, v: string) => {
    defines[k] = v;
    return ' ';
  });
  src = src.replace(/#include\s+"[^"]*"/g, ' ');
  const names = Object.keys(defines).sort((a, b) => b.length - a.length);
  for (const k of names) src = src.split(k).join(defines[k]);

  const control: Opcodes = {};
  let global: Opcodes = {};
  let master: Opcodes = {};
  let group: Opcodes = {};
  const regions: Opcodes[] = [];
  let name: string | undefined;

  const headerRe = /<\s*([a-zA-Z_]+)\s*>/g;
  const parts: { header: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  let last: { header: string; start: number } | null = null;
  while ((m = headerRe.exec(src))) {
    if (last) parts.push({ header: last.header, body: src.slice(last.start, m.index) });
    last = { header: m[1].toLowerCase(), start: m.index + m[0].length };
  }
  if (last) parts.push({ header: last.header, body: src.slice(last.start) });

  const parseBody = (body: string): Opcodes => {
    const ops: Opcodes = {};
    const re = /([A-Za-z0-9_]+)\s*=/g;
    const found: { key: string; start: number; valStart: number }[] = [];
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(body))) found.push({ key: mm[1].toLowerCase(), start: mm.index, valStart: mm.index + mm[0].length });
    for (let i = 0; i < found.length; i++) {
      const end = i + 1 < found.length ? found[i + 1].start : body.length;
      let val = body.slice(found[i].valStart, end).trim();
      if (found[i].key !== 'sample') val = val.split(/\s+/)[0] ?? '';
      ops[found[i].key] = val;
    }
    return ops;
  };

  for (const p of parts) {
    const ops = parseBody(p.body);
    switch (p.header) {
      case 'control':
        Object.assign(control, ops);
        break;
      case 'global':
        global = ops;
        master = {};
        group = {};
        break;
      case 'master':
        master = ops;
        group = {};
        break;
      case 'group':
        group = ops;
        break;
      case 'region':
        regions.push({ ...global, ...master, ...group, ...ops });
        break;
      default:
        if (p.header === 'curve' || p.header === 'effect' || p.header === 'midi') break;
    }
    if (ops.name && !name) name = ops.name;
  }

  const defaultPath = (control.default_path ?? '').replace(/\\/g, '/');
  const octaveOffset = parseInt(control.octave_offset ?? '0', 10) || 0;
  const noteOffset = parseInt(control.note_offset ?? '0', 10) || 0;
  const num = (o: Opcodes, k: string, d: number): number => {
    const v = o[k];
    if (v === undefined) return d;
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : d;
  };
  const note = (o: Opcodes, k: string): number | undefined => (o[k] !== undefined ? parseNote(o[k], octaveOffset, -noteOffset) : undefined);
  const cache = new Map<string, AudioData | undefined>();
  const zones: SampleZone[] = [];
  for (const r of regions) {
    const sample = r.sample;
    if (!sample) continue;
    const path = (defaultPath + sample.replace(/\\/g, '/')).replace(/\/{2,}/g, '/');
    let audio = cache.get(path);
    if (!cache.has(path)) {
      try {
        audio = resolveSample(path);
      } catch {
        audio = undefined;
      }
      cache.set(path, audio);
    }
    if (!audio || !audio.channels.length || !audio.channels[0].length) continue;
    const key = note(r, 'key');
    let lokey = note(r, 'lokey') ?? key ?? 0;
    let hikey = note(r, 'hikey') ?? key ?? 127;
    const center = note(r, 'pitch_keycenter') ?? key ?? 60;
    lokey = Math.max(0, Math.min(127, lokey));
    hikey = Math.max(lokey, Math.min(127, hikey));
    const lm = (r.loop_mode ?? r.loopmode ?? '').toLowerCase();
    const loopMode: SampleLoopMode | undefined =
      lm === 'one_shot' || lm === 'loop_continuous' || lm === 'loop_sustain' || lm === 'no_loop' ? (lm as SampleLoopMode) : undefined;
    const loopStart = r.loop_start ?? r.loopstart;
    const loopEnd = r.loop_end ?? r.loopend;
    const trig = (r.trigger ?? 'attack').toLowerCase();
    const zone: SampleZone = {
      sample: audio,
      lokey,
      hikey,
      pitchKeycenter: center,
      lovel: Math.max(1, Math.min(127, num(r, 'lovel', 1))),
      hivel: Math.max(1, Math.min(127, num(r, 'hivel', 127))),
      tune: num(r, 'tune', 0),
      transpose: num(r, 'transpose', 0),
      volume: num(r, 'volume', 0),
      pan: num(r, 'pan', 0),
      pitchKeytrack: num(r, 'pitch_keytrack', 100),
      ampVeltrack: num(r, 'amp_veltrack', 100),
      offset: num(r, 'offset', 0),
      ampegAttack: num(r, 'ampeg_attack', 0),
      ampegHold: num(r, 'ampeg_hold', 0),
      ampegDecay: num(r, 'ampeg_decay', 0),
      ampegSustain: num(r, 'ampeg_sustain', 100),
      ampegRelease: num(r, 'ampeg_release', 0.03),
      trigger: trig === 'release' ? 'release' : 'attack',
    };
    if (r.end !== undefined) zone.end = num(r, 'end', audio.channels[0].length - 1);
    if (loopMode) zone.loopMode = loopMode;
    if (loopStart !== undefined) zone.loopStart = num(r, loopStart === r.loop_start ? 'loop_start' : 'loopstart', 0);
    if (loopEnd !== undefined) zone.loopEnd = num(r, loopEnd === r.loop_end ? 'loop_end' : 'loopend', audio.channels[0].length - 1);
    if (r.group !== undefined) zone.group = num(r, 'group', 0);
    if (r.off_by !== undefined) zone.offBy = num(r, 'off_by', 0);
    if (r.seq_length !== undefined) zone.seqLength = num(r, 'seq_length', 1);
    if (r.seq_position !== undefined) zone.seqPosition = num(r, 'seq_position', 1);
    if (r.lorand !== undefined) zone.lorand = num(r, 'lorand', 0);
    if (r.hirand !== undefined) zone.hirand = num(r, 'hirand', 1);
    zones.push(zone);
  }
  return { name, zones };
}
