/**
 * Embedded audio-file metadata reader (tags only — no audio decoding), used as the offline
 * rights signal for uploads (docs/RIGHTS.md):
 *
 *  - ID3v2.2 / 2.3 / 2.4 (MP3, and `id3 ` chunks in WAV) + ID3v1 trailer
 *  - RIFF LIST/INFO (WAV): ICOP, IART, INAM, IPRD, ICMT, …
 *  - Vorbis comments (FLAC, Ogg Vorbis / Opus / FLAC-in-Ogg): COPYRIGHT, ISRC, LABEL, ORGANIZATION, ARTIST, TITLE, …
 *  - MP4/M4A `moov/udta/meta/ilst`: cprt, ©ART, ©nam, ©alb, iTunes store atoms (apID, purd, cnID, …),
 *    freeform `----` items (com.apple.iTunes:ISRC, LABEL, …)
 *
 * The reader never throws: malformed or truncated input yields whatever was readable plus a
 * warning. Every read is bounds-checked and the work is capped (frames, pages, atoms, tags,
 * value lengths), so hostile files cannot make it loop or allocate without bound.
 *
 * `classifyRightsSignals` turns the tags into a warn-only signal: an ISRC, a copyright notice, a
 * label/publisher or store-purchase markers suggest a commercial release; artist/title alone is
 * a softer hint. Absence of tags proves nothing (tags are trivially stripped).
 */

export type MetadataContainer = 'mp3' | 'wav' | 'flac' | 'ogg' | 'mp4' | 'unknown';
export type TagSource = 'id3v2' | 'id3v1' | 'riff-info' | 'vorbis' | 'mp4';

/** Normalized meaning of a tag (the raw key is kept alongside). */
export type TagField = 'title' | 'artist' | 'album' | 'copyright' | 'publisher' | 'isrc' | 'purchase' | 'owner' | 'comment' | 'url' | 'other';

export interface AudioTag {
  source: TagSource;
  /** Raw key: frame id ("TCOP"), INFO id ("ICOP"), Vorbis field ("COPYRIGHT"), atom ("cprt", "----:com.apple.iTunes:ISRC"). */
  key: string;
  field: TagField;
  value: string;
}

export interface AudioFileMetadata {
  container: MetadataContainer;
  tags: AudioTag[];
  /** Problems met while parsing (truncation, bad sizes); parsing continued where possible. */
  warnings: string[];
}

export interface MetadataReadOptions {
  /** Maximum tags collected (default 200). */
  maxTags?: number;
  /** Maximum characters kept per value (default 500). */
  maxValueLength?: number;
}

const MAX_ID3_FRAMES = 2000;
const MAX_OGG_PAGES = 256;
const MAX_OGG_PACKET_BYTES = 4 * 1024 * 1024;
const MAX_ATOMS = 20000;
const MAX_RIFF_CHUNKS = 4096;
const MAX_FLAC_BLOCKS = 256;
const MAX_VORBIS_COMMENTS = 1000;

// ---------------------------------------------------------------------------------------------
// Bounded reading helpers
// ---------------------------------------------------------------------------------------------

