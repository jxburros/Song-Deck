import { describe, expect, it } from 'vitest';
import {
  classifyRightsSignals,
  decodeWav,
  normalizeIsrc,
  readAudioMetadata,
  type AudioFileMetadata,
} from '../src/dsp';
import {
  FAKE_MPEG,
  atom,
  concat,
  dataAtom,
  enc,
  flacFile,
  freeform,
  id3v1,
  id3v2,
  latin1,
  mp4File,
  oggOpusFile,
  oggVorbisFile,
  riffChunk,
  riffInfo,
  textBody,
  txxxBody,
  wavWithChunks,
} from './metadata-fixtures';

const value = (m: AudioFileMetadata, key: string) => m.tags.find((t) => t.key === key)?.value;
const field = (m: AudioFileMetadata, f: string) => m.tags.filter((t) => t.field === f).map((t) => t.value);

/** Every prefix and a few corrupted variants must parse without throwing. */
function fuzz(bytes: Uint8Array) {
  for (let n = 0; n <= bytes.length; n += Math.max(1, Math.floor(bytes.length / 300))) {
    expect(() => readAudioMetadata(bytes.subarray(0, n))).not.toThrow();
  }
  for (let i = 0; i < Math.min(bytes.length, 400); i += 3) {
    const c = bytes.slice();
    c[i] = 0xff;
    expect(() => readAudioMetadata(c)).not.toThrow();
    c[i] = 0x7f;
    expect(() => readAudioMetadata(c)).not.toThrow();
  }
}

describe('ID3', () => {
  const frames = [
    { id: 'TIT2', body: textBody('Night Drive') },
    { id: 'TPE1', body: textBody('The Examples', 1) },
    { id: 'TALB', body: textBody('Test Album', 0) },
    { id: 'TCOP', body: textBody('℗ 2019 Some Label') },
    { id: 'TPUB', body: textBody('Some Label Records') },
    { id: 'TSRC', body: textBody('USRC17607839') },
    { id: 'TXXX', body: txxxBody('CATALOGNUMBER', 'SL-0042') },
    { id: 'WCOM', body: latin1('https://store.example/buy/42') },
    { id: 'PRIV', body: concat(latin1('AmazonMP3'), Uint8Array.of(0), latin1('xyz')) },
  ];

  it.each([3, 4] as const)('reads ID3v2.%i text, TXXX, URL and PRIV frames', (v) => {
    const m = readAudioMetadata(concat(id3v2(v, frames), FAKE_MPEG));
    expect(m.container).toBe('mp3');
    expect(value(m, 'TIT2')).toBe('Night Drive');
    expect(value(m, 'TPE1')).toBe('The Examples');
    expect(value(m, 'TALB')).toBe('Test Album');
    expect(value(m, 'TCOP')).toBe('℗ 2019 Some Label');
    expect(value(m, 'TPUB')).toBe('Some Label Records');
    expect(value(m, 'TSRC')).toBe('USRC17607839');
    expect(value(m, 'TXXX:CATALOGNUMBER')).toBe('SL-0042');
    expect(value(m, 'WCOM')).toBe('https://store.example/buy/42');
    expect(field(m, 'purchase')).toContain('AmazonMP3');
    expect(m.warnings).toEqual([]);
  });

  it('reads ID3v2.2 three-character frames', () => {
    const m = readAudioMetadata(
      concat(
        id3v2(2, [
          { id: 'TT2', body: textBody('Old Tag', 0) },
          { id: 'TCR', body: textBody('(C) 2001 Example', 0) },
          { id: 'TRC', body: textBody('GBAYE0000001', 0) },
        ]),
        FAKE_MPEG,
      ),
    );
    expect(value(m, 'TT2')).toBe('Old Tag');
    expect(value(m, 'TCR')).toBe('(C) 2001 Example');
    expect(field(m, 'isrc')).toEqual(['GBAYE0000001']);
  });

  it('reads an ID3v1 trailer', () => {
    const m = readAudioMetadata(
      concat(
        FAKE_MPEG,
        new Uint8Array(200),
        id3v1('Trailer Song', 'Trailer Artist', 'Trailer Album', 'hello'),
      ),
    );
    expect(value(m, 'title')).toBe('Trailer Song');
    expect(value(m, 'artist')).toBe('Trailer Artist');
    expect(value(m, 'album')).toBe('Trailer Album');
    expect(m.tags.every((t) => t.source === 'id3v1')).toBe(true);
  });

  it('reads the ownership frame and v2.4 multi-value text', () => {
    const owne = concat(
      Uint8Array.of(0),
      latin1('USD0.99'),
      Uint8Array.of(0),
      latin1('20190301'),
      latin1('Example Store'),
    );
    const m = readAudioMetadata(
      concat(
        id3v2(4, [
          { id: 'OWNE', body: owne },
          { id: 'TPE1', body: textBody('A\u0000B') },
        ]),
        FAKE_MPEG,
      ),
    );
    expect(field(m, 'purchase')[0]).toContain('Example Store');
    expect(field(m, 'artist')).toEqual(['A', 'B']);
  });

  it('survives truncation, corruption and absurd sizes', () => {
    const file = concat(id3v2(3, frames), FAKE_MPEG, id3v1('a', 'b', 'c'));
    fuzz(file);
    const truncated = readAudioMetadata(file.subarray(0, 60));
    expect(truncated.warnings.join(' ')).toMatch(/truncated/);
    // A frame claiming 2 GB.
    const huge = concat(
      latin1('ID3'),
      Uint8Array.of(3, 0, 0, 0, 0, 1, 0),
      latin1('TIT2'),
      Uint8Array.of(0x7f, 0xff, 0xff, 0xff, 0, 0),
      textBody('x'),
    );
    expect(() => readAudioMetadata(huge)).not.toThrow();
  });
});

