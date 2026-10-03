import { describe, expect, it } from 'vitest';
import type { Note } from '@songdeck/core';
import { STOCK_VOICES, synthesizeVocal } from '../src/dsp';
import { resolveNotePhonemes } from '../src/dsp/singing/voice';
import { textToArpabet, wordPhonemesBySyllable } from '../src/dsp/singing/phonemes';
import { bandEnergy, cents, hasNonFinite, mkNote, mkSong, mkTrack, rms, yinF0 } from './dsp-helpers';

const SR = 44100;

function vocalSong(notes: Note[], voiceType?: 'tenor' | 'soprano' | 'alto' | 'baritone') {
  const song = mkSong(4);
  song.tracks = [mkTrack('v', 'lead-vocal', notes, { role: 'vocal', stemGroup: 'vocals', vocal: voiceType ? { voiceType } : undefined })];
  return song;
}

describe('singing synthesis', () => {
  it('ships at least four stock voices with voice types', () => {
    expect(STOCK_VOICES.length).toBeGreaterThanOrEqual(4);
    for (const id of ['tenor-warm', 'soprano-bright', 'alto-soft', 'baritone-deep']) expect(STOCK_VOICES.find((v) => v.id === id)?.voiceType).toBeDefined();
  });

  it('sings sustained vowels at the right pitch (±30 cents) for each voice', () => {
    const cases: [string, number][] = [
      ['tenor-warm', 57],
      ['baritone-deep', 50],
      ['alto-soft', 64],
      ['soprano-bright', 72],
    ];
    for (const [voiceId, pitch] of cases) {
      for (const syl of ['ah', 'ee', 'oo']) {
        const song = vocalSong([mkNote(pitch, 0, 1920, 100, { syllable: syl, expression: { vibrato: 0.3 } })]);
        const out = synthesizeVocal(song, 'v', { voiceId, sampleRate: SR });
        expect(out.channels.length).toBe(1);
        expect(hasNonFinite(out)).toBe(false);
        const x = out.channels[0];
        const f = 440 * Math.pow(2, (pitch - 69) / 12);
        // average over several windows across the sustained part (vibrato averages out)
        let sum = 0, cnt = 0;
        for (let t = 0.6; t < 1.7; t += 0.1) {
          sum += cents(yinF0(x, SR, Math.round(t * SR), 2048, 60, 1200), f);
          cnt++;
        }
        expect(Math.abs(sum / cnt), `${voiceId} ${syl}`).toBeLessThan(30);
        expect(rms(x, Math.round(0.5 * SR), Math.round(1.5 * SR))).toBeGreaterThan(0.01);
      }
    }
  });

  it('produces clearly different spectra for /a/ and /i/', () => {
    const render = (syl: string) => synthesizeVocal(vocalSong([mkNote(55, 0, 1920, 100, { syllable: syl, expression: { vibrato: 0 } })]), 'v', { voiceId: 'tenor-warm', sampleRate: SR }).channels[0];
    const a = render('ah');
    const i = render('ee');
    const s = Math.round(0.7 * SR);
    // /a/: high F1 (~770 Hz), low F2 (~1300 Hz). /i/: low F1 (~350 Hz), high F2 (~2300 Hz)
    const ratio = (x: Float32Array) => bandEnergy(x, SR, 1900, 2900, s, 8192, 20) / bandEnergy(x, SR, 600, 1000, s, 8192, 20);
    const ra = ratio(a);
    const ri = ratio(i);
    expect(10 * Math.log10(ri / ra)).toBeGreaterThan(10);
    // F1 region: /a/ has more energy around 700-900 Hz relative to 250-400 Hz
    const f1 = (x: Float32Array) => bandEnergy(x, SR, 650, 900, s, 8192, 20) / bandEnergy(x, SR, 250, 420, s, 8192, 20);
    expect(f1(a)).toBeGreaterThan(f1(i) * 3);
  });

  it('renders consonants (fricative noise) and onset/release styles', () => {
    const fric = synthesizeVocal(vocalSong([mkNote(57, 960, 1920, 100, { syllable: 'sea' })]), 'v', { sampleRate: SR }).channels[0];
    // /s/ just before the note start (1.0 s): strong 5-9 kHz noise, ≥ 10 dB above the vowel's high band
    const sStart = Math.round(0.9 * SR);
    expect(bandEnergy(fric, SR, 5000, 9000, sStart, 4096, 100)).toBeGreaterThan(bandEnergy(fric, SR, 5000, 9000, Math.round(1.6 * SR), 4096, 100) * 10);
    // scoop onset starts below the target pitch
    const sc = synthesizeVocal(vocalSong([mkNote(57, 0, 1920, 100, { syllable: 'ah', expression: { onset: 'scoop', vibrato: 0 } })]), 'v', { sampleRate: SR }).channels[0];
    expect(cents(yinF0(sc, SR, Math.round(0.02 * SR), 1024, 60, 1000), 220)).toBeLessThan(-40);
    // falling release ends lower
    const fall = synthesizeVocal(vocalSong([mkNote(57, 0, 1920, 100, { syllable: 'ah', expression: { release: 'falling', vibrato: 0 } })]), 'v', { sampleRate: SR }).channels[0];
    expect(cents(yinF0(fall, SR, Math.round(1.93 * SR), 1024, 60, 1000), 220)).toBeLessThan(-60);
    // velocity → loudness
    const soft = synthesizeVocal(vocalSong([mkNote(57, 0, 960, 40, { syllable: 'ah' })]), 'v', { sampleRate: SR }).channels[0];
    const loud = synthesizeVocal(vocalSong([mkNote(57, 0, 960, 120, { syllable: 'ah' })]), 'v', { sampleRate: SR }).channels[0];
    expect(rms(loud, 0, SR)).toBeGreaterThan(rms(soft, 0, SR) * 2);
  });

  it('sings legato phrases with melismas and word continuations', () => {
    const notes = [
      mkNote(60, 0, 480, 100, { syllable: 'fi-' }),
      mkNote(62, 480, 480, 100, { syllable: '-re' }),
      mkNote(64, 960, 480, 100, { syllable: '_' }),
      mkNote(65, 1440, 960, 100, { syllable: 'night', phonemes: ['N', 'AY1', 'T'] }),
    ];
    const ph = resolveNotePhonemes(notes);
    expect(ph[0]).toEqual(['F', 'AY']);
    expect(ph[1]).toEqual(['ER']);
    expect(ph[2]).toEqual([]);
    expect(ph[3]).toEqual(['N', 'AY', 'T']);
    const out = synthesizeVocal(vocalSong(notes), 'v', { sampleRate: SR });
    const x = out.channels[0];
    // the melisma note continues phonation at its own pitch (E4)
    expect(Math.abs(cents(yinF0(x, SR, Math.round(1.2 * SR), 2048, 60, 1000), 329.63))).toBeLessThan(40);
    // continuous voicing across the legato boundary between "fi" and "re"
    expect(rms(x, Math.round(0.48 * SR), Math.round(0.53 * SR))).toBeGreaterThan(0.01);
    // range rendering
    const part = synthesizeVocal(vocalSong(notes), 'v', { sampleRate: SR, startTick: 960, endTick: 1920 });
    expect(part.channels[0].length).toBeLessThan(x.length);
  });

  it('falls back from syllables to phonemes', () => {
    expect(textToArpabet('the fire')).toEqual(['DH', 'AH', 'F', 'AY', 'ER']);
    expect(textToArpabet('shine')).toEqual(['SH', 'AY', 'N']);
    expect(textToArpabet('cat')).toEqual(['K', 'AE', 'T']);
    expect(wordPhonemesBySyllable('broken', 2)).toEqual([
      ['B', 'R', 'OW'],
      ['K', 'EH', 'N'],
    ]);
    const ph = resolveNotePhonemes([mkNote(60, 0, 100, 90), mkNote(60, 100, 100, 90, { syllable: 'la' })]);
    expect(ph[0]).toEqual(['AA']);
    expect(ph[1]).toEqual(['L', 'AA']);
  });
});
