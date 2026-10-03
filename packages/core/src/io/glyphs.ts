import type { PdfCanvas } from './pdf-writer';
import type { AccidentalName, NoteType } from './notation-layout';

/**
 * Vector music glyphs drawn with PDF paths. `s` is the staff space in points; `x`, `y` are
 * page coordinates (y grows upwards). Staff positions are expressed relative to `y0`, the
 * bottom staff line.
 */

const NOTEHEAD_RX = 0.6;
const NOTEHEAD_RY = 0.42;
const NOTEHEAD_TILT = (20 * Math.PI) / 180;

export const GLYPH = {
  noteheadWidth: NOTEHEAD_RX * 2,
  stemWidth: 0.12,
  staffLineWidth: 0.11,
  ledgerWidth: 0.16,
};

/** Filled (quarter and shorter) or hollow (half/whole) notehead centred on (x, y). */
export function drawNotehead(c: PdfCanvas, x: number, y: number, s: number, type: NoteType, shape: 'normal' | 'x' | 'diamond' = 'normal'): void {
  if (shape === 'x') {
    const r = 0.5 * s;
    c.lineCap(1).lineWidth(0.16 * s);
    c.moveTo(x - r, y - r).lineTo(x + r, y + r).moveTo(x - r, y + r).lineTo(x + r, y - r).stroke();
    c.lineCap(0);
    return;
  }
  if (shape === 'diamond') {
    const r = 0.55 * s;
    c.moveTo(x - r, y).lineTo(x, y + r).lineTo(x + r, y).lineTo(x, y - r).close().fill();
    return;
  }
  if (type === 'whole') {
    c.ellipse(x, y, 0.78 * s, 0.47 * s, 0);
    c.ellipse(x, y, 0.36 * s, 0.3 * s, (-55 * Math.PI) / 180);
    c.fillEvenOdd();
    return;
  }
  c.ellipse(x, y, NOTEHEAD_RX * s, NOTEHEAD_RY * s, NOTEHEAD_TILT);
  if (type === 'half') {
    c.ellipse(x, y, 0.5 * s, 0.2 * s, (32 * Math.PI) / 180);
    c.fillEvenOdd();
  } else c.fill();
}

/** Stem from a notehead; returns the x of the stem and the y of its free end. */
export function drawStem(c: PdfCanvas, x: number, y: number, s: number, up: boolean, length = 3.5): { sx: number; tip: number } {
  const sx = up ? x + (NOTEHEAD_RX - 0.06) * s : x - (NOTEHEAD_RX - 0.06) * s;
  const from = up ? y + 0.15 * s : y - 0.15 * s;
  const tip = up ? y + length * s : y - length * s;
  c.line(sx, from, sx, tip, GLYPH.stemWidth * s);
  return { sx, tip };
}

/** Flags (1 = eighth, 2 = 16th, 3 = 32nd) at the free end of a stem. */
export function drawFlags(c: PdfCanvas, sx: number, tip: number, s: number, up: boolean, count: number): void {
  const dir = up ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const t = tip + dir * i * 0.8 * s;
    const x0 = sx - (GLYPH.stemWidth * s) / 2;
    c.moveTo(x0, t);
    c.curveTo(x0 + 0.15 * s, t + dir * 0.9 * s, x0 + 1.35 * s, t + dir * 1.3 * s, x0 + 0.95 * s, t + dir * 2.75 * s);
    c.curveTo(x0 + 1.05 * s, t + dir * 1.75 * s, x0 + 0.35 * s, t + dir * 1.45 * s, x0, t + dir * 1.15 * s);
    c.close().fill();
  }
}

export function drawDot(c: PdfCanvas, x: number, y: number, s: number): void {
  c.circle(x, y, 0.19 * s).fill();
}

/** Ledger lines for a notehead at staff position `pos` (0 = bottom line, 8 = top line, half-space steps). */
export function drawLedgers(c: PdfCanvas, x: number, y0: number, s: number, pos: number, extra = 0): void {
  const half = (NOTEHEAD_RX + 0.38) * s + extra;
  c.lineWidth(GLYPH.ledgerWidth * s);
  for (let p = -2; p >= pos; p -= 2) c.moveTo(x - half, y0 + (p * s) / 2).lineTo(x + half, y0 + (p * s) / 2);
  for (let p = 10; p <= pos; p += 2) c.moveTo(x - half, y0 + (p * s) / 2).lineTo(x + half, y0 + (p * s) / 2);
  c.stroke();
}

