/**
 * Chordal parts (spec §16 "Piano / Keys", "Strings", "Synthesizers" pads):
 *  - keys accompaniment by energy/genre: ballad (LH octaves + RH broken chords), arpeggios, block
 *    chords, rock-piano eighths, tresillo-syncopated pop/R&B, house off-beat stabs, jazz comping
 *    with shell voicings, harp and mallet arpeggios — all voice-led — plus melodic fills at phrase
 *    ends while the vocal rests;
 *  - pads (synth, organ, string ensemble, brass): sustained voice-led chords with swells, tremolo in
 *    builds, epic string ostinatos at high energy, trance gating, brass stabs.
 */
import type { ChordEvent, Note } from '../../ir/types';
import { PPQ } from '../../ir/types';
import { CHORD_INTERVALS, chordPitchClasses, chordTones } from '../../theory/chords';
import { mod12 } from '../../theory/pitch';
import { scalePitchClasses } from '../../theory/scales';
import { pianoVoicing, voiceChord } from '../../theory/voicing';
import type { Cell } from '../context';
import { applySwing, chordAtIn, clamp, humanize, toVelocity, type RawNote } from '../util';
import { melodyGaps } from './lead';

type KeysPattern = 'block' | 'pulse8' | 'arp' | 'ballad' | 'stabs' | 'syncopated' | 'comp' | 'sustain' | 'harp' | 'mallet';

function keysPattern(c: Cell): KeysPattern {
  const d = c.g.drumStyle;
  const e = c.intensity;
  const kind = c.kind;
  const ov = c.g.settings.overrides?.accompaniment;
  if (c.fn === 'pad' || c.fn === 'harmony' || c.fn === 'texture') return 'sustain';
  if (c.inst.id === 'harp') return 'harp';
  if (c.inst.id === 'marimba') return 'mallet';
  if (ov === 'arp') return 'arp';
  if (ov === 'block') return 'block';
  if (ov === 'pulse') return 'pulse8';
  if (ov === 'sustain') return 'sustain';
  if (ov === 'stabs') return 'stabs';
  if (c.inst.id === 'organ') return e >= 0.7 && ['rock', 'punk', 'pop-punk', 'indie', 'emo'].includes(d) ? 'pulse8' : 'sustain';
  if (d === 'jazz-swing') return 'comp';
  if (d === 'four-on-floor') return e < 0.4 ? 'sustain' : 'stabs';
  if (d === 'rnb' || d === 'hip-hop' || d === 'trap') return e < 0.45 ? 'sustain' : 'syncopated';
  if (d === 'orchestral' || d === 'cinematic') return e < 0.7 ? 'arp' : 'block';
  if (e < 0.35 || kind === 'intro' || kind === 'outro' || kind === 'breakdown') return 'ballad';
  const rocky = ['rock', 'punk', 'pop-punk', 'emo', 'metal', 'indie'].includes(d);
  if (e < 0.6) return kind === 'verse' ? c.rng.pick(['arp', 'block'] as KeysPattern[]) : c.rng.pick(['syncopated', 'block'] as KeysPattern[]);
  return rocky ? 'pulse8' : c.rng.pick(['block', 'syncopated'] as KeysPattern[]);
}

/** Rootless shell voicing (3rd + 7th, plus 9th/5th) for jazz comping. */
function shellVoicing(ch: ChordEvent, prev: number[] | undefined): number[] {
  const tones = chordTones(ch).filter((t) => t.role !== 'root');
  const pcs = tones.slice(0, 3).map((t) => t.pc);
  return voiceChord({ root: ch.root, quality: ch.quality }, { low: 52, high: 74, voices: Math.max(2, Math.min(3, pcs.length)), previous: prev, center: 62 }).filter((p, i, a) => a.indexOf(p) === i);
}

function velocityFor(c: Cell, base: number, tick: number): number {
  const e = c.energyAt(tick);
  return toVelocity((base * (0.72 + 0.32 * e) - 85) * (0.65 + 0.7 * c.macros.dynamics) + 85);
}