class Collector {
  readonly tags: AudioTag[] = [];
  readonly warnings: string[] = [];
  constructor(
    private readonly maxTags: number,
    private readonly maxLen: number,
  ) {}
  get full(): boolean {
    return this.tags.length >= this.maxTags;
  }
  add(source: TagSource, key: string, field: TagField, raw: string): void {
    if (this.full) return;
    // eslint-disable-next-line no-control-regex
    const value = raw.replace(/\u0000+$/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
    if (!value) return;
    const v = value.length > this.maxLen ? `${value.slice(0, this.maxLen)}…` : value;
    if (this.tags.some((t) => t.source === source && t.key === key && t.value === v)) return;
    this.tags.push({ source, key, field, value: v });
  }
  warn(msg: string): void {
    if (this.warnings.length < 20 && !this.warnings.includes(msg)) this.warnings.push(msg);
  }
}

function u8(b: Uint8Array, o: number): number {
  return o >= 0 && o < b.length ? b[o] : 0;
}
function be16(b: Uint8Array, o: number): number {
  return (u8(b, o) << 8) | u8(b, o + 1);
}
function be24(b: Uint8Array, o: number): number {
  return (u8(b, o) << 16) | (u8(b, o + 1) << 8) | u8(b, o + 2);
}
function be32(b: Uint8Array, o: number): number {
  return ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;
}
function le32(b: Uint8Array, o: number): number {
  return (u8(b, o) | (u8(b, o + 1) << 8) | (u8(b, o + 2) << 16) | (u8(b, o + 3) << 24)) >>> 0;
}
function syncsafe32(b: Uint8Array, o: number): number {
  return ((u8(b, o) & 0x7f) << 21) | ((u8(b, o + 1) & 0x7f) << 14) | ((u8(b, o + 2) & 0x7f) << 7) | (u8(b, o + 3) & 0x7f);
}
function ascii(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
}
function slice(b: Uint8Array, start: number, end: number): Uint8Array {
  const s = Math.max(0, Math.min(b.length, start));
  return b.subarray(s, Math.max(s, Math.min(b.length, end)));
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
function utf8(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(b);
  } catch {
    return latin1(b);
  }
}
function utf16(b: Uint8Array, bigEndian: boolean | undefined): string {
  let o = 0;
  let be = bigEndian;
  if (be === undefined) {
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      be = true;
      o = 2;
    } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
      be = false;
      o = 2;
    } else be = false;
  }
  let s = '';
  for (; o + 1 < b.length; o += 2) s += String.fromCharCode(be ? (b[o] << 8) | b[o + 1] : b[o] | (b[o + 1] << 8));
  return s;
}

/** Decode ID3 text with the given encoding byte (0 Latin-1, 1 UTF-16+BOM, 2 UTF-16BE, 3 UTF-8). */
function id3Text(enc: number, b: Uint8Array): string {
  switch (enc) {
    case 1:
      return utf16(b, undefined);
    case 2:
      return utf16(b, true);
    case 3:
      return utf8(b);
    default:
      return latin1(b);
  }
}

/** Split at the encoding's NUL terminator: [first, rest]. */
function id3SplitTerminated(enc: number, b: Uint8Array): [Uint8Array, Uint8Array] {
  if (enc === 1 || enc === 2) {
    for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [b.subarray(0, i), b.subarray(i + 2)];
    return [b, new Uint8Array(0)];
  }
  const i = b.indexOf(0);
  return i < 0 ? [b, new Uint8Array(0)] : [b.subarray(0, i), b.subarray(i + 1)];
}

// ---------------------------------------------------------------------------------------------
// ID3v2
// ---------------------------------------------------------------------------------------------

const ID3_TEXT_FIELDS: Record<string, TagField> = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TPE2: 'artist',
  TP2: 'artist',
  TALB: 'album',
  TAL: 'album',
  TCOP: 'copyright',
  TCR: 'copyright',
  TPUB: 'publisher',
  TPB: 'publisher',
  TSRC: 'isrc',
  TRC: 'isrc',
  TOWN: 'owner',
  TPRO: 'copyright', // produced notice (℗), ID3v2.4
};
const ID3_URL_FIELDS: Record<string, TagField> = {
  WCOM: 'purchase',
  WCM: 'purchase',
  WPAY: 'purchase',
  WCOP: 'copyright',
  WCP: 'copyright',
  WPUB: 'publisher',
  WPB: 'publisher',
  WOAF: 'url',
  WAF: 'url',
};

/** TXXX / COMM descriptions that carry rights information. */
function describedField(description: string): TagField {
  const d = description.trim().toUpperCase();
  if (d === 'ISRC') return 'isrc';
  if (d === 'LABEL' || d === 'PUBLISHER' || d === 'ORGANIZATION' || d === 'RECORD LABEL' || d === 'LABELNO' || d === 'CATALOGNUMBER') return 'publisher';
  if (d === 'COPYRIGHT' || d === 'LICENSE' || d === 'LICENCE') return 'copyright';
  if (/AMAZON|ITUNES|PURCHASE|STORE|BEATPORT|BANDCAMP|7DIGITAL|QOBUZ/.test(d)) return 'purchase';
  if (d === 'ARTIST' || d === 'ALBUMARTIST' || d === 'ALBUM ARTIST') return 'artist';
  return 'other';
}

