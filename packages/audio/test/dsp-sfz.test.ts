import { describe, expect, it } from 'vitest';
import { parseSfz, renderSong } from '../src/dsp';
import type { SampleInstrument } from '../src/dsp';
import type { AudioData } from '../src/types';
import { cents, mkNote, mkSong, mkTrack, peak, rms, setStrip, sine, yinF0 } from './dsp-helpers';

const SR = 44100;

const SFZ = `
// test instrument
<control> default_path=samples/ octave_offset=0
#define $VOL -3
<global> ampeg_release=0.05 amp_veltrack=100
<group> lovel=1 hivel=80 volume=$VOL
<region> sample=sine 220.wav lokey=c3 hikey=b3 pitch_keycenter=a3
<region> sample=sine 440.wav lokey=c4 hikey=127 pitch_keycenter=69 loop_mode=loop_continuous loop_start=100 loop_end=199
<group> lovel=81 hivel=127
/* loud layer
   spans everything */
<region> sample=saw.wav key=60 tune=0
<region> sample=missing.wav lokey=0 hikey=127
<region> sample=rr1.wav key=62 seq_length=2 seq_position=1 group=1
<region> sample=rr2.wav key=62 seq_length=2 seq_position=2 off_by=1
`;

function samples(): Record<string, AudioData> {
  // exactly periodic loops so loop points are seamless
  const s220 = sine(220, 1, SR, 0.5);
  const s440: AudioData = {
    sampleRate: 44100,
    channels: [Float32Array.from({ length: 300 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * i) / 100))],
  };
  const saw = new Float32Array(SR);
  for (let i = 0; i < SR; i++) saw[i] = 0.4 * (((i * 261.63) / SR) % 1) - 0.2;
  return {
    'samples/sine 220.wav': s220,
    'samples/sine 440.wav': s440,
    'samples/saw.wav': { sampleRate: SR, channels: [saw] },
    'samples/rr1.wav': sine(300, 0.5, SR, 0.3),
    'samples/rr2.wav': sine(600, 0.5, SR, 0.3),
  };
}

describe('SFZ sample instruments', () => {
  it('parses headers, inheritance, defines, comments, note names and paths with spaces', () => {
    const lib = samples();
    const requested: string[] = [];
    const inst = parseSfz(SFZ, (p) => {
      requested.push(p);
      return lib[p];
    });
    expect(requested).toContain('samples/sine 220.wav');
    expect(requested).toContain('samples/missing.wav');
    expect(inst.zones.length).toBe(5); // missing sample skipped
    const [z220, z440, zsaw] = inst.zones;
    expect(z220.lokey).toBe(48);
    expect(z220.hikey).toBe(59);
    expect(z220.pitchKeycenter).toBe(57);
    expect(z220.hivel).toBe(80);
    expect(z220.volume).toBe(-3);
    expect(z220.ampegRelease).toBe(0.05);
    expect(z440.loopMode).toBe('loop_continuous');
    expect(z440.loopStart).toBe(100);
    expect(z440.loopEnd).toBe(199);
    expect(z440.pitchKeycenter).toBe(69);
    expect(zsaw.lokey).toBe(60);
    expect(zsaw.hikey).toBe(60);
    expect(zsaw.lovel).toBe(81);
    expect(inst.zones[3].seqLength).toBe(2);
    expect(inst.zones[3].group).toBe(1);
    expect(inst.zones[4].offBy).toBe(1);
  });

  it('plays through the renderer with pitch shifting, velocity layers and loops', () => {
    const lib = samples();
    const inst: SampleInstrument = parseSfz(SFZ, (p) => lib[p]);
    const song = mkSong(4);
    song.tracks = [
      mkTrack('s', 'my-sampler', [
        mkNote(57, 0, 480, 60), // A3 → 220 Hz sample unshifted
        mkNote(59, 960, 900, 60), // B3 → shifted up 2 semitones
        mkNote(76, 1920, 1800, 60), // E5 from the looped 440 Hz sample (shifted +7 st)
        mkNote(60, 3840, 900, 120), // loud layer saw
      ]),
    ];
    setStrip(song, 's', { volumeDb: 0 });
    const out = renderSong(song, {
      sampleRate: SR,
      applyMaster: false,
      includeSends: false,
      tailSeconds: 0.3,
      patchOverrides: { s: 'user-sampler' },
      sampleInstruments: { 'user-sampler': inst },
    });
    const L = out.channels[0];
    expect(Math.abs(cents(yinF0(L, SR, Math.round(0.1 * SR)), 220))).toBeLessThan(5);
    expect(Math.abs(cents(yinF0(L, SR, Math.round(1.1 * SR)), 220 * Math.pow(2, 2 / 12)))).toBeLessThan(5);
    // looped 300-sample source (3 cycles of 441 Hz) sustains for the whole held note
    const f440 = 44100 / 100;
    expect(Math.abs(cents(yinF0(L, SR, Math.round(3.5 * SR)), f440 * Math.pow(2, 7 / 12)))).toBeLessThan(10);
    expect(rms(L, Math.round(3.5 * SR), Math.round(3.8 * SR))).toBeGreaterThan(0.05);
    // loud layer: saw sample at keycenter 60
    expect(Math.abs(cents(yinF0(L, SR, Math.round(4.2 * SR)), 261.63))).toBeLessThan(10);
    // release: silence shortly after the first note ends (0.5 s + ~0.05 s release)
    expect(peak(L, Math.round(0.6 * SR), Math.round(0.98 * SR))).toBeLessThan(0.01);
  });

  it('supports round robin and choke groups', () => {
    const lib = samples();
    const inst = parseSfz(SFZ, (p) => lib[p]);
    const song = mkSong(2);
    song.tracks = [
      mkTrack('s', 'x', [mkNote(62, 0, 900, 100), mkNote(62, 960, 900, 100), mkNote(62, 1920, 900, 100)]),
    ];
    setStrip(song, 's', { volumeDb: 0 });
    const out = renderSong(song, {
      sampleRate: SR,
      applyMaster: false,
      includeSends: false,
      tailSeconds: 0,
      patchOverrides: { s: 'rr' },
      sampleInstruments: { rr: inst },
    });
    const L = out.channels[0];
    const f1 = yinF0(L, SR, Math.round(0.1 * SR));
    const f2 = yinF0(L, SR, Math.round(1.1 * SR));
    const f3 = yinF0(L, SR, Math.round(2.1 * SR));
    expect(Math.abs(cents(f1, 300))).toBeLessThan(10); // key=62 → unshifted
    expect(Math.abs(cents(f2, 600))).toBeLessThan(10);
    expect(Math.abs(cents(f3, 300))).toBeLessThan(10);
  });
});
