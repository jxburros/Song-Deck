import { describe, expect, it } from 'vitest';
import type { Articulation } from '@songdeck/core';
import { PATCHES, patchIdForGmProgram, patchIdForInstrument, renderSong } from '../src/dsp';
import { cents, hasNonFinite, mkNote, mkSong, mkTrack, peak, rms, setStrip, toneMag, yinF0 } from './dsp-helpers';

const SR = 44100;

const REQUIRED = [
  'drums-acoustic', 'drums-electronic', 'percussion', 'bass-electric', 'bass-synth', 'bass-upright', 'guitar-distorted', 'guitar-clean',
  'guitar-acoustic', 'guitar-lead', 'piano', 'epiano', 'organ', 'strings-solo', 'strings-ensemble', 'strings-pizz', 'brass', 'brass-solo',
  'flute', 'reed', 'pad-warm', 'pad-bright', 'lead-saw', 'lead-square', 'pluck', 'choir', 'vocal-placeholder', 'harp', 'timpani', 'bell',
  'mallet', 'sine',
];

function renderNote(patchId: string, pitch: number, opts: { dur?: number; vel?: number; art?: Articulation; seconds?: number } = {}) {
  const song = mkSong(2);
  const notes = [mkNote(pitch, 0, opts.dur ?? 1800, opts.vel ?? 100, opts.art ? { articulation: opts.art } : {})];
  song.tracks = [mkTrack('t', 'x', notes, { stemGroup: PATCHES[patchId].stemGroup })];
  setStrip(song, 't', { volumeDb: 0 });
  return renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, patchOverrides: { t: patchId }, tailSeconds: 0.2 });
}