function unsynchronise(b: Uint8Array): Uint8Array {
  // Remove the 0x00 inserted after every 0xFF.
  let n = 0;
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && i + 1 < b.length && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/** Total size of the ID3v2 tag at `offset` (header + body + footer), or 0 when there is none. */
export function id3v2Size(b: Uint8Array, offset = 0): number {
  if (ascii(b, offset, 3) !== 'ID3') return 0;
  const flags = u8(b, offset + 5);
  return 10 + syncsafe32(b, offset + 6) + (flags & 0x10 ? 10 : 0);
}

function readId3v2(b: Uint8Array, offset: number, c: Collector): number {
  if (ascii(b, offset, 3) !== 'ID3' || b.length - offset < 10) return 0;
  const major = u8(b, offset + 3);
  const flags = u8(b, offset + 5);
  const size = syncsafe32(b, offset + 6);
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  if (major < 2 || major > 4) {
    c.warn(`Unsupported ID3v2.${major} tag skipped.`);
    return total;
  }
  if (offset + 10 + size > b.length) c.warn('ID3v2 tag is truncated.');
  let body = slice(b, offset + 10, offset + 10 + size);
  if (flags & 0x80 && major < 4) body = unsynchronise(body);
  let p = 0;
  if (flags & 0x40 && major >= 3) {
    // Extended header (v2.3: size excludes itself; v2.4: syncsafe and includes itself).
    const ext = major === 3 ? be32(body, 0) + 4 : syncsafe32(body, 0);
    if (ext > body.length || ext < 4) {
      c.warn('ID3v2 extended header has an invalid size.');
      return total;
    }
    p = ext;
  }
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  for (let frames = 0; frames < MAX_ID3_FRAMES && p + headLen <= body.length && !c.full; frames++) {
    const id = ascii(body, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding or garbage
    let fsize = major === 2 ? be24(body, p + 3) : major === 4 ? syncsafe32(body, p + 4) : be32(body, p + 4);
    // Some v2.4 writers use plain 32-bit sizes: fall back when the syncsafe size does not land on a frame.
    if (major === 4 && fsize > 0x7f) {
      const plain = be32(body, p + 4);
      const nextSync = p + headLen + fsize;
      const nextPlain = p + headLen + plain;
      const looksFrame = (q: number) => q === body.length || (q + 4 <= body.length && /^([A-Z0-9]{4}|\u0000{4})$/.test(ascii(body, q, 4)));
      if (!looksFrame(nextSync) && looksFrame(nextPlain)) fsize = plain;
    }
    const fflags = major === 2 ? 0 : be16(body, p + 8);
    const start = p + headLen;
    const end = start + fsize;
    if (fsize <= 0) {
      p = end;
      if (fsize === 0) continue;
      break;
    }
    if (end > body.length) c.warn(`ID3v2 frame ${id} is truncated.`);
    let data = slice(body, start, end);
    if (major === 4) {
      if (fflags & 0x0008 || fflags & 0x0004) {
        p = end; // compressed/encrypted — skip
        continue;
      }
      if (fflags & 0x0002 || flags & 0x80) data = unsynchronise(data);
      if (fflags & 0x0001) data = data.subarray(4); // data length indicator
    } else if (major === 3 && fflags & 0x00c0) {
      p = end; // compressed/encrypted
      continue;
    }
    readId3Frame(id, data, c);
    p = end;
  }
  return total;
}

function readId3Frame(id: string, data: Uint8Array, c: Collector): void {
  if (!data.length) return;
  if (id === 'TXXX' || id === 'TXX') {
    const enc = data[0];
    const [desc, rest] = id3SplitTerminated(enc, data.subarray(1));
    const description = id3Text(enc, desc);
    const value = id3Text(enc, rest);
    c.add('id3v2', `${id}:${description}`, describedField(description), value);
    return;
  }
  if (id === 'COMM' || id === 'COM') {
    const enc = data[0];
    const [desc, rest] = id3SplitTerminated(enc, data.subarray(4));
    const description = id3Text(enc, desc);
    const value = id3Text(enc, rest);
    const field = describedField(description);
    c.add('id3v2', description ? `${id}:${description}` : id, field === 'other' ? (/amazon\.com song id|purchased|itunes/i.test(`${description} ${value}`) ? 'purchase' : 'comment') : field, value);
    return;
  }
  if (id === 'WXXX' || id === 'WXX') {
    const enc = data[0];
    const [desc, rest] = id3SplitTerminated(enc, data.subarray(1));
    c.add('id3v2', `${id}:${id3Text(enc, desc)}`, 'url', latin1(rest));
    return;
  }
  if (ID3_TEXT_FIELDS[id]) {
    // Multiple values (v2.4) are NUL-separated.
    const text = id3Text(data[0], data.subarray(1));
    for (const v of text.split('\u0000').filter((x) => x.trim()).slice(0, 8)) c.add('id3v2', id, ID3_TEXT_FIELDS[id], v);
    return;
  }
  if (ID3_URL_FIELDS[id]) {
    c.add('id3v2', id, ID3_URL_FIELDS[id], latin1(id3SplitTerminated(0, data)[0]));
    return;
  }
  if (id === 'OWNE') {
    // Ownership: encoding, price paid (latin1, NUL), date of purchase (8 chars), seller.
    const enc = data[0];
    const [price, rest] = id3SplitTerminated(0, data.subarray(1));
    const date = latin1(rest.subarray(0, 8));
    const seller = id3Text(enc, rest.subarray(8));
    c.add('id3v2', id, 'purchase', [seller && `seller ${seller}`, latin1(price) && `price ${latin1(price)}`, date && `purchased ${date}`].filter(Boolean).join(', ') || 'ownership frame');
    return;
  }
  if (id === 'COMR') {
    const [price] = id3SplitTerminated(0, data.subarray(1));
    c.add('id3v2', id, 'purchase', `commercial frame${price.length ? ` (price ${latin1(price)})` : ''}`);
    return;
  }
  if (id === 'USER') {
    c.add('id3v2', id, 'copyright', id3Text(data[0], data.subarray(4)));
    return;
  }
  if (id === 'PRIV') {
    const [owner] = id3SplitTerminated(0, data);
    const o = latin1(owner);
    if (/amazon|itunes|apple|7digital|beatport|spotify|google|napster|emusic|bandcamp|qobuz/i.test(o)) c.add('id3v2', `PRIV:${o}`, 'purchase', o);
  }
}

// ---------------------------------------------------------------------------------------------
// ID3v1
// ---------------------------------------------------------------------------------------------

function readId3v1(b: Uint8Array, c: Collector): boolean {
  if (b.length < 128) return false;
  const o = b.length - 128;
  if (ascii(b, o, 3) !== 'TAG') return false;
  const field = (off: number, n: number) => latin1(slice(b, o + off, o + off + n)).replace(/\u0000.*$/s, '');
  c.add('id3v1', 'title', 'title', field(3, 30));
  c.add('id3v1', 'artist', 'artist', field(33, 30));
  c.add('id3v1', 'album', 'album', field(63, 30));
  c.add('id3v1', 'comment', 'comment', field(97, 30));
  return true;
}

// ---------------------------------------------------------------------------------------------
// RIFF / WAVE
// ---------------------------------------------------------------------------------------------

const RIFF_INFO_FIELDS: Record<string, TagField> = {
  ICOP: 'copyright',
  IART: 'artist',
  INAM: 'title',
  IPRD: 'album',
  ICMT: 'comment',
  IPUB: 'publisher', // non-standard but common
  ILBL: 'publisher',
  ICMS: 'other', // commissioned by
  IENG: 'other',
  ITCH: 'other',
  ISFT: 'other',
  IGNR: 'other',
  ICRD: 'other',
  ISRC: 'other', // RIFF "source" (supplier name) — an ISRC only when it looks like one (see classify)
  ISRF: 'other',
};

function readRiff(b: Uint8Array, c: Collector): void {
  const riffEnd = Math.min(b.length, 8 + le32(b, 4));
  if (riffEnd > b.length || le32(b, 4) + 8 > b.length) c.warn('RIFF file is truncated.');
  let p = 12;
  for (let n = 0; n < MAX_RIFF_CHUNKS && p + 8 <= b.length; n++) {
    const id = ascii(b, p, 4);
    const size = le32(b, p + 4);
    const start = p + 8;
    const end = start + size;
    if (end > b.length) c.warn(`RIFF chunk "${id.trim()}" is truncated.`);
    if (id === 'LIST' && ascii(b, start, 4) === 'INFO') readRiffInfo(slice(b, start + 4, end), c);
    else if (id === 'id3 ' || id === 'ID3 ') readId3v2(slice(b, start, end), 0, c);
    if (size > b.length) break;
    p = end + (size & 1);
  }
}

function readRiffInfo(b: Uint8Array, c: Collector): void {
  let p = 0;
  for (let n = 0; n < MAX_RIFF_CHUNKS && p + 8 <= b.length && !c.full; n++) {
    const id = ascii(b, p, 4);
    const size = le32(b, p + 4);
    const data = slice(b, p + 8, p + 8 + size);
    if (/^[A-Z0-9 ]{4}$/.test(id)) {
      const text = utf8(data).replace(/\u0000.*$/s, '');
      c.add('riff-info', id, RIFF_INFO_FIELDS[id] ?? 'other', text);
    }
    if (size > b.length) break;
    p += 8 + size + (size & 1);
  }
}

// ---------------------------------------------------------------------------------------------
// Vorbis comments (FLAC, Ogg)
// ---------------------------------------------------------------------------------------------

const VORBIS_FIELDS: Record<string, TagField> = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUMARTIST: 'artist',
  'ALBUM ARTIST': 'artist',
  PERFORMER: 'artist',
  ALBUM: 'album',
  COPYRIGHT: 'copyright',
  LICENSE: 'copyright',
  LICENCE: 'copyright',
  ISRC: 'isrc',
  LABEL: 'publisher',
  ORGANIZATION: 'publisher',
  ORGANISATION: 'publisher',
  PUBLISHER: 'publisher',
  LABELNO: 'publisher',
  CATALOGNUMBER: 'publisher',
  COMMENT: 'comment',
  DESCRIPTION: 'comment',
  CONTACT: 'url',
};

function readVorbisComment(b: Uint8Array, c: Collector): void {
  let p = 0;
  const vendorLen = le32(b, p);
  p += 4 + vendorLen;
  if (p + 4 > b.length) {
    if (vendorLen > b.length) c.warn('Vorbis comment block is truncated.');
    return;
  }
  const count = le32(b, p);
  p += 4;
  for (let i = 0; i < Math.min(count, MAX_VORBIS_COMMENTS) && p + 4 <= b.length && !c.full; i++) {
    const len = le32(b, p);
    p += 4;
    if (p + len > b.length) {
      c.warn('Vorbis comment is truncated.');
      if (len > b.length) break;
    }
    const s = utf8(slice(b, p, p + len));
    p += len;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).toUpperCase();
    if (key === 'METADATA_BLOCK_PICTURE' || key === 'COVERART') continue;
    let field = VORBIS_FIELDS[key] ?? 'other';
    if (field === 'other' && /PURCHASE|ITUNES|AMAZON|STORE/.test(key)) field = 'purchase';
    c.add('vorbis', key, field, s.slice(eq + 1));
  }
}