describe('RIFF INFO (WAV)', () => {
  it('reads ICOP, IART and INAM and still decodes as audio', () => {
    const wav = wavWithChunks([
      riffInfo([
        ['INAM', 'Field Recording'],
        ['IART', 'Jane Example'],
        ['ICOP', 'Copyright 2020 Example Records'],
      ]),
    ]);
    const m = readAudioMetadata(wav);
    expect(m.container).toBe('wav');
    expect(value(m, 'INAM')).toBe('Field Recording');
    expect(value(m, 'IART')).toBe('Jane Example');
    expect(value(m, 'ICOP')).toBe('Copyright 2020 Example Records');
    expect(decodeWav(wav).channels[0].length).toBe(64);
  });

  it('reads an id3 chunk inside a WAV', () => {
    const wav = wavWithChunks([
      riffChunk('id3 ', id3v2(3, [{ id: 'TSRC', body: textBody('USRC17607839') }])),
    ]);
    expect(field(readAudioMetadata(wav), 'isrc')).toEqual(['USRC17607839']);
  });

  it('does not mistake RIFF ISRC ("source") for a recording code unless it is one', () => {
    const plain = classifyRightsSignals(
      readAudioMetadata(wavWithChunks([riffInfo([['ISRC', 'Jane at home']])])),
    );
    expect(plain.level).toBe('none');
    const code = classifyRightsSignals(
      readAudioMetadata(wavWithChunks([riffInfo([['ISRC', 'US-RC1-76-07839']])])),
    );
    expect(code.signals[0]).toMatchObject({ kind: 'isrc', value: 'USRC17607839' });
  });

  it('survives truncation and corruption', () => {
    fuzz(
      wavWithChunks([
        riffInfo([
          ['ICOP', 'Copyright 2020 Example Records'],
          ['IART', 'Jane'],
        ]),
      ]),
    );
  });
});