function swing(c: Cell, tick: number): number {
  const { meter, barStart } = c.meterAt(tick);
  if (meter.compound || meter.denominator > 4) return tick;
  if (c.swing8 > 0) return barStart + applySwing(tick - barStart, PPQ, c.swing8);
  if (c.swing16 > 0) return barStart + applySwing(tick - barStart, PPQ / 2, c.swing16);
  return tick;
}

function keysAccompaniment(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const pattern = keysPattern(c);
  const bassPresent = c.rolePlays('bass');
  const leftLow = bassPresent ? 43 : 36;
  const r = c.range;
  const rightLow = clamp(c.inst.id === 'electric-piano' ? 52 : 55, r.low, r.high - 12);
  const rightHigh = clamp(c.inst.id === 'electric-piano' ? 76 : 79, rightLow + 12, r.high);
  let prevRight: number[] | undefined;
  let prevShell: number[] | undefined;
  const cache = new Map<string, { left: number[]; right: number[] }>();
  const voicing = (ch: ChordEvent) => {
    const key = `${ch.root}:${ch.quality}:${ch.bass ?? ''}`;
    let v = cache.get(key);
    if (!v) {
      const pv = pianoVoicing(ch, prevRight, { leftLow, rightLow, rightHigh, octaveBass: !bassPresent });
      // Four-note right hand for seventh chords.
      if (CHORD_INTERVALS[ch.quality].length >= 4) pv.right = voiceChord({ root: ch.root, quality: ch.quality }, { low: rightLow, high: rightHigh, voices: 4, previous: prevRight, center: 66 });
      v = pv;
      cache.set(key, v);
    }
    prevRight = v.right;
    return v;
  };
  const add = (pitch: number, tick: number, duration: number, vel: number, articulation?: RawNote['articulation']) => {
    if (pitch < r.low || pitch > r.high) return;
    out.push({ pitch, tick: swing(c, tick), duration: Math.max(30, duration), velocity: vel, ...(articulation ? { articulation } : {}) });
  };
  for (const bar of c.bars) {
    const m = bar.meter;
    const bt = m.beatTicks;
    const barEnd = bar.tick + m.barTicks;
    const chordsInBar = c.chords.filter((ch) => ch.tick < barEnd && ch.tick + ch.duration > bar.tick);
    const segEnd = (t: number) => {
      const ch = chordAtIn(c.chords, t);
      return Math.min(barEnd, ch.tick + ch.duration);
    };
    switch (pattern) {
      case 'sustain':
        for (const ch of chordsInBar) {
          // Each chord sounds from its start (or re-strikes at the bar line when held over).
          const t = Math.max(ch.tick, bar.tick);
          const v = voicing(ch);
          const dur = Math.min(barEnd, ch.tick + ch.duration) - t - 10;
          for (const p of v.right) add(p, t, dur, velocityFor(c, 74, t), 'legato');
          if (!bassPresent) for (const p of v.left) add(p, t, dur, velocityFor(c, 70, t));
        }
        break;
      case 'block': {
        const step = c.macros.density < 0.45 || c.bpm > 140 ? m.barTicks / Math.max(1, m.strong.length) : bt;
        for (let t = bar.tick; t < barEnd; t += step) {
          const ch = chordAtIn(c.chords, t);
          const v = voicing(ch);
          const accent = t === bar.tick;
          const dur = Math.min(step, segEnd(t) - t) - 20;
          for (const p of v.right) add(p, t, dur, velocityFor(c, accent ? 88 : 78, t));
          if (m.strong.includes(t - bar.tick)) for (const p of v.left) add(p, t, Math.min(step * 2, segEnd(t) - t) - 20, velocityFor(c, 84, t));
        }
        break;
      }
      case 'pulse8': {
        const step = m.denominator >= 8 ? m.unitTicks : m.unitTicks / 2;
        for (let t = bar.tick; t < barEnd; t += step) {
          const ch = chordAtIn(c.chords, t);
          const v = voicing(ch);
          const onBeat = m.beats.includes(t - bar.tick);
          for (const p of v.right) add(p, t, step - 25, velocityFor(c, onBeat ? 92 : 76, t));
          if (m.strong.includes(t - bar.tick)) for (const p of v.left) add(p, t, Math.min(bt * 2, segEnd(t) - t) - 20, velocityFor(c, 90, t));
        }
        break;
      }
      case 'arp':
      case 'harp':
      case 'mallet': {
        const fast = (c.bpm < 100 && c.macros.density > 0.45) || pattern === 'harp';
        const step = m.denominator >= 8 ? m.unitTicks : fast ? m.unitTicks / 4 : m.unitTicks / 2;
        const ups = c.rng.pick([[0, 1, 2, 3, 2, 1], [0, 1, 2, 3], [0, 2, 1, 3, 2, 1]]);
        let i = 0;
        for (let t = bar.tick; t < barEnd; t += step, i++) {
          const ch = chordAtIn(c.chords, t);
          const v = voicing(ch);
          const tones = pattern === 'harp' ? [...v.left, ...v.right, ...v.right.map((p) => p + 12)].filter((p) => p <= r.high).sort((a, b) => a - b) : [...v.right].sort((a, b) => a - b);
          if (t === bar.tick || t === ch.tick) for (const p of v.left) add(p, t, Math.min(segEnd(t) - t, m.barTicks) - 10, velocityFor(c, 80, t));
          const idx = pattern === 'harp' ? i % tones.length : ups[i % ups.length] % tones.length;
          add(tones[idx], t, pattern === 'mallet' ? step - 10 : step * 2, velocityFor(c, i % ups.length === 0 ? 78 : 66, t));
        }
        break;
      }
      case 'ballad': {
        // LH: root–fifth–octave walk; RH: sustained chord on each change.
        const step = m.denominator >= 8 ? m.unitTicks : m.unitTicks / 2;
        let k = 0;
        for (let t = bar.tick; t < barEnd; t += step, k++) {
          const ch = chordAtIn(c.chords, t);
          const v = voicing(ch);
          const root = v.left[0];
          const figure = [root, root + 7, root + 12, root + 7];
          if (!bassPresent || k % 2 === 0) add(figure[k % 4] <= r.high ? figure[k % 4] : root, t, step * 2 - 10, velocityFor(c, k % 4 === 0 ? 76 : 62, t));
          if (t === bar.tick || t === ch.tick) {
            const dur = segEnd(t) - t - 10;
            for (const p of v.right) add(p, t, dur, velocityFor(c, 70, t), 'legato');
          }
        }
        break;
      }
      case 'stabs': {
        for (const b of m.beats) {
          const t = bar.tick + b + Math.round(bt / 2);
          if (t >= barEnd) continue;
          const v = voicing(chordAtIn(c.chords, t));
          for (const p of v.right) add(p, t, Math.round(bt * 0.35), velocityFor(c, 92, t), 'staccato');
        }
        break;
      }
      case 'syncopated': {
        // Tresillo (3+3+2 eighths) right hand, left hand on 1 and the "and" of 2.
        const eighth = m.denominator >= 8 ? m.unitTicks : m.unitTicks / 2;
        const slots = Math.round(m.barTicks / eighth);
        const hits = slots === 8 ? [0, 3, 6] : [0, Math.floor(slots / 2)];
        for (const s of hits) {
          const t = bar.tick + s * eighth;
          const ch = chordAtIn(c.chords, t);
          const v = voicing(ch);
          const nextHit = hits.find((h) => h > s);
          const dur = Math.min(segEnd(t), nextHit !== undefined ? bar.tick + nextHit * eighth : barEnd) - t - 20;
          for (const p of v.right) add(p, t, dur, velocityFor(c, s === 0 ? 88 : 80, t));
        }
        for (const s of slots === 8 ? [0, 3] : [0]) {
          const t = bar.tick + s * eighth;
          for (const p of voicing(chordAtIn(c.chords, t)).left) add(p, t, eighth * 2 - 20, velocityFor(c, 84, t));
        }
        break;
      }
      case 'comp': {
        // Charleston (1, and-of-2) plus random anticipations; short shell voicings.
        const positions = [0, Math.round(bt * 1.5)];
        if (c.rng.fork('comp', bar.index % c.rootBars).chance(c.macros.syncopation * 0.6)) positions.push(Math.round(bt * 3.5));
        for (const pos of positions) {
          const t = bar.tick + pos;
          if (t >= barEnd) continue;
          const ch = chordAtIn(c.chords, t + 5);
          const v = shellVoicing(ch, prevShell);
          prevShell = v;
          for (const p of v) add(p, t, Math.round(bt * 0.6), velocityFor(c, pos === 0 ? 78 : 72, t), 'staccato');
        }
        break;
      }
    }
  }
  // Melodic fills at phrase ends while the vocal rests (complexity).
  if (c.fn !== 'pad' && pattern !== 'stabs' && c.macros.complexity > 0.3) {
    const melody: Note[] = c.melodyNotes();
    const gaps = melodyGaps(c, melody, PPQ * 2);
    const scale = scalePitchClasses(c.key);
    for (const bar of c.bars) {
      if (bar.index % 2 !== 1 || bar.index === c.bars.length - 1) continue;
      const fillStart = bar.tick + bar.meter.barTicks - PPQ;
      const fillEnd = bar.tick + bar.meter.barTicks;
      if (melody.length && !gaps.some((g) => g.start <= fillStart && g.end >= fillEnd)) continue;
      const rng = c.rng.fork('kfill', bar.index % c.rootBars);
      if (!rng.chance(c.macros.complexity * 0.55)) continue;
      const step = c.bpm < 120 ? PPQ / 4 : PPQ / 2;
      const target = chordAtIn(c.chords, fillEnd);
      let p = rightHigh + 2;
      while (!chordPitchClasses(target).includes(mod12(p))) p--;
      const n = Math.round(PPQ / step);
      const dir = rng.chance(0.6) ? 1 : -1;
      const run: number[] = [p];
      for (let k = 1; k < n; k++) {
        let q = run[run.length - 1] + dir;
        while (!scale.includes(mod12(q))) q += dir;
        run.push(q);
      }
      run.reverse();
      for (let i = out.length - 1; i >= 0; i--) if (out[i].tick >= fillStart && out[i].tick < fillEnd && out[i].pitch >= rightLow) out.splice(i, 1);
      run.forEach((q, k) => add(clamp(q, r.low, r.high), fillStart + k * step, step - 10, velocityFor(c, 70 + k * 4, fillStart)));
    }
  }
  return out;
}