function readFlac(b: Uint8Array, offset: number, c: Collector): void {
  let p = offset + 4;
  for (let n = 0; n < MAX_FLAC_BLOCKS && p + 4 <= b.length; n++) {
    const header = b[p];
    const type = header & 0x7f;
    const len = be24(b, p + 1);
    const start = p + 4;
    if (start + len > b.length) c.warn('FLAC metadata block is truncated.');
    if (type === 4) readVorbisComment(slice(b, start, start + len), c);
    if (header & 0x80) return; // last metadata block
    p = start + len;
  }
}

function readOgg(b: Uint8Array, c: Collector): void {
  // Reassemble the first packets of the first logical stream (header packets carry the comments).
  let p = 0;
  let serial: number | undefined;
  const packets: Uint8Array[] = [];
  const parts: Uint8Array[] = [];
  let partBytes = 0;
  for (let pages = 0; pages < MAX_OGG_PAGES && p + 27 <= b.length && packets.length < 3; pages++) {
    if (ascii(b, p, 4) !== 'OggS') {
      c.warn('Ogg page sync lost.');
      break;
    }
    const pageSerial = le32(b, p + 14);
    const nseg = b[p + 26];
    const lacing = slice(b, p + 27, p + 27 + nseg);
    let q = p + 27 + nseg;
    const pageEnd = q + lacing.reduce((a, x) => a + x, 0);
    if (pageEnd > b.length) c.warn('Ogg page is truncated.');
    if (serial === undefined) serial = pageSerial;
    if (pageSerial === serial) {
      for (let i = 0; i < lacing.length; i++) {
        const seg = slice(b, q, q + lacing[i]);
        q += lacing[i];
        if (partBytes + seg.length <= MAX_OGG_PACKET_BYTES) {
          parts.push(seg);
          partBytes += seg.length;
        }
        if (lacing[i] < 255) {
          const out = new Uint8Array(partBytes);
          let o = 0;
          for (const s of parts) {
            out.set(s, o);
            o += s.length;
          }
          packets.push(out);
          parts.length = 0;
          partBytes = 0;
          if (packets.length >= 3) break;
        }
      }
    }
    p = pageEnd;
  }
  for (const pk of packets) {
    if (pk[0] === 3 && ascii(pk, 1, 6) === 'vorbis') return readVorbisComment(pk.subarray(7), c);
    if (ascii(pk, 0, 8) === 'OpusTags') return readVorbisComment(pk.subarray(8), c);
    if (pk[0] === 0x7f && ascii(pk, 1, 4) === 'FLAC') {
      // FLAC-in-Ogg: first packet is the mapping header + STREAMINFO; later packets are metadata blocks.
      continue;
    }
    if ((pk[0] & 0x7f) === 4 && pk.length >= 4) return readVorbisComment(pk.subarray(4), c);
  }
}