/** Accidental glyph centred at (x, y). */
export function drawAccidental(c: PdfCanvas, x: number, y: number, s: number, acc: AccidentalName): void {
  const thin = 0.11 * s;
  const thick = 0.42 * s;
  const bar = (x1: number, y1: number, x2: number, y2: number) => {
    c.moveTo(x1, y1 - thick / 2).lineTo(x2, y2 - thick / 2).lineTo(x2, y2 + thick / 2).lineTo(x1, y1 + thick / 2).close().fill();
  };
  switch (acc) {
    case 'sharp':
      c.line(x - 0.22 * s, y - 1.25 * s, x - 0.22 * s, y + 1.15 * s, thin);
      c.line(x + 0.22 * s, y - 1.15 * s, x + 0.22 * s, y + 1.25 * s, thin);
      bar(x - 0.5 * s, y - 0.5 * s, x + 0.5 * s, y - 0.25 * s);
      bar(x - 0.5 * s, y + 0.3 * s, x + 0.5 * s, y + 0.55 * s);
      return;
    case 'flat':
      c.line(x - 0.32 * s, y - 0.5 * s, x - 0.32 * s, y + 2.0 * s, thin * 1.2);
      c.moveTo(x - 0.32 * s, y - 0.5 * s);
      c.curveTo(x + 0.15 * s, y - 0.2 * s, x + 0.75 * s, y + 0.25 * s, x + 0.35 * s, y + 0.65 * s);
      c.curveTo(x + 0.05 * s, y + 0.9 * s, x - 0.2 * s, y + 0.6 * s, x - 0.32 * s, y + 0.35 * s);
      c.lineTo(x - 0.32 * s, y + 0.15 * s);
      c.curveTo(x - 0.1 * s, y + 0.5 * s, x + 0.25 * s, y + 0.55 * s, x + 0.25 * s, y + 0.3 * s);
      c.curveTo(x + 0.25 * s, y + 0.05 * s, x - 0.05 * s, y - 0.2 * s, x - 0.32 * s, y - 0.38 * s);
      c.close().fill();
      return;
    case 'natural':
      c.line(x - 0.28 * s, y - 0.6 * s, x - 0.28 * s, y + 1.4 * s, thin);
      c.line(x + 0.28 * s, y - 1.4 * s, x + 0.28 * s, y + 0.6 * s, thin);
      bar(x - 0.28 * s, y - 0.45 * s, x + 0.28 * s, y - 0.25 * s);
      bar(x - 0.28 * s, y + 0.25 * s, x + 0.28 * s, y + 0.45 * s);
      return;
    case 'double-sharp': {
      const r = 0.42 * s;
      c.lineCap(1).lineWidth(0.18 * s);
      c.moveTo(x - r, y - r).lineTo(x + r, y + r).moveTo(x - r, y + r).lineTo(x + r, y - r).stroke();
      c.lineCap(0);
      return;
    }
    case 'flat-flat':
      drawAccidental(c, x - 0.35 * s, y, s, 'flat');
      drawAccidental(c, x + 0.35 * s, y, s, 'flat');
      return;
  }
}

/** Horizontal space an accidental needs left of the notehead. */
export function accidentalWidth(acc: AccidentalName, s: number): number {
  return (acc === 'flat-flat' ? 1.9 : acc === 'flat' ? 1.25 : 1.35) * s;
}

/** Rest glyph centred horizontally at x (y0 = bottom staff line). */
export function drawRest(c: PdfCanvas, x: number, y0: number, s: number, type: NoteType): void {
  const Y = (p: number) => y0 + p * s;
  switch (type) {
    case 'whole':
      c.rect(x - 0.6 * s, Y(3) - 0.5 * s, 1.2 * s, 0.5 * s).fill();
      return;
    case 'half':
      c.rect(x - 0.6 * s, Y(2), 1.2 * s, 0.5 * s).fill();
      return;
    case 'quarter': {
      c.lineCap(1).lineJoin(1).lineWidth(0.3 * s);
      c.moveTo(x - 0.25 * s, Y(3.3));
      c.lineTo(x + 0.35 * s, Y(2.55));
      c.curveTo(x - 0.2 * s, Y(2.2), x - 0.3 * s, Y(1.95), x + 0.3 * s, Y(1.25));
      c.curveTo(x - 0.45 * s, Y(1.45), x - 0.45 * s, Y(0.85), x + 0.05 * s, Y(0.55));
      c.stroke();
      c.lineCap(0).lineJoin(0);
      return;
    }
    case 'eighth':
    case '16th':
    case '32nd': {
      // A slanted stem with one hook (dot + curl) per flag, hooks stacked down the stem.
      const hooks = type === 'eighth' ? 1 : type === '16th' ? 2 : 3;
      const topY = Y(2.75);
      const top = { x: x + 0.45 * s, y: topY + 0.1 * s };
      const bottom = { x: x - 0.15 * s - (hooks - 1) * 0.25 * s, y: Y(1.0 - (hooks - 1)) };
      c.line(top.x, top.y, bottom.x, bottom.y, 0.13 * s);
      const slope = (top.x - bottom.x) / (top.y - bottom.y || 1);
      for (let i = 0; i < hooks; i++) {
        const hy = topY - i * s;
        const hx = top.x - slope * (top.y - hy);
        c.circle(hx - 0.75 * s, hy - 0.05 * s, 0.24 * s).fill();
        c.lineWidth(0.13 * s).moveTo(hx - 0.75 * s, hy - 0.2 * s).curveTo(hx - 0.4 * s, hy - 0.3 * s, hx - 0.1 * s, hy - 0.2 * s, hx, hy + 0.08 * s).stroke();
      }
      return;
    }
  }
}

