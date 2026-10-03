import type { Song, Track } from '../ir/types';
import { bpmAtTick, keyAtBar, meterAtBar } from '../timing';
import { keyName } from '../theory/scales';
import { isDrumTrack, lookupInstrument, type InstrumentLookupOptions } from '../edit/instruments';
import {
  accidentalWidth,
  drawAccidental,
  drawBassClef,
  drawDot,
  drawFlags,
  drawLedgers,
  drawNotehead,
  drawPercussionClef,
  drawRest,
  drawStem,
  drawTimeSignature,
  drawTrebleClef,
  GLYPH,
} from './glyphs';
import {
  AccidentalState,
  buildMeasures,
  chordsByMeasure,
  drumDisplay,
  keySignatureAlters,
  keySignatureLetters,
  layoutVoices,
  LETTERS,
  notationGrid,
  notesEnd,
  spellPitch,
  type AccidentalName,
  type MeasureChord,
  type MeasureInfo,
  type NotatedEvent,
} from './notation-layout';
import { PdfCanvas, PdfDocument, textWidth } from './pdf-writer';
import { leadTrack } from './util';

export interface NotationPdfOptions extends InstrumentLookupOptions {
  /** Track to notate (default: the lead vocal, else the first melodic track). */
  trackId?: string;
  /** Title (default: song title). */
  title?: string;
  /** Composer / credit line (default "Song Deck"). */
  composer?: string;
  pageSize?: 'letter' | 'a4';
  /** Staff space in points (default 6.5 → 26 pt staff height). */
  staffSpace?: number;
  /** Flate-compress page content (default true). */
  compress?: boolean;
  /** CreationDate written to the document info (default none → reproducible bytes). */
  creationDate?: Date;
}

type ClefKind = 'treble' | 'bass' | 'percussion';

interface ClefPlan {
  kind: ClefKind;
  octaveBelow: boolean;
  /** Diatonic step added to sounding pitches for display (7 = written an octave higher). */
  displayShift: number;
  /** Diatonic step of the bottom staff line. */
  bottom: number;
}

function planClef(track: Track | undefined, opts: InstrumentLookupOptions): ClefPlan {
  if (!track) return { kind: 'treble', octaveBelow: false, displayShift: 0, bottom: 30 };
  if (isDrumTrack(track, opts)) return { kind: 'percussion', octaveBelow: false, displayShift: 0, bottom: 30 };
  const profile = lookupInstrument(track.instrumentId, opts);
  const avg = track.notes.length ? track.notes.reduce((s, n) => s + n.pitch, 0) / track.notes.length : 64;
  const octave = (profile.notationTranspose ?? 0) >= 12;
  if (profile.clef === 'treble-8vb') return { kind: 'treble', octaveBelow: true, displayShift: 7, bottom: 30 };
  if (profile.clef === 'bass') return { kind: 'bass', octaveBelow: octave, displayShift: octave ? 7 : 0, bottom: 18 };
  if (profile.clef === 'treble') return { kind: 'treble', octaveBelow: false, displayShift: 0, bottom: 30 };
  return avg < 57 ? { kind: 'bass', octaveBelow: false, displayShift: 0, bottom: 18 } : { kind: 'treble', octaveBelow: false, displayShift: 0, bottom: 30 };
}

interface Head {
  pos: number;
  acc?: AccidentalName;
  shape: 'normal' | 'x' | 'diamond';
}

interface Slot {
  ev: NotatedEvent;
  heads: Head[];
  stemUp: boolean;
  width: number;
  x: number;
  lyricWidth: number;
  chordsHere: MeasureChord[];
}

interface MeasurePlan {
  info: MeasureInfo;
  slots: Slot[];
  chords: MeasureChord[];
  minWidth: number;
  /** Extra key/time signature drawn at the start (mid-system changes). */
  showKey: boolean;
  showTime: boolean;
  x: number;
  width: number;
}