// ---------------------------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------------------------

const MP4_FIELDS: Record<string, TagField> = {
  '©nam': 'title',
  '©ART': 'artist',
  aART: 'artist',
  '©alb': 'album',
  cprt: 'copyright',
  '©cpy': 'copyright',
  '©pub': 'publisher',
  '©lab': 'publisher',
  '©cmt': 'comment',
  apID: 'purchase',
  purd: 'purchase',
  cnID: 'purchase',
  atID: 'purchase',
  plID: 'purchase',
  sfID: 'purchase',
  xid: 'purchase',
  ownr: 'owner',
};
/** Store atoms whose value is personal (account e-mail, owner name): record presence only. */
const MP4_PERSONAL = new Set(['apID', 'ownr']);
const MP4_STORE_LABEL: Record<string, string> = {
  apID: 'iTunes Store account (apID) present',
  ownr: 'Owner name (ownr) present',
};

interface AtomWalk {
  count: number;
}

function mp4Name(b: Uint8Array, o: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(u8(b, o + i));
  return s.replace(/©/g, '©');
}

function walkAtoms(b: Uint8Array, start: number, end: number, depth: number, w: AtomWalk, c: Collector, visit: (name: string, dataStart: number, dataEnd: number, depth: number) => void): void {
  let p = start;
  while (p + 8 <= end && w.count++ < MAX_ATOMS && depth < 12) {
    let size = be32(b, p);
    const name = mp4Name(b, p + 4);
    let header = 8;
    if (size === 1) {
      const hi = be32(b, p + 8);
      const lo = be32(b, p + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header) {
      c.warn(`MP4 atom "${name}" has an invalid size.`);
      return;
    }
    const atomEnd = p + size;
    if (atomEnd > end) c.warn(`MP4 atom "${name}" is truncated.`);
    visit(name, p + header, Math.min(atomEnd, end), depth);
    if (!Number.isFinite(atomEnd) || atomEnd <= p) return;
    p = atomEnd;
  }
}

function mp4DataValue(b: Uint8Array, start: number, end: number, key: string): string | null {
  // `data` atom: 1 byte version, 3 bytes type, 4 bytes locale, payload.
  const type = be24(b, start + 1);
  const payload = slice(b, start + 8, end);
  if (MP4_PERSONAL.has(key)) return MP4_STORE_LABEL[key] ?? `${key} present`;
  if (type === 1) return utf8(payload);
  if (type === 2) return utf16(payload, true);
  if (type === 21 || type === 22 || type === 0) {
    // Big-endian integer (store ids).
    if (payload.length === 0 || payload.length > 8) return type === 0 ? latin1(payload).replace(/[^\x20-\x7e]/g, '') || null : null;
    let v = 0;
    for (const x of payload) v = v * 256 + x;
    return String(v);
  }
  return null;
}

function readMp4(b: Uint8Array, c: Collector): void {
  const w: AtomWalk = { count: 0 };
  const visit = (name: string, s: number, e: number, depth: number): void => {
    if (c.full) return;
    if (name === 'moov' || name === 'udta' || name === 'ilst' || name === 'trak') {
      if (name === 'ilst') readIlst(s, e);
      else walkAtoms(b, s, e, depth + 1, w, c, visit);
      return;
    }
    if (name === 'meta') {
      // `meta` is a full box (4 bytes version/flags) in ISO files; QuickTime writes it without.
      const off = ascii(b, s + 4, 4) === 'hdlr' ? 0 : 4;
      walkAtoms(b, s + off, e, depth + 1, w, c, visit);
      return;
    }
    if (name === 'cprt' && depth >= 1) {
      // 3GPP copyright box in udta: full box + 2-byte language + UTF-8/16 string.
      if (e - s > 6) c.add('mp4', 'cprt', 'copyright', utf8(slice(b, s + 6, e)));
    }
  };
  const readIlst = (s: number, e: number) => {
    walkAtoms(b, s, e, 0, w, c, (item, is, ie) => {
      if (item === '----') {
        let mean = '';
        let nm = '';
        walkAtoms(b, is, ie, 0, w, c, (sub, ss, se) => {
          if (sub === 'mean') mean = utf8(slice(b, ss + 4, se));
          else if (sub === 'name') nm = utf8(slice(b, ss + 4, se));
          else if (sub === 'data') {
            const key = `----:${mean}:${nm}`;
            const value = mp4DataValue(b, ss, se, nm);
            if (value !== null) c.add('mp4', key, describedField(nm), value);
          }
        });
        return;
      }
      walkAtoms(b, is, ie, 0, w, c, (sub, ss, se) => {
        if (sub !== 'data') return;
        const value = mp4DataValue(b, ss, se, item);
        if (value !== null) c.add('mp4', item, MP4_FIELDS[item] ?? 'other', value);
      });
    });
  };
  walkAtoms(b, 0, b.length, 0, w, c, visit);
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

function sniff(b: Uint8Array): { container: MetadataContainer; offset: number } {
  const id3 = id3v2Size(b, 0);
  const after = id3 > 0 ? Math.min(id3, b.length) : 0;
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { container: 'wav', offset: 0 };
  if (ascii(b, after, 4) === 'fLaC') return { container: 'flac', offset: after };
  if (ascii(b, 0, 4) === 'OggS') return { container: 'ogg', offset: 0 };
  if (ascii(b, 4, 4) === 'ftyp') return { container: 'mp4', offset: 0 };
  if (id3 > 0) return { container: 'mp3', offset: 0 };
  // MPEG audio frame sync
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { container: 'mp3', offset: 0 };
  return { container: 'unknown', offset: 0 };
}

/** Read embedded tags of an audio file. Never throws. */
export function readAudioMetadata(bytes: Uint8Array, opts: MetadataReadOptions = {}): AudioFileMetadata {
  const c = new Collector(opts.maxTags ?? 200, opts.maxValueLength ?? 500);
  let container: MetadataContainer = 'unknown';
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
    const s = sniff(b);
    container = s.container;
    if (id3v2Size(b, 0) > 0) readId3v2(b, 0, c);
    switch (container) {
      case 'wav':
        readRiff(b, c);
        break;
      case 'flac':
        readFlac(b, s.offset, c);
        break;
      case 'ogg':
        readOgg(b, c);
        break;
      case 'mp4':
        readMp4(b, c);
        break;
      default:
        break;
    }
    if (container === 'mp3' || container === 'unknown' || container === 'flac') readId3v1(b, c);
  } catch (err) {
    c.warn(`Metadata could not be read completely: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { container, tags: c.tags, warnings: c.warnings };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export type RightsSignalKind = 'isrc' | 'copyright' | 'label' | 'purchase' | 'artist' | 'title' | 'album';

export interface RightsSignal {
  kind: RightsSignalKind;
  /** Human label, e.g. "ISRC", "Copyright notice", "Label / publisher", "Store purchase marker". */
  label: string;
  value: string;
  /** Tag the value came from, e.g. "ID3 TSRC", "RIFF ICOP". */
  source: string;
}

export interface RightsClassification {
  /** likely-commercial: ISRC / copyright / label / purchase markers. hint: artist/title only. */
  level: 'none' | 'hint' | 'likely-commercial';
  signals: RightsSignal[];
  /** One sentence for the attestation dialog ('' when level is none). */
  summary: string;
}

const ISRC_RE = /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/;

/** Normalize an ISRC ("US-RC1-76-07839" → "USRC17607839"), or null when it is not one. */
export function normalizeIsrc(value: string): string | null {
  const v = value.trim().toUpperCase().replace(/\s+/g, '');
  return ISRC_RE.test(v) ? v.replace(/-/g, '') : null;
}

const SOURCE_LABEL: Record<TagSource, string> = { id3v2: 'ID3', id3v1: 'ID3v1', 'riff-info': 'RIFF', vorbis: 'Vorbis comment', mp4: 'MP4' };
const KIND_LABEL: Record<RightsSignalKind, string> = {
  isrc: 'ISRC',
  copyright: 'Copyright notice',
  label: 'Label / publisher',
  purchase: 'Store purchase marker',
  artist: 'Artist',
  title: 'Title',
  album: 'Album',
};
const STRONG: RightsSignalKind[] = ['isrc', 'copyright', 'label', 'purchase'];

function tagKind(t: AudioTag): RightsSignalKind | null {
  switch (t.field) {
    case 'isrc':
      return normalizeIsrc(t.value) ? 'isrc' : null;
    case 'copyright':
      return 'copyright';
    case 'publisher':
      return 'label';
    case 'purchase':
    case 'owner':
      return 'purchase';
    case 'artist':
      return 'artist';
    case 'title':
      return 'title';
    case 'album':
      return 'album';
    case 'url':
      return /itunes\.apple|music\.apple|amazon\.|beatport|bandcamp|7digital|qobuz|spotify/i.test(t.value) ? 'purchase' : null;
    default:
      // Any tag whose value is a well-formed ISRC counts (e.g. RIFF ISRC, comments).
      return t.key === 'ISRC' && normalizeIsrc(t.value) ? 'isrc' : null;
  }
}

/** Turn tags into warn-only rights signals. */
export function classifyRightsSignals(meta: Pick<AudioFileMetadata, 'tags'>): RightsClassification {
  const signals: RightsSignal[] = [];
  for (const t of meta.tags) {
    const kind = tagKind(t);
    if (!kind) continue;
    const value = kind === 'isrc' ? normalizeIsrc(t.value)! : t.value;
    if (signals.some((s) => s.kind === kind && s.value.toLowerCase() === value.toLowerCase())) continue;
    signals.push({ kind, label: KIND_LABEL[kind], value, source: `${SOURCE_LABEL[t.source]} ${t.key}` });
  }
  const order: RightsSignalKind[] = ['isrc', 'copyright', 'label', 'purchase', 'artist', 'title', 'album'];
  signals.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const strong = signals.filter((s) => STRONG.includes(s.kind));
  const level: RightsClassification['level'] = strong.length ? 'likely-commercial' : signals.length ? 'hint' : 'none';
  return { level, signals, summary: summarizeSignals(level, signals) };
}

function quote(v: string, max = 80): string {
  const s = v.length > max ? `${v.slice(0, max)}…` : v;
  return `“${s}”`;
}

function summarizeSignals(level: RightsClassification['level'], signals: RightsSignal[]): string {
  if (level === 'none') return '';
  const parts: string[] = [];
  for (const s of signals) {
    if (level === 'likely-commercial' && !STRONG.includes(s.kind)) continue;
    if (s.kind === 'isrc') parts.push(`ISRC ${s.value}`);
    else if (s.kind === 'copyright') parts.push(quote(s.value));
    else if (s.kind === 'label') parts.push(`label/publisher ${quote(s.value)}`);
    else if (s.kind === 'purchase') parts.push(`a store purchase marker (${s.source}: ${s.value.length > 60 ? `${s.value.slice(0, 60)}…` : s.value})`);
    else parts.push(`${s.label.toLowerCase()} ${quote(s.value)}`);
    if (parts.length >= 4) break;
  }
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return level === 'likely-commercial'
    ? `This file carries ${list} — it looks like a commercial release.`
    : `This file is tagged with ${list}. That alone does not mean it is a commercial release.`;
}
