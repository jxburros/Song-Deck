import { zlibSync } from 'fflate';
import { concatBytes, latin1 } from './util';

/**
 * Minimal PDF 1.4 writer: catalog, page tree, standard Type 1 fonts (Helvetica family, WinAnsi
 * encoding), Flate-compressed content streams, document info and a byte-exact xref table.
 * Pure TypeScript — works in browsers and Node.
 */

export type PdfFont = 'F1' | 'F2' | 'F3';
export const PDF_FONTS: Record<PdfFont, string> = {
  F1: 'Helvetica',
  F2: 'Helvetica-Bold',
  F3: 'Helvetica-Oblique',
};

// Adobe Core 14 AFM advance widths (1/1000 em) for WinAnsi codes 32–126.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
  500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469,
  556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278,
  556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584,
  556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
  333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Map a Unicode string to WinAnsi bytes (as a binary string); unmappable characters become "?". */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x266f) out += '#';
    else if (cp === 0x266d) out += 'b';
    else if (cp === 0x266e) out += 'n';
    else if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) out += String.fromCharCode(cp);
    else if (WIN_ANSI_EXTRA[cp] !== undefined) out += String.fromCharCode(WIN_ANSI_EXTRA[cp]);
    else if (cp === 0x09) out += ' ';
    else out += '?';
  }
  return out;
}

/** Advance width of a string in points. */
export function textWidth(text: string, font: PdfFont, size: number): number {
  const table = font === 'F2' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let w = 0;
  const s = toWinAnsi(text);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += c >= 32 && c <= 126 ? table[c - 32] : 556;
  }
  return (w / 1000) * size;
}

function escapePdfString(binary: string): string {
  return binary.replace(/[\\()]/g, (m) => `\\${m}`).replace(/[\r\n]/g, ' ');
}

/** Number formatting for content streams (max 3 decimals, no exponent). */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Content-stream builder with a few path/text helpers. */
export class PdfCanvas {
  private ops: string[] = [];

  raw(op: string): this {
    this.ops.push(op);
    return this;
  }
  save(): this {
    return this.raw('q');
  }
  restore(): this {
    return this.raw('Q');
  }
  gray(fill: number, stroke = fill): this {
    return this.raw(`${fmt(fill)} g ${fmt(stroke)} G`);
  }
  lineWidth(w: number): this {
    return this.raw(`${fmt(w)} w`);
  }
  lineCap(cap: 0 | 1 | 2): this {
    return this.raw(`${cap} J`);
  }
  lineJoin(join: 0 | 1 | 2): this {
    return this.raw(`${join} j`);
  }
  moveTo(x: number, y: number): this {
    return this.raw(`${fmt(x)} ${fmt(y)} m`);
  }
  lineTo(x: number, y: number): this {
    return this.raw(`${fmt(x)} ${fmt(y)} l`);
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    return this.raw(`${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x)} ${fmt(y)} c`);
  }
  close(): this {
    return this.raw('h');
  }
  stroke(): this {
    return this.raw('S');
  }
  fill(): this {
    return this.raw('f');
  }
  fillEvenOdd(): this {
    return this.raw('f*');
  }
  fillStroke(): this {
    return this.raw('B');
  }
  rect(x: number, y: number, w: number, h: number): this {
    return this.raw(`${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re`);
  }
  line(x1: number, y1: number, x2: number, y2: number, width: number): this {
    return this.lineWidth(width).moveTo(x1, y1).lineTo(x2, y2).stroke();
  }
  /** Closed ellipse path (4 Bézier arcs), optionally rotated by `angle` radians. */
  ellipse(cx: number, cy: number, rx: number, ry: number, angle = 0): this {
    const k = 0.5522847498;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const P = (x: number, y: number): [number, number] => [cx + x * cos - y * sin, cy + x * sin + y * cos];
    const pts: [number, number][][] = [
      [P(rx, k * ry), P(k * rx, ry), P(0, ry)],
      [P(-k * rx, ry), P(-rx, k * ry), P(-rx, 0)],
      [P(-rx, -k * ry), P(-k * rx, -ry), P(0, -ry)],
      [P(k * rx, -ry), P(rx, -k * ry), P(rx, 0)],
    ];
    const start = P(rx, 0);
    this.moveTo(start[0], start[1]);
    for (const [a, b, c] of pts) this.curveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
    return this.close();
  }
  circle(cx: number, cy: number, r: number): this {
    return this.ellipse(cx, cy, r, r);
  }
  /** Text at (x, y) baseline; align left/center/right. */
  text(
    x: number,
    y: number,
    text: string,
    font: PdfFont,
    size: number,
    align: 'left' | 'center' | 'right' = 'left',
  ): this {
    const w = align === 'left' ? 0 : textWidth(text, font, size);
    const tx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    return this.raw(
      `BT /${font} ${fmt(size)} Tf ${fmt(tx)} ${fmt(y)} Td (${escapePdfString(toWinAnsi(text))}) Tj ET`,
    );
  }
  toString(): string {
    return this.ops.join('\n');
  }
}

export interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  /** PDF date (default: none, for reproducible files). */
  creationDate?: Date;
}

/** PDF text string: ASCII literal, else UTF-16BE hex with BOM. */
function pdfTextString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${escapePdfString(s)})`;
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export class PdfDocument {
  private pages: { width: number; height: number; content: string }[] = [];

  constructor(private readonly info: PdfInfo = {}) {}

  addPage(width: number, height: number, content: PdfCanvas | string): void {
    this.pages.push({ width, height, content: typeof content === 'string' ? content : content.toString() });
  }

  get pageCount(): number {
    return this.pages.length;
  }

  toBytes(opts: { compress?: boolean } = {}): Uint8Array {
    const compress = opts.compress !== false;
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let offset = 0;
    const push = (b: Uint8Array) => {
      chunks.push(b);
      offset += b.length;
    };
    const pushText = (s: string) => push(latin1(s));
    // Header with a binary comment so transfer tools treat the file as binary.
    push(
      Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a),
    );

    const pageCount = this.pages.length || 1;
    const pages = this.pages.length ? this.pages : [{ width: 612, height: 792, content: '' }];
    // Object numbers: 1 catalog, 2 pages, 3-5 fonts, 6 info, then (page, contents) pairs.
    const fontObj: Record<PdfFont, number> = { F1: 3, F2: 4, F3: 5 };
    const pageObj = (i: number) => 7 + i * 2;
    const contentObj = (i: number) => 8 + i * 2;
    const totalObjects = 6 + pageCount * 2;

    const object = (num: number, body: string | Uint8Array[]) => {
      offsets[num] = offset;
      pushText(`${num} 0 obj\n`);
      if (typeof body === 'string') pushText(body);
      else for (const b of body) push(b);
      pushText('\nendobj\n');
    };

    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(
      2,
      `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    );
    for (const [name, base] of Object.entries(PDF_FONTS) as [PdfFont, string][]) {
      object(
        fontObj[name],
        `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`,
      );
    }
    const info: string[] = [];
    if (this.info.title) info.push(`/Title ${pdfTextString(this.info.title)}`);
    if (this.info.author) info.push(`/Author ${pdfTextString(this.info.author)}`);
    if (this.info.subject) info.push(`/Subject ${pdfTextString(this.info.subject)}`);
    info.push(`/Creator ${pdfTextString(this.info.creator ?? 'Song Deck')}`);
    info.push(`/Producer ${pdfTextString(this.info.producer ?? 'Song Deck PDF writer')}`);
    if (this.info.creationDate) info.push(`/CreationDate (${pdfDate(this.info.creationDate)})`);
    object(6, `<< ${info.join(' ')} >>`);
    const fontDict = `<< ${(Object.keys(PDF_FONTS) as PdfFont[]).map((f) => `/${f} ${fontObj[f]} 0 R`).join(' ')} >>`;
    pages.forEach((p, i) => {
      object(
        pageObj(i),
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(p.width)} ${fmt(p.height)}] /Resources << /Font ${fontDict} /ProcSet [/PDF /Text] >> /Contents ${contentObj(i)} 0 R >>`,
      );
      const raw = latin1(p.content);
      const data = compress ? zlibSync(raw, { level: 6 }) : raw;
      object(contentObj(i), [
        latin1(`<< /Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
        data,
        latin1('\nendstream'),
      ]);
    });
    const xrefOffset = offset;
    let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= totalObjects; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    pushText(xref);
    pushText(
      `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    );
    return concatBytes(chunks);
  }
}
