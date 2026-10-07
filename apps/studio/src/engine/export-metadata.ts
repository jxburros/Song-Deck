import type { ExportMetadata, Song } from '@songdeck/core';
import type { AudioFormat } from './export-audio';

const utf8 = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
const u32 = (n: number, little = true) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, little);
  return out;
};
const syncsafe = (n: number) =>
  new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);

export function metadataForSong(song: Song): ExportMetadata {
  return Object.fromEntries(
    Object.entries({ title: song.title, ...song.exportMetadata })
      .map(([k, v]) => [k, v?.trim()])
      .filter(([, v]) => v),
  );
}

/** Embed standard tags without re-encoding or changing any audio samples. */
export function tagAudio(bytes: Uint8Array, format: AudioFormat, tags: ExportMetadata): Uint8Array {
  const entries = Object.entries(tags).filter(([, v]) => v?.trim()) as [keyof ExportMetadata, string][];
  if (!entries.length) return bytes;
  if (format === 'wav') {
    const ids: Partial<Record<keyof ExportMetadata, string>> = {
      title: 'INAM',
      artist: 'IART',
      album: 'IPRD',
      composer: 'IMUS',
      genre: 'IGNR',
      date: 'ICRD',
      trackNumber: 'ITRK',
      copyright: 'ICOP',
      comment: 'ICMT',
      isrc: 'ISRC',
    };
    const chunks = entries.flatMap(([key, value]) => {
      const id = ids[key];
      if (!id) return [];
      const data = join(utf8(value), new Uint8Array(1));
      return [join(utf8(id), u32(data.length), data, new Uint8Array(data.length % 2))];
    });
    const info = join(utf8('INFO'), ...chunks);
    const preserved = [bytes.subarray(0, 12)];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const id = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
      const size = view.getUint32(offset + 4, true);
      const end = offset + 8 + size + (size & 1);
      if (end > bytes.length) throw new Error('Invalid WAV chunk');
      const isInfo =
        id === 'LIST' && new TextDecoder().decode(bytes.subarray(offset + 8, offset + 12)) === 'INFO';
      if (!isInfo && id.toLowerCase() !== 'id3 ') preserved.push(bytes.subarray(offset, end));
      offset = end;
    }
    const out = join(...preserved, utf8('LIST'), u32(info.length), info);
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    return out;
  }
  if (format === 'flac') {
    // Replace Vorbis comments, retaining STREAMINFO and all other metadata blocks.
    let offset = 4;
    const preserved: Uint8Array[] = [bytes.subarray(0, 4)];
    while (offset + 4 <= bytes.length) {
      const start = offset;
      const len = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      offset += 4 + len;
      if (offset > bytes.length) throw new Error('Invalid FLAC metadata');
      if ((bytes[start] & 127) !== 4) {
        const existing = bytes.slice(start, offset);
        existing[0] &= 127;
        preserved.push(existing);
      }
      if (bytes[start] & 128) break;
    }
    const names: Record<keyof ExportMetadata, string> = {
      title: 'TITLE',
      artist: 'ARTIST',
      album: 'ALBUM',
      composer: 'COMPOSER',
      genre: 'GENRE',
      date: 'DATE',
      trackNumber: 'TRACKNUMBER',
      copyright: 'COPYRIGHT',
      comment: 'DESCRIPTION',
      isrc: 'ISRC',
    };
    const vendor = utf8('Song Deck');
    const comments = entries.map(([key, value]) => utf8(`${names[key]}=${value}`));
    const block = join(
      u32(vendor.length),
      vendor,
      u32(comments.length),
      ...comments.flatMap((c) => [u32(c.length), c]),
    );
    if (block.length > 0xffffff) throw new Error('Export metadata is too large');
    const prefix = join(...preserved);
    return join(
      prefix,
      new Uint8Array([0x84, block.length >>> 16, block.length >>> 8, block.length]),
      block,
      bytes.subarray(offset),
    );
  }
  // ID3v2.4 UTF-8 tags for MP3 and ADTS AAC.
  const ids: Record<keyof ExportMetadata, string> = {
    title: 'TIT2',
    artist: 'TPE1',
    album: 'TALB',
    composer: 'TCOM',
    genre: 'TCON',
    date: 'TDRC',
    trackNumber: 'TRCK',
    copyright: 'TCOP',
    comment: 'COMM',
    isrc: 'TSRC',
  };
  const frames = entries.map(([key, value]) => {
    const data =
      key === 'comment'
        ? join(new Uint8Array([3]), utf8('eng'), new Uint8Array(1), utf8(value))
        : join(new Uint8Array([3]), utf8(value));
    return join(utf8(ids[key]), syncsafe(data.length), new Uint8Array(2), data);
  });
  const body = join(...frames);
  // Saved masters can already have an ID3 tag; replace it instead of stacking tags.
  const skip =
    bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51
      ? 10 +
        (((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127)) +
        (bytes[5] & 16 ? 10 : 0)
      : 0;
  return join(utf8('ID3'), new Uint8Array([4, 0, 0]), syncsafe(body.length), body, bytes.subarray(skip));
}
