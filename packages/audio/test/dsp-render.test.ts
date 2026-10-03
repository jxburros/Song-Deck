import { describe, expect, it } from 'vitest';
import { cloneSong, defaultChannelStrip, GM_DRUM } from '@songdeck/core';
import type { AudioClip, Song } from '@songdeck/core';
import { SongRenderer, renderSong, renderStems, renderTrack } from '../src/dsp';
import type { AudioData } from '../src/types';
import { bandSong, cents, db, hasNonFinite, lcg, mkNote, mkSong, mkTrack, peak, rms, setStrip, sine, yinF0 } from './dsp-helpers';

const SR = 44100;

function sameAudio(a: AudioData, b: AudioData): boolean {
  if (a.channels.length !== b.channels.length) return false;
  for (let c = 0; c < a.channels.length; c++) {
    const x = a.channels[c], y = b.channels[c];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

describe('renderSong', () => {
  it('renders a full band without NaN/Infinity, at the right length, not silent', () => {
    const song = bandSong(2);
    const out = renderSong(song, { sampleRate: SR, tailSeconds: 1 });
    expect(out.sampleRate).toBe(SR);
    expect(out.channels.length).toBe(2);
    // 2 bars at 120 bpm = 4 s + 1 s tail
    expect(out.channels[0].length).toBe(5 * SR);
    expect(hasNonFinite(out)).toBe(false);
    expect(rms(out.channels[0])).toBeGreaterThan(0.01);
  });

  it('is deterministic (bit-identical renders)', () => {
    const song = bandSong(2);
    const a = renderSong(song, { sampleRate: SR, tailSeconds: 0.5 });
    const b = renderSong(cloneSong(song), { sampleRate: SR, tailSeconds: 0.5 });
    expect(sameAudio(a, b)).toBe(true);
  });

  it('master limiter keeps sample peaks at or below the ceiling', () => {
    const song = bandSong(2);
    for (const t of song.tracks) setStrip(song, t.id, { volumeDb: 12, reverbSend: 0.3 });
    song.mixer.master.limiter = { enabled: true, ceilingDb: -1, releaseMs: 80 };
    const out = renderSong(song, { sampleRate: SR, tailSeconds: 0.5 });
    const ceil = Math.pow(10, -1 / 20);
    const pk = Math.max(peak(out.channels[0]), peak(out.channels[1]));
    expect(pk).toBeLessThanOrEqual(ceil + 1e-6);
    expect(pk).toBeGreaterThan(ceil * 0.9); // it really was driven into the limiter
  });

  it('streaming process() in random block sizes equals renderSong', () => {
    const song = bandSong(2);
    const opts = { sampleRate: SR, tailSeconds: 0.5 };
    const ref = renderSong(song, opts);
    const r = new SongRenderer(song, opts);
    expect(r.totalFrames).toBe(ref.channels[0].length);
    const L = new Float32Array(r.totalFrames), R = new Float32Array(r.totalFrames);
    const rnd = lcg(42);
    let pos = 0;
    const bufL = new Float32Array(8192), bufR = new Float32Array(8192);
    while (pos < r.totalFrames) {
      const want = 1 + Math.floor(rnd() * 8192);
      const n = r.process(bufL, bufR, want);
      expect(n).toBe(Math.min(want, r.totalFrames - pos));
      L.set(bufL.subarray(0, n), pos);
      R.set(bufR.subarray(0, n), pos);
      pos += n;
      expect(r.positionFrames).toBe(pos);
    }
    expect(r.process(bufL, bufR, 128)).toBe(0);
    expect(sameAudio(ref, { sampleRate: SR, channels: [L, R] })).toBe(true);
  });

  it('honours mute and solo (solo-in-place)', () => {
    const song = mkSong(1);
    song.tracks = [mkTrack('a', 'sine', [mkNote(60, 0, 1800)]), mkTrack('b', 'sine', [mkNote(72, 0, 1800)])];
    setStrip(song, 'a', { volumeDb: -6 });
    setStrip(song, 'b', { volumeDb: -6 });
    const base = { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0 };
    const full = renderSong(song, base);
    const muted = cloneSong(song);
    muted.mixer.channels.a.mute = true;
    const m = renderSong(muted, base);
    // with a muted, only the C5 sine remains
    expect(cents(yinF0(m.channels[0], SR, 4410), 523.25)).toBeLessThan(10);
    expect(rms(m.channels[0])).toBeLessThan(rms(full.channels[0]));
    const soloed = cloneSong(song);
    soloed.mixer.channels.a.solo = true;
    const s = renderSong(soloed, base);
    expect(Math.abs(cents(yinF0(s.channels[0], SR, 4410), 261.63))).toBeLessThan(10);
    // ignoreMuteSolo plays everything
    const ig = renderSong(muted, { ...base, ignoreMuteSolo: true });
    expect(rms(ig.channels[0])).toBeCloseTo(rms(full.channels[0]), 6);
    // all muted → silence
    const all = cloneSong(song);
    all.mixer.channels.a.mute = all.mixer.channels.b.mute = true;
    expect(peak(renderSong(all, base).channels[0])).toBe(0);
  });

  it('pan moves energy between channels (equal-power)', () => {
    const song = mkSong(1);
    song.tracks = [mkTrack('a', 'sine', [mkNote(69, 0, 1800)])];
    const base = { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0 };
    setStrip(song, 'a', { pan: -1 });
    const left = renderSong(song, base);
    expect(rms(left.channels[1])).toBeLessThan(1e-6);
    expect(rms(left.channels[0])).toBeGreaterThan(0.01);
    setStrip(song, 'a', { pan: 0.5 });
    const right = renderSong(song, base);
    expect(rms(right.channels[1])).toBeGreaterThan(rms(right.channels[0]) * 2);
    setStrip(song, 'a', { pan: 0 });
    const c = renderSong(song, base);
    expect(rms(c.channels[0])).toBeCloseTo(rms(c.channels[1]), 9);
    // equal power: L²+R² constant across pan positions
    const p = (x: AudioData) => rms(x.channels[0]) ** 2 + rms(x.channels[1]) ** 2;
    expect(p(right) / p(c)).toBeCloseTo(1, 3);
  });

  it('volume automation changes the level over time (and step curves jump)', () => {
    const song = mkSong(2);
    song.tracks = [mkTrack('a', 'sine', [mkNote(69, 0, 3840)])];
    setStrip(song, 'a', { volumeDb: 0 });
    song.automation = [{ id: 'l1', target: 'a', param: 'volumeDb', enabled: true, points: [{ tick: 0, value: -40 }, { tick: 3840, value: 0 }] }];
    const out = renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0 });
    const L = out.channels[0];
    const early = rms(L, Math.round(0.2 * SR), Math.round(0.6 * SR));
    const late = rms(L, Math.round(3.3 * SR), Math.round(3.7 * SR));
    expect(db(late) - db(early)).toBeGreaterThan(25);
    // a ramp is monotone (no zipper jumps): compare consecutive 50 ms windows
    let prev = 0;
    for (let t = 0.3; t < 3.6; t += 0.25) {
      const v = rms(L, Math.round(t * SR), Math.round((t + 0.05) * SR));
      expect(v).toBeGreaterThan(prev * 0.98);
      prev = v;
    }
    // step curve
    song.automation = [{ id: 'l2', target: 'a', param: 'volumeDb', enabled: true, points: [{ tick: 0, value: -30, curve: 'step' }, { tick: 1920, value: 0 }] }];
    const st = renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0 });
    const a = rms(st.channels[0], Math.round(1.0 * SR), Math.round(1.8 * SR));
    const b = rms(st.channels[0], Math.round(2.2 * SR), Math.round(3.0 * SR));
    expect(db(b) - db(a)).toBeCloseTo(30, 0);
    // master lane
    song.automation = [{ id: 'm', target: 'master', param: 'volumeDb', enabled: true, points: [{ tick: 0, value: -20 }, { tick: 1919, value: -20, curve: 'step' }, { tick: 1920, value: 0 }] }];
    const ms = renderSong(song, { sampleRate: SR, includeSends: false, tailSeconds: 0 });
    expect(db(rms(ms.channels[0], Math.round(2.5 * SR), Math.round(3.5 * SR))) - db(rms(ms.channels[0], Math.round(0.5 * SR), Math.round(1.5 * SR)))).toBeGreaterThan(15);
  });

  it('reverb and delay sends leave a tail after the note', () => {
    const song = mkSong(1);
    song.tracks = [mkTrack('a', 'piano', [mkNote(60, 0, 240, 110)])];
    const opts = { sampleRate: SR, applyMaster: false, tailSeconds: 2 };
    setStrip(song, 'a', { reverbSend: 0 });
    const dry = renderSong(song, opts);
    setStrip(song, 'a', { reverbSend: 1 });
    const wet = renderSong(song, opts);
    // window after the piano note has been damped (note ends at 0.25 s)
    const a = Math.round(1.2 * SR), b = Math.round(1.6 * SR);
    expect(rms(wet.channels[0], a, b)).toBeGreaterThan(rms(dry.channels[0], a, b) * 4);
    // stereo reverb is decorrelated
    expect(rms(wet.channels[0], a, b)).toBeGreaterThan(0);
    setStrip(song, 'a', { reverbSend: 0, delaySend: 1 });
    const del = renderSong(song, opts);
    // dotted-eighth (0.75 beat at 120 bpm = 0.375 s) echo after the note
    const echo = rms(del.channels[0], Math.round(0.6 * SR), Math.round(0.9 * SR)) + rms(del.channels[1], Math.round(0.6 * SR), Math.round(0.9 * SR));
    const echoDry = rms(dry.channels[0], Math.round(0.6 * SR), Math.round(0.9 * SR)) * 2;
    expect(echo).toBeGreaterThan(echoDry * 1.5);
    // includeSends:false removes the bus
    const noSends = renderSong(song, { ...opts, includeSends: false });
    expect(rms(noSends.channels[0], Math.round(0.6 * SR), Math.round(0.9 * SR))).toBeCloseTo(rms(dry.channels[0], Math.round(0.6 * SR), Math.round(0.9 * SR)), 6);
  });

  it('plays audio clips with offset, gain, fades and on-the-fly resampling', () => {
    const song = mkSong(2);
    const assetSr = 22050;
    const asset = sine(440, 3, assetSr, 0.5);
    const clip: AudioClip = { id: 'c1', assetId: 'tone', tick: 960, offsetSeconds: 0.5, durationSeconds: 2, gainDb: -6, fadeInSeconds: 0.1, fadeOutSeconds: 0.2 };
    song.tracks = [mkTrack('aud', 'none', [], { kind: 'audio', clips: [clip], stemGroup: 'others' })];
    setStrip(song, 'aud', { volumeDb: 0 });
    const out = renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0, assets: (id) => (id === 'tone' ? asset : undefined) });
    const L = out.channels[0];
    // silent before the clip (tick 960 = 1.0 s at 120 bpm)
    expect(peak(L, 0, Math.round(0.99 * SR))).toBe(0);
    // resampled pitch stays 440 Hz
    expect(Math.abs(cents(yinF0(L, SR, Math.round(1.5 * SR)), 440))).toBeLessThan(5);
    // level: 0.5 amplitude × -6 dB at center pan (unity) ≈ 0.25 peak
    expect(peak(L, Math.round(1.5 * SR), Math.round(2.5 * SR))).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 2);
    // fade in: quieter during the first 30 ms than later
    expect(rms(L, Math.round(1.0 * SR), Math.round(1.03 * SR))).toBeLessThan(rms(L, Math.round(1.5 * SR), Math.round(1.6 * SR)) * 0.7);
    // ends after durationSeconds (1 + 2 = 3 s)
    expect(peak(L, Math.round(3.01 * SR), L.length)).toBe(0);
    // muted clip / missing asset → silence, no throw
    song.tracks[0].clips = [{ ...clip, muted: true }, { ...clip, id: 'c2', assetId: 'missing' }];
    const r = new SongRenderer(song, { sampleRate: SR, assets: () => undefined });
    expect(r.missingAssets).toContain('missing');
  });

  it('stems sum to the unmastered mix', () => {
    const song = bandSong(2);
    for (const t of song.tracks) setStrip(song, t.id, { reverbSend: 0.25, delaySend: 0.15, drive: 0.2, compressor: { ...defaultChannelStrip().compressor, enabled: true } });
    const opts = { sampleRate: SR, applyMaster: false, tailSeconds: 1 };
    const mix = renderSong(song, opts);
    const stems = renderStems(song, opts);
    expect(Object.keys(stems).sort()).toEqual(['bass', 'drums', 'keys', 'others']);
    for (let c = 0; c < 2; c++) {
      let maxErr = 0;
      for (let i = 0; i < mix.channels[c].length; i++) {
        let s = 0;
        for (const k of Object.keys(stems)) s += stems[k].channels[c][i];
        maxErr = Math.max(maxErr, Math.abs(s - mix.channels[c][i]));
      }
      expect(maxErr).toBeLessThan(1e-4);
    }
    const byTrack = renderStems(song, { ...opts, by: 'track' });
    expect(Object.keys(byTrack).sort()).toEqual(['bass', 'drums', 'keys', 'lead']);
    // renderTrack equals the by-track stem
    const one = renderTrack(song, 'bass', opts);
    expect(sameAudio(one, byTrack.bass)).toBe(true);
  });

  it('respects startTick/endTick and the tail', () => {
    const song = bandSong(4);
    const out = renderSong(song, { sampleRate: SR, startTick: 1920, endTick: 3840, tailSeconds: 0.5 });
    expect(out.channels[0].length).toBe(Math.round(2.5 * SR));
    expect(rms(out.channels[0], 0, SR)).toBeGreaterThan(0.01);
  });

  it('applies patch overrides and resolves instruments', () => {
    const song = mkSong(1);
    song.tracks = [mkTrack('a', 'unknown-thing', [mkNote(57, 0, 1800, 100)])];
    setStrip(song, 'a', {});
    const out = renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0, patchOverrides: { a: 'flute' } });
    expect(Math.abs(cents(yinF0(out.channels[0], SR, Math.round(0.5 * SR)), 220))).toBeLessThan(15);
  });
});