interface SystemPlan {
  measures: MeasurePlan[];
  first: boolean;
  showTime: boolean;
  prefixWidth: number;
  top: number;
  bottom: number;
  chordY: number;
  rehearsalY: number;
  lyricY: number;
  hasLyrics: boolean;
  y0: number;
  page: number;
}

const FLAG_COUNT: Record<string, number> = { eighth: 1, '16th': 2, '32nd': 3 };

function keySigWidth(fifths: number, s: number): number {
  return Math.abs(fifths) * 1.15 * s;
}

/** Staff positions for key-signature accidentals (treble; bass is two steps lower). */
const SHARP_POS = [8, 5, 9, 6, 3, 7, 4];
const FLAT_POS = [4, 7, 3, 6, 2, 5, 1];

function drawKeySignature(c: PdfCanvas, x: number, y0: number, s: number, fifths: number, clef: ClefKind): number {
  if (clef === 'percussion' || fifths === 0) return 0;
  const count = keySignatureLetters(fifths).length;
  const shift = clef === 'bass' ? -2 : 0;
  for (let i = 0; i < count; i++) {
    const pos = (fifths > 0 ? SHARP_POS[i] : FLAT_POS[i]) + shift;
    drawAccidental(c, x + (i + 0.5) * 1.15 * s, y0 + (pos * s) / 2, s, fifths > 0 ? 'sharp' : 'flat');
  }
  return keySigWidth(fifths, s);
}

function drawClef(c: PdfCanvas, x: number, y0: number, s: number, clef: ClefPlan): number {
  if (clef.kind === 'bass') return drawBassClef(c, x, y0, s, clef.octaveBelow);
  if (clef.kind === 'percussion') return drawPercussionClef(c, x, y0, s);
  return drawTrebleClef(c, x, y0, s, clef.octaveBelow);
}

function clefWidth(clef: ClefPlan, s: number): number {
  return clef.kind === 'bass' ? 2.9 * s : clef.kind === 'percussion' ? 2.0 * s : 2.6 * s;
}

function timeSigWidth(m: MeasureInfo, s: number): number {
  return Math.max(String(m.numerator).length, String(m.denominator).length) * 0.556 * 2.85 * s + 0.6 * s;
}

/**
 * Lead-sheet PDF (spec §55 "notation PDF"): title, credit line, tempo/key; the melody (vocal by
 * default) on 5-line staves with clef, key and time signatures, bar lines (double at section ends,
 * final bar), noteheads, stems, flags, dots, rests, ledger lines, accidentals, ties, chord symbols
 * above, lyrics (with hyphens/extenders) below and section rehearsal labels; multiple systems per
 * page and multiple pages.
 */