/** Treble (G) clef; (x, y0) = left edge at the bottom staff line. Returns the width used. */
export function drawTrebleClef(c: PdfCanvas, x: number, y0: number, s: number, octaveBelow = false): number {
  const P = (px: number, py: number): [number, number] => [x + px * s, y0 + py * s];
  const mv = (px: number, py: number) => {
    const [a, b] = P(px, py);
    c.moveTo(a, b);
  };
  const cv = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    const [a, b] = P(x1, y1);
    const [d, e] = P(x2, y2);
    const [f, g] = P(x3, y3);
    c.curveTo(a, b, d, e, f, g);
  };
  c.lineCap(1).lineJoin(1);
  // Spiral around the G line, rising body, top loop, long descending stroke.
  c.lineWidth(0.17 * s);
  mv(1.32, 1.42);
  cv(1.2, 1.75, 0.55, 1.65, 0.5, 1.15);
  cv(0.45, 0.55, 1.05, 0.05, 1.55, 0.25);
  cv(2.2, 0.5, 2.25, 1.55, 1.55, 2.0);
  cv(0.75, 2.5, 0.3, 2.9, 0.45, 3.65);
  cv(0.6, 4.4, 1.35, 5.0, 1.45, 5.6);
  cv(1.55, 6.15, 1.0, 6.3, 0.95, 5.5);
  cv(0.9, 4.6, 1.2, 1.5, 1.25, -0.6);
  cv(1.27, -1.3, 0.75, -1.45, 0.5, -1.05);
  c.stroke();
  // Thicken the main curve of the bowl and body.
  c.lineWidth(0.3 * s);
  mv(0.52, 0.85);
  cv(0.75, 0.15, 1.6, 0.1, 1.9, 0.75);
  c.stroke();
  mv(1.6, 1.95);
  cv(0.9, 2.45, 0.35, 2.85, 0.5, 3.75);
  c.stroke();
  const [dx, dy] = P(0.62, -1.05);
  c.circle(dx, dy, 0.3 * s).fill();
  c.lineCap(0).lineJoin(0);
  if (octaveBelow) c.text(x + 0.85 * s, y0 - 3.0 * s, '8', 'F2', 1.6 * s, 'center');
  return 2.6 * s;
}

/** Bass (F) clef. Returns the width used. */
export function drawBassClef(c: PdfCanvas, x: number, y0: number, s: number, octaveBelow = false): number {
  const P = (px: number, py: number): [number, number] => [x + px * s, y0 + py * s];
  const [hx, hy] = P(0.45, 3.0);
  c.circle(hx, hy, 0.32 * s).fill();
  c.lineCap(1).lineWidth(0.3 * s);
  const a = P(0.3, 3.15);
  const b = P(0.5, 4.05);
  const d = P(1.85, 4.05);
  const e = P(1.95, 3.0);
  c.moveTo(a[0], a[1]).curveTo(b[0], b[1], d[0], d[1], e[0], e[1]);
  const f = P(2.0, 2.0);
  const g = P(1.15, 1.0);
  const h = P(0.2, 0.25);
  c.curveTo(f[0], f[1], g[0], g[1], h[0], h[1]);
  c.stroke();
  c.lineCap(0);
  const [d1x, d1y] = P(2.45, 3.5);
  const [d2x, d2y] = P(2.45, 2.5);
  c.circle(d1x, d1y, 0.17 * s).fill();
  c.circle(d2x, d2y, 0.17 * s).fill();
  if (octaveBelow) c.text(x + 1.1 * s, y0 - 2.2 * s, '8', 'F2', 1.6 * s, 'center');
  return 2.9 * s;
}

/** Percussion (neutral) clef. */
export function drawPercussionClef(c: PdfCanvas, x: number, y0: number, s: number): number {
  c.rect(x + 0.4 * s, y0 + 1 * s, 0.35 * s, 2 * s).fill();
  c.rect(x + 1.05 * s, y0 + 1 * s, 0.35 * s, 2 * s).fill();
  return 2.0 * s;
}

/** Time signature digits stacked on the staff. Returns the width used. */
export function drawTimeSignature(c: PdfCanvas, x: number, y0: number, s: number, num: number, den: number): number {
  const size = 2.85 * s;
  const top = String(num);
  const bottom = String(den);
  const w = Math.max(top.length, bottom.length) * 0.556 * size;
  c.text(x + w / 2, y0 + 2.02 * s, top, 'F2', size, 'center');
  c.text(x + w / 2, y0 + 0.02 * s, bottom, 'F2', size, 'center');
  return w + 0.6 * s;
}