describe('robustness', () => {
  it('renders at other sample rates, extreme pitches/velocities and empty songs without NaN', () => {
    for (const sr of [22050, 96000]) {
      const song = bandSong(1);
      const out = renderSong(song, { sampleRate: sr, tailSeconds: 0.3 });
      expect(out.sampleRate).toBe(sr);
      expect(out.channels[0].length).toBe(Math.round(2.3 * sr));
      expect(hasNonFinite(out)).toBe(false);
      const one = mkSong(1);
      one.tracks = [mkTrack('a', 'sine', [mkNote(69, 0, 1800)])];
      setStrip(one, 'a', {});
      const tone = renderSong(one, { sampleRate: sr, applyMaster: false, includeSends: false, tailSeconds: 0 });
      expect(Math.abs(cents(yinF0(tone.channels[0], sr, Math.round(0.5 * sr), 2048), 440))).toBeLessThan(5);
    }
    const ext = mkSong(1);
    const patches = ['piano', 'guitar-distorted', 'bass-electric', 'strings-ensemble', 'epiano', 'organ', 'choir', 'timpani', 'lead-saw', 'harp', 'vocal-placeholder'];
    ext.tracks = patches.map((p) => mkTrack(p, p, [mkNote(0, 0, 400, 1), mkNote(127, 480, 400, 127), mkNote(60, 960, 1, 64), mkNote(-5, 1000, 100, 300 as number)]));
    for (const t of ext.tracks) setStrip(ext, t.id, {});
    const o = renderSong(ext, { sampleRate: SR, patchOverrides: Object.fromEntries(patches.map((p) => [p, p])), tailSeconds: 0.5 });
    expect(hasNonFinite(o)).toBe(false);
    const empty = mkSong(0);
    empty.sections = [];
    const e = renderSong(empty, { sampleRate: SR, tailSeconds: 0.25 });
    expect(e.channels[0].length).toBe(Math.round(0.25 * SR));
    expect(peak(e.channels[0])).toBe(0);
  });

  it('automates pan, width, sends and EQ filters', () => {
    const song = mkSong(2);
    song.tracks = [mkTrack('a', 'pad-bright', [mkNote(60, 0, 3840, 100), mkNote(67, 0, 3840, 100)])];
    setStrip(song, 'a', {});
    song.automation = [
      { id: 'p', target: 'a', param: 'pan', enabled: true, points: [{ tick: 0, value: -1 }, { tick: 3840, value: 1 }] },
      { id: 'lp', target: 'a', param: 'eq.lowpassHz', enabled: true, points: [{ tick: 0, value: 400 }, { tick: 3840, value: 400 }] },
      { id: 'w', target: 'a', param: 'width', enabled: true, points: [{ tick: 0, value: 0 }] },
      { id: 'r', target: 'a', param: 'reverbSend', enabled: true, points: [{ tick: 0, value: 0.8 }] },
      { id: 'x', target: 'a', param: 'eq.highShelfDb', enabled: false, points: [{ tick: 0, value: 12 }] },
    ];
    const out = renderSong(song, { sampleRate: SR, applyMaster: false, tailSeconds: 0.2 });
    expect(hasNonFinite(out)).toBe(false);
    const L = out.channels[0], R = out.channels[1];
    const early = [Math.round(0.4 * SR), Math.round(0.8 * SR)] as const;
    const late = [Math.round(3.2 * SR), Math.round(3.6 * SR)] as const;
    expect(rms(L, ...early)).toBeGreaterThan(rms(R, ...early) * 2);
    expect(rms(R, ...late)).toBeGreaterThan(rms(L, ...late) * 2);
    // the 400 Hz low-pass removes the bright pad's upper partials
    const nolp = cloneSong(song);
    nolp.automation = nolp.automation.filter((l) => l.id !== 'lp');
    const bright = renderSong(nolp, { sampleRate: SR, applyMaster: false, tailSeconds: 0.2 });
    const hf = (x: Float32Array) => {
      let e = 0;
      for (let i = Math.round(1.5 * SR); i < Math.round(2.5 * SR); i++) e += (x[i] - x[i - 1]) ** 2;
      return e;
    };
    expect(hf(bright.channels[0]) + hf(bright.channels[1])).toBeGreaterThan((hf(L) + hf(R)) * 4);
  });
});