export function songToNotationPdf(song: Song, opts: NotationPdfOptions = {}): Uint8Array {
  const lookup: InstrumentLookupOptions = { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument };
  const [pageW, pageH] = opts.pageSize === 'a4' ? [595.28, 841.89] : [612, 792];
  const s = opts.staffSpace ?? 6.5;
  const margin = { left: 50, right: 50, top: 50, bottom: 50 };
  const contentW = pageW - margin.left - margin.right;
  const track = leadTrack(song, opts.trackId);
  const clef = planClef(track, lookup);
  const notes = track?.notes ?? [];
  const grid = notationGrid(song);
  const measures = buildMeasures(song, notesEnd(notes));
  const drums = clef.kind === 'percussion';
  const voices = layoutVoices(notes, measures, { ppq: song.ppq, grid, monophonic: !drums, maxVoices: 1 });
  const voice = voices[0];
  const harmonies = chordsByMeasure(song, measures, grid);
  const lyricSize = 1.45 * s;
  const chordSize = 1.6 * s;

  // ---- per-measure content -----------------------------------------------------------
  const plans: MeasurePlan[] = measures.map((info, mi) => {
    const events = voice[mi] ?? [];
    const acc = new AccidentalState(keySignatureAlters(info.fifths));
    const chords = harmonies[mi];
    const slots: Slot[] = events
      .filter((ev) => !ev.hidden)
      .map((ev) => {
        const heads: Head[] = [];
        if (!ev.rest) {
          for (const pitch of ev.pitches) {
            if (drums) {
              const d = drumDisplay(pitch);
              const diatonic = d.octave * 7 + LETTERS.indexOf(d.step as (typeof LETTERS)[number]);
              heads.push({ pos: diatonic - clef.bottom, shape: d.notehead === 'x' || d.notehead === 'circle-x' ? 'x' : d.notehead === 'diamond' ? 'diamond' : 'normal' });
            } else {
              const sp = spellPitch(pitch, info.key);
              const a = acc.accidentalFor(sp, ev.tieStop);
              heads.push({ pos: sp.diatonic + clef.displayShift - clef.bottom, acc: a, shape: 'normal' });
            }
          }
        }
        const mid = heads.length ? (Math.max(...heads.map((h) => h.pos)) + Math.min(...heads.map((h) => h.pos))) / 2 : 4;
        const stemUp = drums ? true : mid < 4;
        const dur = ev.duration / song.ppq;
        let width = 3.3 * s * Math.pow(Math.max(dur, 0.125), 0.55);
        if (heads.some((h) => h.acc)) width += 1.3 * s;
        width += ev.dots * 0.7 * s;
        if (stemUp && FLAG_COUNT[ev.type] && !ev.rest) width += 0.6 * s;
        const lyricWidth = ev.lyric ? textWidth(ev.lyric.text, 'F1', lyricSize) + (ev.lyric.syllabic === 'begin' || ev.lyric.syllabic === 'middle' ? 1.6 * s : 0.9 * s) : 0;
        width = Math.max(width, lyricWidth);
        if (ev.measureRest) width = Math.max(width, 6 * s);
        const chordsHere = chords.filter((ch) => ch.offset >= ev.start && ch.offset < ev.start + ev.duration);
        for (const ch of chordsHere) width = Math.max(width, textWidth(ch.chord.symbol, 'F2', chordSize) + 1.2 * s);
        return { ev, heads, stemUp, width, x: 0, lyricWidth, chordsHere };
      });
    const minWidth = 1.4 * s + slots.reduce((a, b) => a + b.width, 0) + 0.6 * s;
    return { info, slots, chords, minWidth, showKey: false, showTime: false, x: 0, width: 0 };
  });

  // ---- systems -------------------------------------------------------------------------
  const prefixFor = (m: MeasureInfo, first: boolean) =>
    0.8 * s + clefWidth(clef, s) + 0.8 * s + (clef.kind !== 'percussion' ? keySigWidth(m.fifths, s) : 0) + (first || m.meterChange ? timeSigWidth(m, s) + 0.6 * s : 0) + 0.6 * s;
  const systems: SystemPlan[] = [];
  let i = 0;
  while (i < plans.length) {
    const firstSystem = systems.length === 0;
    const prefix = prefixFor(plans[i].info, firstSystem);
    const sys: SystemPlan = {
      measures: [],
      first: firstSystem,
      showTime: firstSystem || plans[i].info.meterChange,
      prefixWidth: prefix,
      top: 0,
      bottom: 0,
      chordY: 0,
      rehearsalY: 0,
      lyricY: 0,
      hasLyrics: false,
      y0: 0,
      page: 0,
    };
    let used = prefix;
    while (i < plans.length) {
      const m = plans[i];
      const inSystem = sys.measures.length > 0;
      let extra = 0;
      if (inSystem && (m.info.keyChange || m.info.meterChange)) {
        m.showKey = m.info.keyChange && clef.kind !== 'percussion';
        m.showTime = m.info.meterChange;
        extra = (m.showKey ? keySigWidth(m.info.fifths, s) + 0.8 * s : 0) + (m.showTime ? timeSigWidth(m.info, s) : 0);
      } else {
        m.showKey = false;
        m.showTime = false;
      }
      const w = m.minWidth + extra;
      if (inSystem && (used + w > contentW || sys.measures.length >= 6)) break;
      if (inSystem && m.info.section && used >= 0.55 * contentW) break;
      m.minWidth = w;
      sys.measures.push(m);
      used += w;
      i++;
    }
    // Justify.
    const natural = sys.measures.reduce((a, m) => a + m.minWidth, 0);
    const last = i >= plans.length;
    let scale = (contentW - prefix) / natural;
    if (last) scale = Math.min(scale, 1.35);
    let x = margin.left + prefix;
    for (const m of sys.measures) {
      m.x = x;
      m.width = m.minWidth * scale;
      let sx = x + 1.4 * s * scale + (m.showKey ? keySigWidth(m.info.fifths, s) + 0.8 * s : 0) * scale + (m.showTime ? timeSigWidth(m.info, s) : 0) * scale;
      for (const slot of m.slots) {
        const w = slot.width * scale;
        slot.x = slot.ev.measureRest ? x + m.width / 2 : sx + Math.min(w / 2, 1.2 * s);
        sx += w;
      }
      x += m.width;
    }
    // Vertical extents (relative to the bottom staff line).
    let noteTop = 4 * s;
    let noteBottom = 0;
    for (const m of sys.measures) {
      for (const slot of m.slots) {
        if (!slot.heads.length) continue;
        const hi = Math.max(...slot.heads.map((h) => h.pos)) * (s / 2);
        const lo = Math.min(...slot.heads.map((h) => h.pos)) * (s / 2);
        const stem = slot.ev.type === 'whole' ? 0.6 * s : 3.6 * s;
        noteTop = Math.max(noteTop, (slot.stemUp ? hi + stem : hi + 0.6 * s) + (slot.heads.some((h) => h.acc === 'flat') ? 1.6 * s : 0));
        noteBottom = Math.min(noteBottom, slot.stemUp ? lo - 0.6 * s : lo - stem);
      }
    }
    const hasChords = sys.measures.some((m) => m.chords.length);
    const hasRehearsal = sys.measures.some((m) => m.info.section || tempoMarks(m.info).length);
    sys.hasLyrics = sys.measures.some((m) => m.slots.some((sl) => sl.ev.lyric));
    sys.chordY = Math.max(4 * s + 1.8 * s, noteTop + 1.0 * s);
    sys.rehearsalY = sys.chordY + (hasChords ? chordSize + 0.9 * s : 0);
    sys.top = hasRehearsal ? sys.rehearsalY + 1.6 * s + 3 : hasChords ? sys.chordY + chordSize : Math.max(noteTop, 5 * s);
    sys.lyricY = Math.min(-2.4 * s, noteBottom - 1.8 * s) - lyricSize * 0.75;
    sys.bottom = sys.hasLyrics ? sys.lyricY - lyricSize * 0.45 : Math.min(noteBottom, -1.2 * s);
    systems.push(sys);
  }

  // ---- pages ---------------------------------------------------------------------------
  const title = opts.title ?? (song.title || 'Untitled');
  const headerHeight = 86;
  const gap = 2.2 * s;
  let page = 0;
  let cursor = pageH - margin.top - headerHeight;
  for (const sys of systems) {
    const h = sys.top - sys.bottom;
    if (cursor - h < margin.bottom + 14 && cursor < pageH - margin.top - (page === 0 ? headerHeight : 18) - 1) {
      page++;
      cursor = pageH - margin.top - 18;
    }
    sys.page = page;
    sys.y0 = cursor - sys.top;
    cursor = sys.y0 + sys.bottom - gap;
  }
  const pageCount = page + 1;

  // ---- drawing -------------------------------------------------------------------------
  const canvases = Array.from({ length: pageCount }, () => new PdfCanvas().gray(0));
  const c0 = canvases[0];
  // Header: title, subtitle, credit, tempo & key.
  c0.text(pageW / 2, pageH - margin.top - 20, title, 'F2', 20, 'center');
  const styles = song.blueprint?.styles?.filter(Boolean).join(' · ');
  if (styles) c0.text(pageW / 2, pageH - margin.top - 38, styles, 'F3', 10, 'center');
  c0.text(pageW - margin.right, pageH - margin.top - 56, opts.composer ?? 'Song Deck', 'F1', 10, 'right');
  {
    const ty = pageH - margin.top - 74;
    const end = drawMetronome(c0, margin.left + 2, ty, bpmAtTick(song, 0), 10);
    const meter = meterAtBar(song, 0);
    const keyText = `${keyName(keyAtBar(song, 0))} · ${meter.numerator}/${meter.denominator}${track ? ` · ${track.name}` : ''}`;
    c0.text(end + 12, ty, keyText, 'F1', 10);
  }
  for (let p = 0; p < pageCount; p++) {
    const c = canvases[p];
    if (p > 0) c.text(margin.left, pageH - margin.top + 6, title, 'F3', 8);
    c.text(pageW / 2, margin.bottom - 24, `${p + 1} / ${pageCount}`, 'F1', 8, 'center');
  }

  // Flatten slots for tie / lyric continuation lookups.
  const order: { slot: Slot; sys: SystemPlan }[] = [];
  for (const sys of systems) for (const m of sys.measures) for (const slot of m.slots) order.push({ slot, sys });
  const indexOf = new Map(order.map((o, idx) => [o.slot, idx] as const));

  for (const sys of systems) {
    const c = canvases[sys.page];
    const y0 = sys.y0;
    const left = margin.left;
    const right = margin.left + contentW;
    const Y = (pos: number) => y0 + (pos * s) / 2;
    // Staff lines (the last system may be shorter than the full width)
    const staffRight = Math.min(right, sys.measures[sys.measures.length - 1].x + sys.measures[sys.measures.length - 1].width);
    c.lineWidth(GLYPH.staffLineWidth * s);
    for (let l = 0; l < 5; l++) c.moveTo(left, y0 + l * s).lineTo(staffRight, y0 + l * s);
    c.stroke();
    // System start: barline, clef, key, time
    c.line(left, y0, left, y0 + 4 * s, 0.12 * s);
    let px = left + 0.8 * s;
    px += drawClef(c, px, y0, s, clef) + 0.8 * s;
    const first = sys.measures[0].info;
    if (clef.kind !== 'percussion') px += drawKeySignature(c, px, y0, s, first.fifths, clef.kind);
    if (sys.showTime) drawTimeSignature(c, px + (first.fifths !== 0 && clef.kind !== 'percussion' ? 0.9 : 0.3) * s, y0, s, first.numerator, first.denominator);
    if (!sys.first) c.text(left, y0 + 4 * s + 1.2 * s, String(first.index + 1), 'F3', 7);

    for (const m of sys.measures) {
      const isLast = m.info.index === measures.length - 1;
      const mEnd = m.x + m.width;
      // Mid-system key/time changes.
      let cx = m.x + 0.9 * s;
      if (m.showKey) cx += drawKeySignature(c, cx, y0, s, m.info.fifths, clef.kind) + 0.4 * s;
      if (m.showTime) drawTimeSignature(c, cx, y0, s, m.info.numerator, m.info.denominator);
      // Bar line(s)
      if (isLast) {
        c.line(mEnd - 0.9 * s, y0, mEnd - 0.9 * s, y0 + 4 * s, 0.12 * s);
        c.rect(mEnd - 0.5 * s, y0, 0.5 * s, 4 * s).fill();
      } else if (m.info.sectionEnd) {
        c.line(mEnd - 0.6 * s, y0, mEnd - 0.6 * s, y0 + 4 * s, 0.12 * s);
        c.line(mEnd, y0, mEnd, y0 + 4 * s, 0.12 * s);
      } else c.line(mEnd, y0, mEnd, y0 + 4 * s, 0.12 * s);
      // Rehearsal mark and tempo changes
      let markX = m.x + (m === sys.measures[0] ? 0 : 0.4 * s);
      if (m.info.section) {
        const label = m.info.section.name;
        const w = textWidth(label, 'F2', 9) + 6;
        c.lineWidth(0.8).rect(markX, sys.rehearsalY + y0 - 3, w, 13).stroke();
        c.text(markX + 3, sys.rehearsalY + y0, label, 'F2', 9);
        markX += w + 6;
      }
      for (const t of tempoMarks(m.info)) {
        const off = ((t.tick - m.info.startTick) / (m.info.endTick - m.info.startTick)) * m.width * 0.8;
        markX = Math.max(markX, m.x + off);
        markX = drawMetronome(c, markX, sys.rehearsalY + y0, t.bpm) + 6;
      }
      // Chord symbols
      for (const h of m.chords) {
        const slot = m.slots.find((sl) => h.offset >= sl.ev.start && h.offset < sl.ev.start + sl.ev.duration) ?? m.slots[0];
        let x = m.x + 1.4 * s;
        if (slot) {
          const frac = slot.ev.measureRest ? h.offset / slot.ev.duration : (h.offset - slot.ev.start) / slot.ev.duration;
          const base = slot.ev.measureRest ? m.x + 1.4 * s + frac * (m.width - 2 * s) : slot.x - 0.6 * s + frac * slot.width;
          x = base;
        }
        c.text(x, y0 + sys.chordY, h.chord.symbol, 'F2', chordSize);
      }
      // Notes & rests
      for (const slot of m.slots) {
        const ev = slot.ev;
        if (ev.rest) {
          drawRest(c, slot.x, y0, s, ev.measureRest ? 'whole' : ev.type);
          if (!ev.measureRest) for (let d = 0; d < ev.dots; d++) drawDot(c, slot.x + (1.0 + d * 0.6) * s, Y(5), s);
          continue;
        }
        const x = slot.x;
        const positions = slot.heads.map((h) => h.pos);
        const lo = Math.min(...positions);
        const hi = Math.max(...positions);
        drawLedgers(c, x, y0, s, lo);
        drawLedgers(c, x, y0, s, hi);
        // Accidentals (stacked leftwards when several).
        let accX = x - 1.25 * s;
        for (const h of [...slot.heads].sort((a, b) => b.pos - a.pos)) {
          if (!h.acc) continue;
          drawAccidental(c, accX, Y(h.pos), s, h.acc);
          accX -= accidentalWidth(h.acc, s) * 0.6;
        }
        // Heads: seconds inside a chord are displaced to the other side of the stem.
        const sorted = [...slot.heads].sort((a, b) => a.pos - b.pos);
        let prevPos = -999;
        let flip = false;
        for (const h of sorted) {
          flip = h.pos - prevPos === 1 ? !flip : false;
          const hx = flip ? x + (slot.stemUp ? 1 : -1) * GLYPH.noteheadWidth * s * 0.95 : x;
          drawNotehead(c, hx, Y(h.pos), s, ev.type, h.shape);
          prevPos = h.pos;
        }
        if (ev.type !== 'whole') {
          const anchor = slot.stemUp ? lo : hi;
          const far = slot.stemUp ? hi : lo;
          // Reach at least the middle line; extend for chords.
          const base = 3.5 + Math.abs(far - anchor) / 2;
          const toMiddle = slot.stemUp ? (4 - anchor) / 2 : (anchor - 4) / 2;
          const len = Math.max(base, toMiddle);
          const { sx, tip } = drawStem(c, x, Y(anchor), s, slot.stemUp, len);
          const flags = FLAG_COUNT[ev.type] ?? 0;
          if (flags) drawFlags(c, sx, tip, s, slot.stemUp, flags);
        }
        // Dots go in a space.
        for (let d = 0; d < ev.dots; d++) {
          for (const pos of new Set(positions)) {
            const dp = pos % 2 === 0 ? pos + 1 : pos;
            drawDot(c, x + (1.05 + d * 0.55) * s + (slot.stemUp && FLAG_COUNT[ev.type] ? 0.6 * s : 0), Y(dp), s);
          }
        }
        // Ties
        if (ev.tieStart) {
          const idx = indexOf.get(slot)!;
          const next = order[idx + 1];
          const below = slot.stemUp;
          for (const pos of positions) {
            const ty = Y(pos) + (below ? -0.75 * s : 0.75 * s);
            if (next && next.sys === sys) drawTie(c, x + 0.75 * s, next.slot.x - 0.75 * s, ty, s, below);
            else drawTie(c, x + 0.75 * s, staffRight + 0.2 * s, ty, s, below);
          }
        }
        if (ev.tieStop) {
          const idx = indexOf.get(slot)!;
          const prev = order[idx - 1];
          if (prev && prev.sys !== sys) {
            const below = prev.slot.stemUp;
            for (const pos of positions) drawTie(c, left + sys.prefixWidth - 1.6 * s, x - 0.75 * s, Y(pos) + (below ? -0.75 * s : 0.75 * s), s, below);
          }
        }
        // Lyrics
        if (ev.lyric) {
          const ly = y0 + sys.lyricY;
          c.text(x, ly, ev.lyric.text, 'F1', lyricSize, 'center');
          const tw = textWidth(ev.lyric.text, 'F1', lyricSize);
          const idx = indexOf.get(slot)!;
          if (ev.lyric.syllabic === 'begin' || ev.lyric.syllabic === 'middle') {
            // Hyphen centred between this syllable and the next sung one.
            let j = idx + 1;
            while (j < order.length && !order[j].slot.ev.lyric) j++;
            const nx = j < order.length && order[j].sys === sys ? order[j].slot.x - textWidth(order[j].slot.ev.lyric!.text, 'F1', lyricSize) / 2 : x + tw / 2 + 2.4 * s;
            const hx = (x + tw / 2 + nx) / 2;
            c.text(hx, ly, '-', 'F1', lyricSize, 'center');
          } else if (ev.lyric.extend) {
            // Melisma extender to the last note before the next syllable or rest.
            let j = idx + 1;
            let endX = x + tw / 2;
            while (j < order.length && order[j].sys === sys && !order[j].slot.ev.rest && !order[j].slot.ev.lyric) {
              endX = order[j].slot.x + 0.6 * s;
              j++;
            }
            if (endX > x + tw / 2 + 2) c.line(x + tw / 2 + 1, ly - 0.5, endX, ly - 0.5, 0.6);
          }
        }
      }
    }
  }

  const doc = new PdfDocument({ title, subject: 'Lead sheet', creationDate: opts.creationDate });
  for (const c of canvases) doc.addPage(pageW, pageH, c);
  return doc.toBytes({ compress: opts.compress });
}

