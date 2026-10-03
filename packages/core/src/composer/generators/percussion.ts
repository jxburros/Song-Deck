/**
 * Percussion: auxiliary kit percussion (shaker, tambourine, congas, claps, orchestral cymbals and
 * triangle) layered by style and energy, and pitched timpani (rolls into big sections, hits on
 * chord changes, cinematic ostinatos).
 */
import { GM_DRUM as D } from '../../ir/gm';
import { PPQ } from '../../ir/types';
import type { Cell } from '../context';
import { applySwing, chordAtIn, fitToRange, humanize, toVelocity, type RawNote } from '../util';

function swingAt(c: Cell, tick: number): number {
  const { meter, barStart } = c.meterAt(tick);
  if (meter.compound || meter.denominator > 4) return tick;
  let off = tick - barStart;
  if (c.swing8 > 0) off = applySwing(off, PPQ, c.swing8);
  else if (c.swing16 > 0) off = applySwing(off, PPQ / 2, c.swing16);
  return barStart + off;
}

function kitPercussion(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const style = c.g.drumStyle;
  const push = (pitch: number, tick: number, vel: number, dur = 60) => out.push({ pitch, tick: swingAt(c, tick), duration: dur, velocity: toVelocity(vel) });
  const orchestral = style === 'orchestral' || style === 'cinematic';
  for (const bar of c.bars) {
    const e = c.energyAt(bar.tick);
    const m = bar.meter;
    const eighth = m.denominator >= 8 ? m.unitTicks : m.unitTicks / 2;
    const sixteenth = eighth / 2;
    const vScale = 0.7 + 0.35 * e;
    if (orchestral) {
      if (e < 0.45 && bar.index % 2 === 0) push(D.TRIANGLE_OPEN, bar.tick, 60 * vScale, PPQ);
      if (e >= 0.7) push(D.KICK_ACOUSTIC, bar.tick, 100 * vScale, PPQ);
      continue;
    }
    const electronic = style === 'four-on-floor' || style === 'trance' || style === 'synth-pop';
    const urban = style === 'hip-hop' || style === 'trap' || style === 'rnb';
    if (electronic) {
      for (let t = 0; t < m.barTicks; t += sixteenth) push(D.SHAKER, bar.tick + t, ((t / sixteenth) % 2 === 1 ? 70 : 52) * vScale);
      if (e >= 0.5) for (let t = eighth; t < m.barTicks; t += eighth * 2) push(D.TAMBOURINE, bar.tick + t, 74 * vScale);
      continue;
    }
    if (urban) {
      for (let t = 0; t < m.barTicks; t += sixteenth) push(D.SHAKER, bar.tick + t, ((t / sixteenth) % 4 === 2 ? 72 : 50) * vScale);
      if (e >= 0.45) {
        const pattern = 'x..x..x.x..x.x..';
        const step = m.barTicks / 16;
        for (let i = 0; i < 16; i++) if (pattern[i] === 'x') push(i % 3 === 0 ? D.CONGA_LOW : D.CONGA_HIGH, bar.tick + Math.round(i * step), (i === 0 ? 86 : 72) * vScale);
      }
      continue;
    }
    if (style === 'jazz-swing') {
      for (let t = 0; t < m.barTicks; t += eighth) push(D.CABASA, bar.tick + t, (m.beats.includes(t) ? 58 : 46) * vScale);
      continue;
    }
    // Band styles: shaker in quiet sections, tambourine backbeats → eighths as energy rises.
    if (e < 0.5) {
      for (let t = 0; t < m.barTicks; t += eighth) push(D.SHAKER, bar.tick + t, (m.beats.includes(t) ? 64 : 50) * vScale);
    } else if (e < 0.78) {
      const backbeats = m.strong.length > 1 ? m.beats.filter((b) => !m.strong.includes(b) || b === m.strong[1]) : m.beats.slice(1);
      for (const b of backbeats) push(D.TAMBOURINE, bar.tick + b, 82 * vScale);
    } else {
      for (let t = 0; t < m.barTicks; t += eighth) push(D.TAMBOURINE, bar.tick + t, (m.beats.includes(t) && t > 0 ? 90 : 66) * vScale);
    }
  }
  // Orchestral cymbal swell (soft crash roll) into a big next section.
  if (orchestral && c.next && (c.next.section.energy ?? 0) >= 75) {
    const bar = c.bars[c.bars.length - 1];
    const start = bar.tick + Math.round(bar.meter.barTicks / 2);
    for (let t = start, i = 0; t < bar.tick + bar.meter.barTicks; t += PPQ / 8, i++) out.push({ pitch: D.CRASH_2, tick: t, duration: PPQ / 8, velocity: toVelocity(30 + i * 6), articulation: 'tremolo' });
  }
  humanize(out, c.macros.humanization, c.vrng.fork('humanize'), { start: c.span.startTick, end: c.span.endTick, maxTicks: 10, maxVelocity: 10 });
  return out;
}

function timpani(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const lo = c.range.low;
  const hi = c.range.high;
  const place = (pc: number) => fitToRange(36 + ((pc - 36) % 12 + 12) % 12, lo, hi);
  const cinematic = c.g.drumStyle === 'cinematic';
  let lastChordTick = -1;
  for (const bar of c.bars) {
    const e = c.energyAt(bar.tick);
    const chord = chordAtIn(c.chords, bar.tick);
    const root = place(chord.bass ?? chord.root);
    const fifth = place((chord.root + 7) % 12);
    if (cinematic && e >= 0.6) {
      // Ostinato: root on beats, fifth on the pickups.
      const pattern = 'x.x.xx.x';
      const step = bar.meter.barTicks / 8;
      for (let i = 0; i < 8; i++) if (pattern[i] === 'x') out.push({ pitch: i === 5 ? fifth : root, tick: bar.tick + Math.round(i * step), duration: Math.round(step), velocity: toVelocity((i === 0 ? 108 : 90) * (0.75 + 0.3 * e)), articulation: i === 0 ? 'marcato' : 'normal' });
    } else if (e >= 0.62) {
      for (const ch of c.chords) {
        if (ch.tick >= bar.tick && ch.tick < bar.tick + bar.meter.barTicks && ch.tick !== lastChordTick) {
          out.push({ pitch: place(ch.bass ?? ch.root), tick: ch.tick, duration: PPQ, velocity: toVelocity(100 * (0.75 + 0.3 * e)), articulation: 'marcato' });
          lastChordTick = ch.tick;
        }
      }
    } else if (bar.index % 2 === 0) {
      out.push({ pitch: root, tick: bar.tick, duration: PPQ * 2, velocity: toVelocity(70 + 30 * e) });
    }
  }
  // Roll into a louder next section.
  if (c.next && (c.next.section.energy ?? 0) >= (c.section.energy ?? 0) + 10) {
    const bar = c.bars[c.bars.length - 1];
    const nextChord = chordAtIn(c.chords, bar.tick);
    const len = Math.min(bar.meter.barTicks, PPQ * 2);
    const t = bar.tick + bar.meter.barTicks - len;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].tick >= t) out.splice(i, 1);
    out.push({ pitch: place(nextChord.root), tick: t, duration: len, velocity: toVelocity(96), articulation: 'tremolo' });
  }
  return out;
}

export function generatePercussion(c: Cell): RawNote[] {
  if (c.inst.isDrumKit) return kitPercussion(c);
  return timpani(c);
}