describe('SongRenderer transport', () => {
  it('seeks, reports position, ends with 0 and loops', () => {
    const song = bandSong(2);
    const r = new SongRenderer(song, { sampleRate: SR, tailSeconds: 0.5 });
    const L = new Float32Array(4096), R = new Float32Array(4096);
    r.seekSeconds(1);
    expect(r.positionFrames).toBe(SR);
    expect(r.process(L, R)).toBe(4096);
    expect(r.positionFrames).toBe(SR + 4096);
    r.seekFrame(r.totalFrames - 100);
    expect(r.process(L, R)).toBe(100);
    expect(r.process(L, R)).toBe(0);
    for (let i = 0; i < 4096; i++) expect(L[i]).toBe(0);
    // loop one beat
    r.setLoop(SR, SR + SR / 2);
    expect(r.positionFrames).toBe(SR);
    let total = 0;
    for (let k = 0; k < 20; k++) {
      total += r.process(L, R, 1000);
      expect(r.positionFrames).toBeGreaterThanOrEqual(SR);
      expect(r.positionFrames).toBeLessThan(SR + SR / 2);
    }
    expect(total).toBe(20000);
    expect(rms(L)).toBeGreaterThan(0);
    r.setLoop(null);
  });

  it('applies live song edits and mixer changes while playing', () => {
    const song = mkSong(4);
    song.tracks = [mkTrack('a', 'pad-warm', [mkNote(60, 0, 7680, 100), mkNote(64, 0, 7680, 100)])];
    setStrip(song, 'a', { volumeDb: 0 });
    const r = new SongRenderer(song, { sampleRate: SR, applyMaster: false, includeSends: false });
    const L = new Float32Array(SR), R = new Float32Array(SR);
    r.process(L, R);
    const before = rms(L, SR / 2, SR);
    // remove the notes: voices must release
    const edited = cloneSong(song);
    edited.tracks[0].notes = [];
    r.updateSong(edited);
    expect(r.positionFrames).toBe(SR);
    r.process(L, R);
    r.process(L, R);
    expect(rms(L, SR / 2, SR)).toBeLessThan(before * 0.05);
    // mixer changes are smoothed but take effect
    r.updateSong(song);
    r.seekFrame(SR);
    r.process(L, R);
    const lvl0 = rms(L, SR / 2, SR);
    const mixer = cloneSong(song.mixer);
    mixer.channels.a.volumeDb = -20;
    r.updateMixer(mixer);
    r.process(L, R);
    // no discontinuity at the block boundary where the change starts
    let maxJump = 0;
    for (let i = 1; i < 2048; i++) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
    expect(maxJump).toBeLessThan(0.2);
    expect(db(rms(L, SR / 2, SR)) - db(lvl0)).toBeLessThan(-15);
    const meters = r.getMeters();
    expect(meters.tracks.a.rmsDb).toBeLessThan(0);
    expect(Number.isFinite(meters.master.peakDb)).toBe(true);
  });

  it('adds a metronome click on beats when requested', () => {
    const song = mkSong(1);
    song.tracks = [];
    const out = renderSong(song, { sampleRate: SR, metronome: true, tailSeconds: 0 });
    const L = out.channels[0];
    for (const beat of [0, 0.5, 1, 1.5]) expect(peak(L, Math.round(beat * SR), Math.round(beat * SR) + 400)).toBeGreaterThan(0.05);
    expect(peak(L, Math.round(0.2 * SR), Math.round(0.45 * SR))).toBe(0);
  });

  it('chases sustained notes after a seek', () => {
    const song = mkSong(2);
    song.tracks = [mkTrack('a', 'strings-ensemble', [mkNote(60, 0, 3840, 100)])];
    setStrip(song, 'a', {});
    const r = new SongRenderer(song, { sampleRate: SR });
    r.seekSeconds(2);
    const L = new Float32Array(SR / 2), R = new Float32Array(SR / 2);
    r.process(L, R);
    expect(rms(L, SR / 4, SR / 2)).toBeGreaterThan(0.005);
  });

  it('drum kit renders every GM drum note', () => {
    const song = mkSong(13);
    const notes = [];
    // one hit per beat (480 ticks = 0.5 s at 120 bpm)
    for (let p = GM_DRUM.KICK_ACOUSTIC; p <= GM_DRUM.SHAKER; p++) notes.push(mkNote(p, (p - 35) * 480, 240, 100));
    song.tracks = [mkTrack('d', 'drum-kit', notes, { role: 'drums', stemGroup: 'drums' })];
    setStrip(song, 'd', { volumeDb: 0 });
    const out = renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0 });
    for (let p = GM_DRUM.KICK_ACOUSTIC; p <= GM_DRUM.SHAKER; p++) {
      const s = Math.round((p - 35) * 0.5 * SR);
      expect(peak(out.channels[0], s, s + Math.round(0.1 * SR)), `drum note ${p}`).toBeGreaterThan(0.005);
    }
  });
});

describe('vocal tracks in the renderer', () => {
  it('uses the singing synth for vocal-placeholder and silence for mode "none"', () => {
    const song: Song = mkSong(2);
    song.tracks = [mkTrack('v', 'lead-vocal', [mkNote(60, 0, 1800, 100, { syllable: 'ah' })], { role: 'vocal', stemGroup: 'vocals' })];
    setStrip(song, 'v', {});
    const out = renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0 });
    expect(Math.abs(cents(yinF0(out.channels[0], SR, Math.round(0.5 * SR)), 261.63))).toBeLessThan(30);
    song.tracks[0].vocal = { mode: 'none' };
    expect(peak(renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0 }).channels[0])).toBe(0);
  });
});