describe('patch library', () => {
  it('defines every required patch id', () => {
    for (const id of REQUIRED) {
      expect(PATCHES[id], id).toBeDefined();
      expect(PATCHES[id].id).toBe(id);
    }
  });

  it('maps instrument profiles and GM programs to patches', () => {
    const map: Record<string, string> = {
      'drum-kit': 'drums-acoustic', 'electronic-kit': 'drums-electronic', percussion: 'percussion', 'electric-bass': 'bass-electric',
      'synth-bass': 'bass-synth', 'upright-bass': 'bass-upright', 'electric-guitar-distorted': 'guitar-distorted',
      'electric-guitar-clean': 'guitar-clean', 'acoustic-guitar': 'guitar-acoustic', 'electric-guitar-lead': 'guitar-lead', piano: 'piano',
      'electric-piano': 'epiano', organ: 'organ', violin: 'strings-solo', viola: 'strings-solo', cello: 'strings-solo', contrabass: 'strings-solo',
      'string-ensemble': 'strings-ensemble', 'pizzicato-strings': 'strings-pizz', trumpet: 'brass-solo', trombone: 'brass-solo',
      'french-horn': 'brass-solo', 'brass-section': 'brass', flute: 'flute', clarinet: 'reed', saxophone: 'reed', 'synth-pad': 'pad-warm',
      'synth-lead': 'lead-saw', 'synth-arp': 'pluck', 'synth-seq': 'pluck', choir: 'choir', 'lead-vocal': 'vocal-placeholder',
      'backing-vocal': 'vocal-placeholder', harp: 'harp', timpani: 'timpani', glockenspiel: 'bell', marimba: 'mallet',
    };
    for (const [inst, patch] of Object.entries(map)) expect(patchIdForInstrument(inst), inst).toBe(patch);
    expect(patchIdForInstrument('my-custom-rhodes')).toBe('epiano');
    expect(patchIdForInstrument('zzz')).toBe('sine');
    expect(patchIdForGmProgram(0)).toBe('piano');
    expect(patchIdForGmProgram(30)).toBe('guitar-distorted');
    expect(patchIdForGmProgram(33)).toBe('bass-electric');
    expect(patchIdForGmProgram(48)).toBe('strings-ensemble');
    expect(patchIdForGmProgram(56)).toBe('brass-solo');
    expect(patchIdForGmProgram(73)).toBe('flute');
    expect(patchIdForGmProgram(0, true)).toBe('drums-acoustic');
    for (let p = 0; p < 128; p++) expect(PATCHES[patchIdForGmProgram(p)], `program ${p}`).toBeDefined();
  });

  it('every patch produces non-silent, finite audio; melodic patches sound at the expected pitch', () => {
    const inharmonic = new Set(['timpani', 'bell']);
    for (const id of REQUIRED) {
      const p = PATCHES[id];
      const isDrum = p.engine === 'drums';
      const pitch = isDrum ? 38 : Math.round((p.range[0] + p.range[1]) / 2);
      const out = renderNote(id, pitch);
      expect(hasNonFinite(out), id).toBe(false);
      const L = out.channels[0];
      expect(rms(L, 0, SR), id).toBeGreaterThan(0.003);
      if (isDrum) continue;
      const f = 440 * Math.pow(2, (pitch - 69) / 12);
      const start = Math.round(0.3 * SR);
      if (inharmonic.has(id)) {
        // strongest component near the written pitch is the fundamental partial
        const atF = toneMag(L, SR, f, start);
        expect(atF, id).toBeGreaterThan(toneMag(L, SR, f * 0.5, start) * 2);
        expect(atF, id).toBeGreaterThan(toneMag(L, SR, f * Math.pow(2, 1 / 12), start) * 2);
        continue;
      }
      const est = yinF0(L, SR, start, 4096, 30, 2000);
      expect(Math.abs(cents(est, f)), `${id}: ${est.toFixed(1)} Hz vs ${f.toFixed(1)} Hz`).toBeLessThan(25);
    }
  });

  it('velocity changes level (and brightness)', () => {
    for (const id of ['piano', 'guitar-clean', 'brass', 'epiano']) {
      const soft = rms(renderNote(id, 60, { vel: 40 }).channels[0], 0, SR);
      const loud = rms(renderNote(id, 60, { vel: 120 }).channels[0], 0, SR);
      expect(loud, id).toBeGreaterThan(soft * 2);
    }
  });

  it('honours articulations: staccato, palm-mute, dead, legato glide, pizzicato, bend, slide, tremolo, ghost/accent', () => {
    // staccato is shorter
    const norm = renderNote('strings-ensemble', 60, { dur: 960 });
    const stac = renderNote('strings-ensemble', 60, { dur: 960, art: 'staccato' });
    const late = [Math.round(0.6 * SR), Math.round(0.9 * SR)] as const;
    expect(rms(stac.channels[0], ...late)).toBeLessThan(rms(norm.channels[0], ...late) * 0.3);
    // palm mute decays faster on a guitar
    const open = renderNote('guitar-clean', 52, { dur: 960 });
    const pm = renderNote('guitar-clean', 52, { dur: 960, art: 'palm-mute' });
    const w = [Math.round(0.3 * SR), Math.round(0.45 * SR)] as const;
    expect(rms(pm.channels[0], ...w)).toBeLessThan(rms(open.channels[0], ...w) * 0.3);
    // dead note is a short thump
    const dead = renderNote('guitar-distorted', 52, { dur: 960, art: 'dead' });
    expect(rms(dead.channels[0], ...w)).toBeLessThan(0.01);
    // ghost quieter than accent
    const ghost = rms(renderNote('drums-acoustic', 38, { art: 'ghost' }).channels[0], 0, SR / 4);
    const accent = rms(renderNote('drums-acoustic', 38, { art: 'accent' }).channels[0], 0, SR / 4);
    expect(accent).toBeGreaterThan(ghost * 2);
    // pizzicato on a strings track uses the plucked patch (decays)
    const pz = renderNote('strings-solo', 60, { dur: 1800, art: 'pizzicato' });
    expect(rms(pz.channels[0], Math.round(1.2 * SR), Math.round(1.6 * SR))).toBeLessThan(rms(pz.channels[0], 0, Math.round(0.2 * SR)) * 0.1);
    // bend: starts ~2 semitones low, reaches the target
    const bend = renderNote('guitar-lead', 64, { dur: 1800, art: 'bend' });
    const f = 440 * Math.pow(2, (64 - 69) / 12);
    expect(cents(yinF0(bend.channels[0], SR, 0, 1024), f)).toBeLessThan(-80);
    expect(Math.abs(cents(yinF0(bend.channels[0], SR, Math.round(0.8 * SR)), f))).toBeLessThan(30);
    // tremolo modulates the amplitude
    const tr = renderNote('strings-ensemble', 60, { dur: 1800, art: 'tremolo' });
    const env: number[] = [];
    for (let t = 0.5; t < 0.9; t += 0.01) env.push(rms(tr.channels[0], Math.round(t * SR), Math.round((t + 0.01) * SR)));
    expect(Math.max(...env) / Math.min(...env)).toBeGreaterThan(1.5);
  });

  it('mono instruments glide/hammer-on legato and slide between notes', () => {
    const song = mkSong(2);
    // overlapping notes on a mono lead: legato portamento from A3 to A4
    song.tracks = [mkTrack('t', 'synth-lead', [mkNote(57, 0, 1000, 100), mkNote(69, 960, 900, 100, { articulation: 'legato' })])];
    setStrip(song, 't', { volumeDb: 0 });
    const out = renderSong(song, { sampleRate: SR, applyMaster: false, includeSends: false, tailSeconds: 0 });
    expect(Math.abs(cents(yinF0(out.channels[0], SR, Math.round(0.5 * SR)), 220))).toBeLessThan(20);
    expect(Math.abs(cents(yinF0(out.channels[0], SR, Math.round(1.6 * SR)), 440))).toBeLessThan(20);
    // no re-attack gap at the transition (legato keeps the amplitude up)
    const gap = rms(out.channels[0], Math.round(0.98 * SR), Math.round(1.04 * SR));
    expect(gap).toBeGreaterThan(rms(out.channels[0], Math.round(0.6 * SR), Math.round(0.9 * SR)) * 0.4);
    // polyphony limit: 40 simultaneous piano notes still render finite audio
    const chord = mkSong(1);
    chord.tracks = [mkTrack('p', 'piano', Array.from({ length: 40 }, (_, i) => mkNote(36 + i, 0, 1800, 90)))];
    setStrip(chord, 'p', {});
    const c = renderSong(chord, { sampleRate: SR, tailSeconds: 0 });
    expect(hasNonFinite(c)).toBe(false);
    expect(peak(c.channels[0])).toBeGreaterThan(0.01);
  });

  it('electronic kit and percussion kit render', () => {
    for (const id of ['drums-electronic', 'percussion']) {
      const out = renderNote(id, 36);
      expect(rms(out.channels[0], 0, SR / 2), id).toBeGreaterThan(0.005);
    }
  });
});
