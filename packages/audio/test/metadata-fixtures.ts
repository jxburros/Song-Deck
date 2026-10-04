/**
 * Hand-built tag fixtures for the metadata reader tests: every container is assembled here from
 * its specification, byte by byte (no third-party or copyrighted files).
 */
import { encodeWav } from '../src/dsp';

export const enc = (s: string) => new TextEncoder().encode(s);
export const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const be32 = (v: number) => Uint8Array.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const be24 = (v: number) => Uint8Array.from([(v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const le32 = (v: number) => Uint8Array.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
const syncsafe = (v: number) =>
  Uint8Array.from([(v >>> 21) & 127, (v >>> 14) & 127, (v >>> 7) & 127, v & 127]);

// --- ID3v2 ------------------------------------------------------------------------------------

export interface Id3Frame {
  id: string;
  /** Frame body (encoding byte included). */
  body: Uint8Array;
}

/** Text frame body: encoding byte + text (0 = Latin-1, 1 = UTF-16 with BOM, 3 = UTF-8). */
export function textBody(text: string, encoding: 0 | 1 | 3 = 3): Uint8Array {
  if (encoding === 1) {
    const u = new Uint8Array(2 + text.length * 2);
    u[0] = 0xff;
    u[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      u[2 + i * 2] = text.charCodeAt(i) & 255;
      u[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    return concat(Uint8Array.of(1), u);
  }
  return concat(Uint8Array.of(encoding), encoding === 0 ? latin1(text) : enc(text));
}

export function txxxBody(description: string, value: string): Uint8Array {
  return concat(Uint8Array.of(3), enc(description), Uint8Array.of(0), enc(value));
}

export function id3v2(version: 2 | 3 | 4, frames: Id3Frame[], padding = 16): Uint8Array {
  const parts = frames.map((f) => {
    if (version === 2) return concat(latin1(f.id), be24(f.body.length), f.body);
    const size = version === 4 ? syncsafe(f.body.length) : be32(f.body.length);
    return concat(latin1(f.id), size, Uint8Array.of(0, 0), f.body);
  });
  const body = concat(...parts, new Uint8Array(padding));
  return concat(latin1('ID3'), Uint8Array.of(version, 0, 0), syncsafe(body.length), body);
}

export function id3v1(title: string, artist: string, album: string, comment = ''): Uint8Array {
  const field = (s: string, n: number) => {
    const b = new Uint8Array(n);
    b.set(latin1(s).subarray(0, n));
    return b;
  };
  return concat(
    latin1('TAG'),
    field(title, 30),
    field(artist, 30),
    field(album, 30),
    field('2019', 4),
    field(comment, 30),
    Uint8Array.of(12),
  );
}

/** A few bytes that look like an MPEG audio frame (sync word), standing in for MP3 audio. */
export const FAKE_MPEG = Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0);

// --- RIFF / WAV ---------------------------------------------------------------------------------

export function riffInfo(entries: [string, string][]): Uint8Array {
  const subs = entries.map(([id, value]) => {
    const data = concat(enc(value), Uint8Array.of(0));
    const pad = data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0);
    return concat(latin1(id), le32(data.length), data, pad);
  });
  const body = concat(latin1('INFO'), ...subs);
  return concat(latin1('LIST'), le32(body.length), body);
}

/** A short silent WAV with extra chunks appended after `data` (RIFF size fixed up). */
export function wavWithChunks(chunks: Uint8Array[], frames = 64, sampleRate = 8000): Uint8Array {
  const base = encodeWav(
    { sampleRate, channels: [new Float32Array(frames)] },
    { bitDepth: 16, dither: false },
  );
  const out = concat(base, ...chunks);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

export function riffChunk(id: string, data: Uint8Array): Uint8Array {
  return concat(latin1(id), le32(data.length), data, data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0));
}

// --- Vorbis comments / FLAC / Ogg -------------------------------------------------------------

export function vorbisComment(comments: string[], vendor = 'songdeck-test'): Uint8Array {
  const v = enc(vendor);
  return concat(
    le32(v.length),
    v,
    le32(comments.length),
    ...comments.map((c) => concat(le32(enc(c).length), enc(c))),
  );
}

export function flacFile(comments: string[]): Uint8Array {
  const streaminfo = new Uint8Array(34);
  const vc = vorbisComment(comments);
  return concat(
    latin1('fLaC'),
    Uint8Array.of(0),
    be24(34),
    streaminfo,
    Uint8Array.of(0x80 | 4),
    be24(vc.length),
    vc,
    Uint8Array.of(0xff, 0xf8, 0, 0),
  );
}

/** One Ogg page holding the given packets (CRC left zero — the reader does not verify it). */
export function oggPage(packets: Uint8Array[], serial = 0x1234, seq = 0, headerType = 0): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const header = concat(
    latin1('OggS'),
    Uint8Array.of(0, headerType),
    new Uint8Array(8),
    le32(serial),
    le32(seq),
    le32(0),
    Uint8Array.of(lacing.length),
    Uint8Array.from(lacing),
  );
  return concat(header, ...packets);
}

export function oggVorbisFile(comments: string[]): Uint8Array {
  const ident = concat(Uint8Array.of(1), latin1('vorbis'), new Uint8Array(23));
  const comment = concat(Uint8Array.of(3), latin1('vorbis'), vorbisComment(comments), Uint8Array.of(1));
  return concat(oggPage([ident], 0x1234, 0, 2), oggPage([comment], 0x1234, 1));
}

export function oggOpusFile(comments: string[]): Uint8Array {
  const head = concat(latin1('OpusHead'), new Uint8Array(11));
  const tags = concat(latin1('OpusTags'), vorbisComment(comments));
  return concat(oggPage([head], 7, 0, 2), oggPage([tags], 7, 1));
}

// --- MP4 ---------------------------------------------------------------------------------------

export function atom(name: string, ...children: Uint8Array[]): Uint8Array {
  const body = concat(...children);
  const n = latin1(name.replace(/©/g, '©'));
  return concat(be32(8 + body.length), n, body);
}

/** iTunes `data` atom: type 1 = UTF-8 text, 21 = big-endian integer. */
export function dataAtom(value: string | number): Uint8Array {
  if (typeof value === 'number')
    return atom('data', Uint8Array.of(0, 0, 0, 21), new Uint8Array(4), be32(value));
  return atom('data', Uint8Array.of(0, 0, 0, 1), new Uint8Array(4), enc(value));
}

export function mp4File(items: Uint8Array[]): Uint8Array {
  const hdlr = atom(
    'hdlr',
    new Uint8Array(4),
    new Uint8Array(4),
    latin1('mdir'),
    latin1('appl'),
    new Uint8Array(9),
  );
  const meta = atom('meta', new Uint8Array(4), hdlr, atom('ilst', ...items));
  return concat(
    atom('ftyp', latin1('M4A '), new Uint8Array(4), latin1('M4A mp42isom')),
    atom('mdat', new Uint8Array(16)),
    atom('moov', atom('mvhd', new Uint8Array(100)), atom('udta', meta)),
  );
}

export function freeform(mean: string, name: string, value: string): Uint8Array {
  return atom(
    '----',
    atom('mean', new Uint8Array(4), enc(mean)),
    atom('name', new Uint8Array(4), enc(name)),
    dataAtom(value),
  );
}