/** Tempo changes to print in a measure (the opening tempo is printed in the header). */
function tempoMarks(m: MeasureInfo): { tick: number; bpm: number }[] {
  return m.tempos.filter((t) => t.tick > 0);
}

/** "♩ = 120" metronome mark; returns the x after the text. */
function drawMetronome(c: PdfCanvas, x: number, y: number, bpm: number, size = 9): number {
  const gs = size * 0.42;
  drawNotehead(c, x + 3, y + 1.5, gs, 'quarter');
  drawStem(c, x + 3, y + 1.5, gs, true, 3.3);
  const text = `= ${Math.round(bpm * 10) / 10}`;
  c.text(x + 9, y, text, 'F2', size);
  return x + 9 + textWidth(text, 'F2', size);
}

function drawTie(c: PdfCanvas, x1: number, x2: number, y: number, s: number, below: boolean): void {
  if (x2 - x1 < 1) return;
  const dir = below ? -1 : 1;
  const h = Math.min(1.4 * s, 0.35 * s + (x2 - x1) * 0.08) * dir;
  const t = 0.22 * s * dir;
  const d = (x2 - x1) * 0.25;
  c.moveTo(x1, y);
  c.curveTo(x1 + d, y + h, x2 - d, y + h, x2, y);
  c.curveTo(x2 - d, y + h - t, x1 + d, y + h - t, x1, y);
  c.close().fill();
}
