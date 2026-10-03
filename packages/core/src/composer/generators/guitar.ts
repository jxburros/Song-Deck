/**
 * Rhythm guitar (spec §16 "Rhythm Guitar"): power chords for heavy genres, open/barre shapes
 * otherwise, strumming patterns with down/up strokes and per-string strum offsets, palm-muted
 * verses, open ringing choruses, anticipation "pushes", fingerpicked arpeggios for quiet clean
 * parts, boom-chick country and short jazz comping. Double-tracked L/R parts differ in voicing and
 * pattern detail for width.
 */
import type { ChordEvent, ChordSpec } from '../../ir/types';
import { PPQ } from '../../ir/types';
import { mod12 } from '../../theory/pitch';
import { guitarVoicing, voiceChord } from '../../theory/voicing';
import type { Cell } from '../context';
import { findSongMotif } from '../motifs';
import { transposeDiatonic } from '../../theory/scales';
import { applySwing, chordAtIn, clamp, humanize, toVelocity, type BarInfo, type RawNote } from '../util';

type Texture = 'power8' | 'mute8' | 'gallop' | 'ring1' | 'ring2' | 'push8' | 'pop' | 'folk' | 'funk16' | 'arp' | 'pick' | 'offbeat' | 'comp' | 'boomchick' | 'riff';

const PATTERNS: Partial<Record<Texture, string[]>> = {
  power8: ['D.d.D.d.D.d.D.d.'],
  mute8: ['D.d.d.d.D.d.d.d.', 'D.d.d.d.d.d.D.d.'],
  gallop: ['D.ddD.ddD.ddD.dd', 'D.d.D.ddD.d.D.dd'],
  ring1: ['D---------------'],
  ring2: ['D-------D-------', 'D-------d---d---'],
  push8: ['D.d.d.d.D.d.d.dU', 'D.d.d.dUd.d.D.d.'],
  pop: ['D...d.u...u.d.u.', 'D...d.u.d.u.d.u.'],
  folk: ['D.u.d.u.D.u.d.u.', 'D.d.u.d.D.d.u.d.'],
  funk16: ['DxuxdxUxdxuxDxux', 'Dx.xdxUx.xuxdxux'],
  offbeat: ['..d...d...d...d.'],
  comp: ['d...d...d...d...', 'd.....d...d.....'],
};

function heavy(c: Cell): boolean {
  return c.inst.id === 'electric-guitar-distorted' || c.g.genre.harmony.powerChords === true && c.inst.id !== 'acoustic-guitar' && c.inst.id !== 'electric-guitar-clean';
}

function chooseTexture(c: Cell): Texture {
  const e = c.intensity;
  const kind = c.kind;
  const d = c.g.drumStyle;
  const ov = c.g.settings.overrides?.accompaniment;
  const chorusy = kind === 'chorus' || kind === 'final-chorus' || kind === 'drop' || kind === 'post-chorus' || kind === 'solo';
  if (ov === 'sustain') return e > 0.6 ? 'ring2' : 'ring1';
  if (ov === 'arp') return 'arp';
  if (ov === 'stabs') return 'offbeat';
  if (heavy(c)) {
    // Riff-driven intros/interludes state the song's riff (Motif E).
    if ((kind === 'intro' || kind === 'interlude') && e >= 0.3 && findSongMotif(c.song, 'riff') && c.rng.chance(0.75)) return 'riff';
    if (e < 0.3 || kind === 'breakdown') return 'ring1';
    if (kind === 'intro' || kind === 'outro') return e >= 0.6 ? 'push8' : 'ring2';
    if (c.feel === 'half-time') return 'ring2';
    if (d === 'metal') return chorusy ? (e > 0.85 ? 'power8' : 'ring2') : c.macros.complexity > 0.55 ? 'gallop' : 'mute8';
    if (kind === 'verse') return 'mute8';
    if (kind === 'pre-chorus') return e >= 0.62 ? 'push8' : 'mute8';
    if (kind === 'bridge') return e >= 0.75 ? 'push8' : 'ring2';
    if (chorusy) return d === 'rock' && c.macros.syncopation > 0.4 ? 'push8' : 'power8';
    return 'push8';
  }
  const acoustic = c.inst.id === 'acoustic-guitar';
  if (d === 'jazz-swing') return 'comp';
  if (d === 'country' && e >= 0.35 && e < 0.8 && !chorusy) return 'boomchick';
  if (d === 'four-on-floor' || (d === 'rnb' && !acoustic)) return e > 0.5 ? 'funk16' : 'offbeat';
  if (e < 0.32 || kind === 'intro' || kind === 'outro' || kind === 'breakdown') return acoustic ? 'pick' : 'arp';
  if (d === 'indie' || d === 'emo') return chorusy ? 'folk' : 'arp';
  if (acoustic) return e >= 0.62 ? 'folk' : 'pop';
  if (c.macros.syncopation > 0.6 && c.bpm < 125) return 'funk16';
  return chorusy ? 'folk' : 'pop';
}

