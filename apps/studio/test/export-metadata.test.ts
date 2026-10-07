import { describe, expect, it } from 'vitest';
import { createEmptySong } from '@songdeck/core';
import { decodeWav, encodeWav, decodeFlac, encodeFlac, readAudioMetadata } from '@songdeck/audio';
import { metadataForSong, tagAudio } from '../src/engine/export-metadata';

const audio = {
  sampleRate: 44100,
  channels: [Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.3)],
};
const tags = {
  title: 'Café 🌙',
  artist: 'Zoë',
  album: 'Songs',
  copyright: '© 2026 Zoë',
  isrc: 'USAAA2600001',
  comment: 'Original recording',
  composer: 'Zoë',
  genre: 'Pop',
  date: '2026',
  trackNumber: '2',
};

describe('export metadata', () => {
  it('uses the song title, trims values and omits empty fields', () => {
    const song = createEmptySong({ title: 'My song' });
    song.exportMetadata = { artist: '  Zoë ', album: ' ' };
    expect(metadataForSong(song)).toEqual({ title: 'My song', artist: 'Zoë' });
  });
  for (const format of ['wav', 'flac'] as const)
    it(`embeds readable ${format} tags without changing samples`, () => {
      const encode = format === 'wav' ? encodeWav : encodeFlac;
      const decode = format === 'wav' ? decodeWav : decodeFlac;
      const original = encode(audio);
      const before = original.slice();
      const tagged = tagAudio(original, format, tags);
      const metadata = readAudioMetadata(tagged);
      for (const field of ['title', 'artist', 'album', 'copyright', 'isrc'] as const)
        expect(
          metadata.tags.some(
            (t) =>
              (t.field === field || (format === 'wav' && field === 'isrc' && t.key === 'ISRC')) &&
              t.value === tags[field],
          ),
        ).toBe(true);
      expect(decode(tagged).channels).toEqual(decode(original).channels);
      expect(original).toEqual(before);
      const retagged = tagAudio(tagged, format, { title: 'Updated title', artist: 'New artist' });
      expect(
        readAudioMetadata(retagged)
          .tags.filter((t) => t.field === 'artist')
          .map((t) => t.value),
      ).toEqual(['New artist']);
      expect(decode(retagged).channels).toEqual(decode(original).channels);
      if (format === 'wav') expect(new DataView(tagged.buffer).getUint32(4, true)).toBe(tagged.length - 8);
    });
  for (const format of ['mp3', 'aac'] as const)
    it(`writes UTF-8 ID3 tags and preserves the ${format} payload`, () => {
      const original = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 1, 2, 3]);
      const tagged = tagAudio(original, format, tags);
      const metadata = readAudioMetadata(tagged);
      expect(metadata.tags.find((t) => t.field === 'title')?.value).toBe(tags.title);
      expect(metadata.tags.find((t) => t.field === 'comment')?.value).toBe(tags.comment);
      expect(tagged.slice(-original.length)).toEqual(original);
      const retagged = tagAudio(tagged, format, { artist: 'New artist' });
      expect(
        readAudioMetadata(retagged)
          .tags.filter((t) => t.field === 'artist')
          .map((t) => t.value),
      ).toEqual(['New artist']);
      expect(retagged.slice(-original.length)).toEqual(original);
    });
});