describe('Vorbis comments', () => {
  const comments = [
    'TITLE=Open Song',
    'ARTIST=Free Band',
    'COPYRIGHT=2021 Free Band, CC BY 4.0',
    'ISRC=QZABC2100001',
    'LABEL=Indie Label',
    'ORGANIZATION=Indie Org',
    'METADATA_BLOCK_PICTURE=AAAA',
  ];

  it('reads FLAC VORBIS_COMMENT blocks', () => {
    const m = readAudioMetadata(flacFile(comments));
    expect(m.container).toBe('flac');
    expect(value(m, 'TITLE')).toBe('Open Song');
    expect(value(m, 'COPYRIGHT')).toBe('2021 Free Band, CC BY 4.0');
    expect(value(m, 'ISRC')).toBe('QZABC2100001');
    expect(field(m, 'publisher')).toEqual(['Indie Label', 'Indie Org']);
    expect(m.tags.some((t) => t.key === 'METADATA_BLOCK_PICTURE')).toBe(false);
  });

  it('reads FLAC preceded by an ID3v2 tag', () => {
    const m = readAudioMetadata(
      concat(id3v2(3, [{ id: 'TIT2', body: textBody('Tagged') }]), flacFile(['ARTIST=Both'])),
    );
    expect(m.container).toBe('flac');
    expect(value(m, 'TIT2')).toBe('Tagged');
    expect(value(m, 'ARTIST')).toBe('Both');
  });

  it('reads Ogg Vorbis and Ogg Opus comment packets', () => {
    expect(value(readAudioMetadata(oggVorbisFile(comments)), 'LABEL')).toBe('Indie Label');
    const opus = readAudioMetadata(oggOpusFile(['ARTIST=Opus Artist', 'COPYRIGHT=© Opus']));
    expect(opus.container).toBe('ogg');
    expect(value(opus, 'COPYRIGHT')).toBe('© Opus');
  });

  it('reassembles a comment packet that spans pages', () => {
    const long = `COMMENT=${'x'.repeat(700)}`;
    const ident = concat(Uint8Array.of(1), latin1('vorbis'), new Uint8Array(23));
    const packet = concat(
      Uint8Array.of(3),
      latin1('vorbis'),
      new TextEncoder().encode(''),
      (() => {
        const v = enc('v');
        const items = ['ISRC=USRC17607839', long].map((c) =>
          concat(Uint8Array.of(enc(c).length & 255, (enc(c).length >> 8) & 255, 0, 0), enc(c)),
        );
        return concat(Uint8Array.of(v.length, 0, 0, 0), v, Uint8Array.of(2, 0, 0, 0), ...items);
      })(),
    );
    // Split the packet over two pages: 255-byte segments on page 1 continue on page 2.
    const first = packet.subarray(0, 510);
    const rest = packet.subarray(510);
    const page = (body: Uint8Array, lacing: number[], seq: number) =>
      concat(
        latin1('OggS'),
        Uint8Array.of(0, seq ? 1 : 0),
        new Uint8Array(8),
        Uint8Array.of(9, 0, 0, 0),
        Uint8Array.of(seq, 0, 0, 0),
        new Uint8Array(4),
        Uint8Array.of(lacing.length),
        Uint8Array.from(lacing),
        body,
      );
    const restLacing: number[] = [];
    let n = rest.length;
    while (n >= 255) {
      restLacing.push(255);
      n -= 255;
    }
    restLacing.push(n);
    const file = concat(
      page(ident, [ident.length], 0),
      page(first, [255, 255], 1),
      page(rest, restLacing, 2),
    );
    const m = readAudioMetadata(file);
    expect(value(m, 'ISRC')).toBe('USRC17607839');
    expect(value(m, 'COMMENT')?.length).toBeGreaterThan(400);
  });

  it('survives truncation and corruption', () => {
    fuzz(flacFile(comments));
    fuzz(oggVorbisFile(comments));
    // Comment count claiming 4 billion entries.
    const bad = concat(
      latin1('fLaC'),
      Uint8Array.of(0x84, 0, 0, 12),
      Uint8Array.of(0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 5, 0, 0, 0),
    );
    expect(() => readAudioMetadata(bad)).not.toThrow();
  });
});

describe('MP4 / M4A', () => {
  const file = mp4File([
    atom('©nam', dataAtom('Store Song')),
    atom('©ART', dataAtom('Store Artist')),
    atom('cprt', dataAtom('℗ 2018 Big Label')),
    atom('apID', dataAtom('someone@example.com')),
    atom('purd', dataAtom('2018-05-01 10:00:00')),
    atom('cnID', dataAtom(123456789)),
    freeform('com.apple.iTunes', 'ISRC', 'GBUM71029604'),
    freeform('com.apple.iTunes', 'LABEL', 'Big Label'),
  ]);

  it('reads ilst text, store and freeform atoms', () => {
    const m = readAudioMetadata(file);
    expect(m.container).toBe('mp4');
    expect(value(m, '©nam')).toBe('Store Song');
    expect(value(m, '©ART')).toBe('Store Artist');
    expect(value(m, 'cprt')).toBe('℗ 2018 Big Label');
    expect(value(m, 'purd')).toBe('2018-05-01 10:00:00');
    expect(value(m, 'cnID')).toBe('123456789');
    expect(value(m, '----:com.apple.iTunes:ISRC')).toBe('GBUM71029604');
    expect(value(m, '----:com.apple.iTunes:LABEL')).toBe('Big Label');
  });

  it('never surfaces the purchaser’s account e-mail', () => {
    const m = readAudioMetadata(file);
    expect(JSON.stringify(m)).not.toContain('someone@example.com');
    expect(value(m, 'apID')).toMatch(/present/);
  });

  it('survives truncation, corruption, zero and 64-bit sizes', () => {
    fuzz(file);
    const zero = concat(
      atom('ftyp', latin1('M4A ')),
      Uint8Array.of(0, 0, 0, 0),
      latin1('moov'),
      atom('udta'),
    );
    expect(() => readAudioMetadata(zero)).not.toThrow();
    const big = concat(
      atom('ftyp', latin1('M4A ')),
      Uint8Array.of(0, 0, 0, 1),
      latin1('mdat'),
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    );
    expect(() => readAudioMetadata(big)).not.toThrow();
    const tiny = concat(atom('ftyp', latin1('M4A ')), Uint8Array.of(0, 0, 0, 3), latin1('moov'));
    expect(readAudioMetadata(tiny).warnings.join(' ')).toMatch(/invalid size/);
  });
});