/** Pattern string for any meter: strums on felt beats, upstrokes on off-beats. */
function genericPattern(bar: BarInfo, texture: Texture): string {
  const m = bar.meter;
  const steps = m.steps;
  const step = m.barTicks / steps;
  let s = '';
  for (let i = 0; i < steps; i++) {
    const off = Math.round(i * step);
    const onBeat = m.beats.includes(off);
    const onStrong = m.strong.includes(off);
    const eighth = m.compound || m.denominator >= 8 ? off % m.unitTicks === 0 : off % (m.unitTicks / 2) === 0;
    if (texture === 'ring1') s += i === 0 ? 'D' : '-';
    else if (texture === 'ring2') s += onStrong ? 'D' : '-';
    else if (texture === 'comp') s += onBeat ? 'd' : '.';
    else if (texture === 'boomchick') s += onBeat && !onStrong ? 'd' : '.';
    else if (texture === 'offbeat') s += !onBeat && eighth ? 'd' : '.';
    else if (texture === 'power8' || texture === 'mute8' || texture === 'push8' || texture === 'gallop') s += eighth ? (onStrong ? 'D' : 'd') : '.';
    else s += onStrong ? 'D' : onBeat ? 'd' : eighth ? 'u' : '.';
  }
  return s;
}

function powerVoicing(chord: ChordSpec, prevRoot: number | null, variant: number): number[] {
  const pc = chord.root;
  // Root on the low E or A string (E2..D#3), voice-led to the previous root.
  const cands = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51].filter((p) => mod12(p) === mod12(pc));
  let root = cands[0];
  if (prevRoot !== null) for (const p of cands) if (Math.abs(p - prevRoot) < Math.abs(root - prevRoot)) root = p;
  const fifth = chord.quality === 'dim' || chord.quality === 'm7b5' || chord.quality === 'dim7' ? 6 : chord.quality === 'aug' || chord.quality === 'aug7' ? 8 : 7;
  const shape = [root, root + fifth, root + 12];
  // R guitar: same chord an octave up the neck (or with the octave doubled) for width.
  if (variant % 2 === 1) return root < 45 ? [root + 12, root + 12 + fifth, root + 24] : [root, root + fifth, root + 12, root + fifth + 12];
  return shape;
}

function openVoicing(chord: ChordSpec, prev: number[] | null, variant: number): number[] {
  if (variant % 2 === 1) {
    // Higher triad voicing (top strings), voice-led.
    return voiceChord({ root: chord.root, quality: chord.quality }, { low: 55, high: 79, voices: 4, previous: prev ?? undefined, center: 66 });
  }
  const v = guitarVoicing(chord, 'open');
  return v.length ? v : voiceChord(chord, { low: 40, high: 76, voices: 5 });
}