function padChords(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const r = c.range;
  const id = c.inst.id;
  const isStrings = c.inst.family === 'strings';
  const isBrass = c.inst.family === 'brass';
  const low = clamp(isStrings ? 43 : id === 'organ' ? 48 : 48, r.low, r.high - 12);
  const high = clamp(isStrings ? 86 : 82, low + 12, r.high);
  const d = c.g.drumStyle;
  const gated = id === 'synth-pad' && (d === 'trance' || d === 'four-on-floor' || d === 'synth-pop') && c.intensity >= 0.82 && (c.kind === 'drop' || c.kind === 'chorus' || c.kind === 'final-chorus');
  const epic = isStrings && c.intensity >= 0.78 && (d === 'cinematic' || d === 'orchestral' || d === 'rock' || d === 'emo') && c.kind !== 'breakdown';
  const brassStabs = isBrass && c.intensity >= 0.7;
  const organChops = id === 'organ' && c.intensity >= 0.75 && ['rock', 'punk', 'pop-punk'].includes(d);
  const rising = (c.section.energyEnd ?? c.section.energy) > c.section.energy + 8;
  const build = c.kind === 'build' || (c.kind === 'pre-chorus' && rising);
  let prev: number[] | undefined;
  const voices = c.inst.polyphony === 'mono' ? 1 : c.intensity > 0.7 ? 5 : 4;
  for (const ch of c.chords) {
    const v = voiceChord({ root: ch.root, quality: ch.quality }, { low, high, voices, previous: prev, spread: c.intensity > 0.7 ? 'open' : 'close', center: Math.round((low + high) / 2) });
    prev = v;
    const t0 = ch.tick;
    const t1 = ch.tick + ch.duration;
    if (gated) {
      const pattern = 'x.xx.xx.x.xx.xx.';
      for (const bar of c.bars) {
        const step = bar.meter.barTicks / 16;
        for (let i = 0; i < 16; i++) {
          const t = bar.tick + Math.round(i * step);
          if (t < t0 || t >= t1 || pattern[i] !== 'x') continue;
          for (const p of v) out.push({ pitch: p, tick: t, duration: Math.round(step * 0.8), velocity: velocityFor(c, i % 4 === 0 ? 96 : 82, t), articulation: 'staccato' });
        }
      }
      continue;
    }
    if (brassStabs || organChops) {
      // Hits on the change and on beats; an anticipation stab on the "and" of the last beat.
      const beats: number[] = [];
      for (const bar of c.bars) for (const b of bar.meter.beats) beats.push(bar.tick + b);
      const hits = organChops ? beats.filter((t) => t >= t0 && t < t1) : [t0, ...beats.filter((t) => t > t0 && t < t1 && c.rng.fork('stab', t - c.span.startTick).chance(0.3))];
      for (const t of hits) for (const p of v) out.push({ pitch: p, tick: t, duration: Math.round(PPQ * 0.55), velocity: velocityFor(c, t === t0 ? 104 : 90, t), articulation: 'marcato' });
      if (brassStabs && t1 - PPQ / 2 > t0 && c.macros.syncopation > 0.35 && t1 < c.span.endTick) {
        for (const p of v) out.push({ pitch: p, tick: t1 - PPQ / 2, duration: PPQ / 2 - 20, velocity: velocityFor(c, 100, t1), articulation: 'accent' });
      }
      continue;
    }
    if (epic && voices > 1) {
      // Sustained upper voices + low-string eighth-note ostinato on the root.
      const upper = v.slice(1);
      for (const p of upper) out.push({ pitch: p, tick: t0, duration: t1 - t0 - 15, velocity: velocityFor(c, 92, t0), articulation: build ? 'tremolo' : 'legato' });
      let root = low;
      while (mod12(root) !== mod12(ch.bass ?? ch.root)) root++;
      for (let t = t0; t < t1; t += PPQ / 2) out.push({ pitch: root, tick: t, duration: PPQ / 2 - 40, velocity: velocityFor(c, (t - t0) % PPQ === 0 ? 96 : 82, t), articulation: 'staccato' });
      continue;
    }
    const articulation: RawNote['articulation'] = isStrings ? (build ? 'tremolo' : 'legato') : id === 'synth-pad' || isBrass ? 'legato' : undefined;
    // Long chords re-articulate every two bars so swells can follow the energy curve.
    const seg = Math.max(c.meter.barTicks * 2, t1 - t0 > c.meter.barTicks * 4 ? c.meter.barTicks * 2 : t1 - t0);
    for (let t = t0; t < t1; t += seg) {
      const dur = Math.min(seg, t1 - t) - 15;
      for (const p of v) out.push({ pitch: p, tick: t, duration: Math.max(60, dur), velocity: velocityFor(c, 70 + (rising ? 10 : 0), t), ...(articulation ? { articulation } : {}) });
    }
  }
  return out;
}

export function generateChordal(c: Cell): RawNote[] {
  const pad = c.fn === 'pad' || c.fn === 'texture' || c.fn === 'harmony' || c.track.role === 'synth-pad' || c.inst.family === 'brass' || c.inst.id === 'string-ensemble' && c.fn !== 'accompaniment';
  const notes = pad && c.inst.id !== 'harp' && c.inst.id !== 'marimba' && c.inst.id !== 'piano' && c.inst.id !== 'electric-piano' ? padChords(c) : keysAccompaniment(c);
  if (c.inst.id === 'pizzicato-strings') {
    for (const n of notes) {
      n.articulation = 'pizzicato';
      n.duration = Math.min(n.duration, PPQ / 2);
    }
  }
  humanize(notes, c.macros.humanization * (c.inst.family === 'synth' ? 0.2 : 0.8), c.vrng.fork('humanize'), { start: c.span.startTick, end: c.span.endTick, maxTicks: 8, maxVelocity: 7 });
  return notes;
}