describe('robustness', () => {
  it('returns an empty result for empty, random and non-audio input', () => {
    expect(readAudioMetadata(new Uint8Array(0))).toEqual({ container: 'unknown', tags: [], warnings: [] });
    let s = 7;
    const rnd = new Uint8Array(4096).map(() => ((s = (s * 1103515245 + 12345) >>> 0) >>> 24) & 255);
    expect(() => readAudioMetadata(rnd)).not.toThrow();
    expect(readAudioMetadata(enc('%PDF-1.4 hello')).tags).toEqual([]);
    expect(() => readAudioMetadata(null as unknown as Uint8Array)).not.toThrow();
  });

  it('caps tags and value lengths', () => {
    const many = flacFile(Array.from({ length: 500 }, (_, i) => `X${i}=${'v'.repeat(2000)}`));
    const m = readAudioMetadata(many, { maxTags: 50, maxValueLength: 100 });
    expect(m.tags.length).toBe(50);
    expect(Math.max(...m.tags.map((t) => t.value.length))).toBeLessThanOrEqual(101);
  });
});

describe('classifyRightsSignals', () => {
  it('flags ISRC, copyright, label and purchase markers as likely commercial', () => {
    const m = readAudioMetadata(
      concat(
        id3v2(3, [
          { id: 'TSRC', body: textBody('USRC17607839') },
          { id: 'TCOP', body: textBody('℗ 2019 Some Label') },
          { id: 'TIT2', body: textBody('Song') },
        ]),
        FAKE_MPEG,
      ),
    );
    const c = classifyRightsSignals(m);
    expect(c.level).toBe('likely-commercial');
    expect(c.signals.map((s) => s.kind)).toEqual(['isrc', 'copyright', 'title']);
    expect(c.summary).toBe(
      'This file carries ISRC USRC17607839 and “℗ 2019 Some Label” — it looks like a commercial release.',
    );
  });

  it('treats artist/title alone as a softer hint', () => {
    const c = classifyRightsSignals(
      readAudioMetadata(
        wavWithChunks([
          riffInfo([
            ['IART', 'Me'],
            ['INAM', 'Demo'],
          ]),
        ]),
      ),
    );
    expect(c.level).toBe('hint');
    expect(c.summary).toMatch(/does not mean/);
  });

  it('reports nothing for untagged files and ignores malformed ISRCs', () => {
    expect(classifyRightsSignals(readAudioMetadata(wavWithChunks([]))).level).toBe('none');
    const bad = classifyRightsSignals({
      tags: [{ source: 'vorbis', key: 'ISRC', field: 'isrc', value: 'not-an-isrc' }],
    });
    expect(bad.level).toBe('none');
  });

  it('counts store URLs and MP4 store atoms as purchase markers', () => {
    const c = classifyRightsSignals({
      tags: [{ source: 'id3v2', key: 'WOAF', field: 'url', value: 'https://music.apple.com/album/1' }],
    });
    expect(c.signals[0].kind).toBe('purchase');
  });

  it('normalizes ISRCs', () => {
    expect(normalizeIsrc('us-rc1-76-07839')).toBe('USRC17607839');
    expect(normalizeIsrc('USRC1760783')).toBeNull();
  });
});