export function generateRhythmGuitar(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const texture = chooseTexture(c);
  const isHeavy = heavy(c);
  const variant = c.roleIndex;
  const lo = c.range.low;
  const hi = c.range.high;
  const end = c.span.endTick;
  const pushProb = c.avoid.has('syncopation') ? 0 : c.macros.syncopation * 0.55;
  const busyVerse = c.avoid.has('busy-verses') && c.kind === 'verse';
  const voicings = new Map<string, number[]>();
  let prevRoot: number | null = null;
  let prevVoicing: number[] | null = null;
  const voicingFor = (ch: ChordEvent): number[] => {
    const key = `${ch.root}:${ch.quality}:${ch.bass ?? ''}`;
    let v = voicings.get(key);
    if (!v) {
      v = isHeavy ? powerVoicing(ch, prevRoot, variant) : openVoicing(ch, prevVoicing, variant);
      v = v.map((p) => {
        let q = p;
        while (q > hi) q -= 12;
        while (q < lo) q += 12;
        return q;
      });
      voicings.set(key, v);
    }
    prevRoot = v[0];
    prevVoicing = v;
    return v;
  };
  const changes = c.chords.map((ch) => ch.tick);

  if (texture === 'riff') {
    // The riff, re-placed on each bar's chord root: power-chord hits on the root, single-note
    // movement in between, palm-muted chugs; the R guitar doubles it an octave up.
    const motif = findSongMotif(c.song, 'riff')!;
    for (const bar of c.bars) {
      const ch = chordAtIn(c.chords, bar.tick);
      const pv = powerVoicing(ch, prevRoot, 0);
      prevRoot = pv[0];
      const octave = variant % 2 === 1 && pv[0] + 12 + 7 <= hi ? 12 : 0;
      const e = c.energyAt(bar.tick);
      for (const mn of motif.notes) {
        if (mn.offset >= bar.meter.barTicks) continue;
        const t = bar.tick + mn.offset;
        const p = transposeDiatonic(pv[0], mn.degree, c.key) + octave;
        const dur = Math.max(40, Math.min(mn.duration, bar.meter.barTicks - mn.offset) - 10);
        const chug = mn.degree === 0 && dur <= PPQ / 2;
        const vel = toVelocity((mn.velocity * (0.75 + 0.3 * e) - 88) * (0.65 + 0.7 * c.macros.dynamics) + 88);
        out.push({ pitch: p, tick: t, duration: chug ? Math.round(dur * 0.6) : dur, velocity: vel, motifId: motif.id, ...(chug ? { articulation: 'palm-mute' as const } : {}) });
        if (mn.degree === 0 && !chug) out.push({ pitch: p + 7, tick: t + 4, duration: dur - 4, velocity: toVelocity(vel - 4), motifId: motif.id });
      }
    }
  } else if (texture === 'arp' || texture === 'pick') {
    // Fingerpicked / arpeggiated: thumb on the root, fingers walking the upper strings.
    const orders = texture === 'pick' ? [[0, 3, 2, 4, 1, 3, 2, 4]] : [[0, 2, 3, 4, 5, 4, 3, 2], [0, 3, 2, 4, 3, 5, 4, 2], [0, 4, 3, 5, 2, 4, 3, 5]];
    const order = c.rng.pick(orders);
    for (const bar of c.bars) {
      const step = c.bpm > 140 ? bar.meter.barTicks / 8 : bar.meter.barTicks / (busyVerse ? 4 : c.macros.density > 0.6 && c.bpm < 100 ? 16 : 8);
      const n = Math.round(bar.meter.barTicks / step);
      for (let i = 0; i < n; i++) {
        const t = bar.tick + Math.round(i * step);
        const ch = chordAtIn(c.chords, t);
        const v = voicingFor(ch).slice().sort((a, b) => a - b);
        const idx = order[i % order.length] % v.length;
        const e = c.energyAt(t);
        out.push({ pitch: v[idx], tick: t, duration: Math.round(step * (variant % 2 ? 1.6 : 2.2)), velocity: toVelocity((i === 0 ? 84 : 70) * (0.75 + 0.35 * e)) });
      }
    }
  } else {
    const pool = PATTERNS[texture];
    const pattern = pool ? pool[(c.rng.int(0, pool.length - 1) + (variant % 2)) % pool.length] : undefined;
    const mute = texture === 'mute8' || texture === 'gallop';
    for (const bar of c.bars) {
      const pat = bar.meter.common && pattern ? pattern : genericPattern(bar, texture === 'pop' || texture === 'folk' || texture === 'funk16' ? 'folk' : texture);
      const steps = pat.length;
      const step = bar.meter.barTicks / steps;
      const barRng = c.rng.fork('bar', bar.index % c.rootBars);
      // R guitar drops the odd upstroke so the doubled parts don't phase-lock.
      const skip = new Set<number>();
      if (variant % 2 === 1) for (let i = 0; i < steps; i++) if ((pat[i] === 'u' || pat[i] === 'd') && i % 4 !== 0 && barRng.chance(0.18)) skip.add(i);
      for (let i = 0; i < steps; i++) {
        const sym = pat[i];
        if (sym === '.' || sym === '-' || skip.has(i)) continue;
        if (busyVerse && i % 4 !== 0) continue;
        let t = bar.tick + Math.round(i * step);
        if (t >= end) break;
        // Next event (for ringing duration).
        let j = i + 1;
        while (j < steps && (pat[j] === '-' || skip.has(j))) j++;
        let nextT = j < steps ? bar.tick + Math.round(j * step) : bar.tick + bar.meter.barTicks;
        if (pat[j] === '.' && j < steps) {
          // A rest: let ring a little, then stop.
          let k = j;
          while (k < steps && pat[k] === '.') k++;
          nextT = Math.min(bar.tick + Math.round(k * step), nextT + Math.round(step));
        }
        let ch = chordAtIn(c.chords, t);
        // Anticipation push: an off-beat strum just before a chord change takes the new chord.
        const nextChange = changes.find((x) => x > t);
        const isOff = i % 4 !== 0;
        if (nextChange !== undefined && nextChange - t <= PPQ / 2 && isOff && nextChange < end && c.rng.fork('push', changes.indexOf(nextChange)).chance(pushProb)) {
          ch = chordAtIn(c.chords, nextChange);
          nextT = Math.max(nextT, nextChange + Math.round(step * 2));
        }
        const voicing = voicingFor(ch);
        const e = c.energyAt(t);
        if (sym === 'x') {
          // Muted scratch.
          const mid = voicing.slice(1, 4);
          mid.forEach((p, k) => out.push({ pitch: p, tick: t + k * 4, duration: 40, velocity: toVelocity(46 + e * 20), articulation: 'dead' }));
          continue;
        }
        const up = sym === 'u' || sym === 'U';
        const accent = sym === 'D' || sym === 'U';
        let strings = voicing.slice().sort((a, b) => a - b);
        if (up) strings = strings.slice(-Math.min(4, strings.length)).reverse();
        if (mute && isHeavy) strings = strings.slice(0, 2);
        const speed = isHeavy ? 5 : up ? 8 : c.inst.id === 'acoustic-guitar' ? 14 : 10;
        // Palm-muted chugs: short and softer; open strums ring to the next stroke.
        const ringing = !mute || (changes.includes(t) && texture !== 'gallop' && barRng.chance(0.25));
        let dur = ringing ? Math.max(60, nextT - t - 12) : Math.max(50, Math.round(Math.min(nextT - t, PPQ / 2) * 0.48));
        if (texture === 'offbeat' || texture === 'comp') dur = Math.min(dur, Math.round(PPQ * 0.4));
        const base = accent ? 104 : up ? 78 : 90;
        const vel = (base * (0.72 + 0.32 * e) - 88) * (0.65 + 0.7 * c.macros.dynamics) + 88 - (mute && !ringing ? 10 : 0);
        if (c.swing8 > 0 || c.swing16 > 0) {
          const { meter, barStart } = c.meterAt(t);
          if (!meter.compound && meter.denominator <= 4) t = barStart + (c.swing8 > 0 ? applySwing(t - barStart, PPQ, c.swing8) : applySwing(t - barStart, PPQ / 2, c.swing16));
        }
        strings.forEach((p, k) => {
          out.push({
            pitch: p,
            tick: t + k * speed,
            duration: Math.max(30, dur - k * speed),
            velocity: toVelocity(vel - k * (up ? 3 : 1.5)),
            ...(mute && !ringing ? { articulation: 'palm-mute' as const } : accent && isHeavy && e > 0.8 ? { articulation: 'accent' as const } : {}),
          });
        });
      }
      if (texture === 'boomchick') {
        // Alternate bass note (root / fifth) on the strong beats under the strums.
        bar.meter.strong.forEach((s, k) => {
          const t = bar.tick + s;
          const ch = chordAtIn(c.chords, t);
          const v = voicingFor(ch);
          const bassPc = k % 2 === 0 ? ch.bass ?? ch.root : (ch.root + 7) % 12;
          let b = v[0];
          while (mod12(b) !== mod12(bassPc) && b < v[0] + 12) b++;
          out.push({ pitch: clamp(b, lo, hi), tick: t, duration: Math.round(bar.meter.beatTicks * 0.9), velocity: toVelocity(92 * (0.75 + 0.3 * c.energyAt(t))) });
        });
      }
    }
  }
  humanize(out, c.macros.humanization, c.vrng.fork('humanize', variant), { start: c.span.startTick, end, maxTicks: 9, maxVelocity: 8 });
  return out;
}
