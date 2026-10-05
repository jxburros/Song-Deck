import { describe, expect, it } from 'vitest';
import { pluginRenderKey } from '@songdeck/core';
import { renderTrack } from '../src/dsp';
import { mkNote, mkSong, mkTrack, rms, sine } from './dsp-helpers';

const SR = 22050;

function setup() {
  const song = mkSong(1, 120);
  const track = mkTrack('keys', 'piano', [mkNote(60, 0, 960)]);
  song.tracks = [track];
  const frozen = sine(880, 2, SR, 0.25, 2);
  track.instrumentPlugin = { format: 'vst3', pluginId: 'p', name: 'Synth', hostId: 'h' };
  track.instrumentPlugin.render = {
    assetId: 'render-1',
    key: pluginRenderKey(song, track),
    sampleRate: SR,
    durationSeconds: 2,
    renderedAt: '2026-01-01T00:00:00Z',
  };
  const assets = (id: string) => (id === 'render-1' ? frozen : undefined);
  return { song, track, frozen, assets };
}

const opts = { sampleRate: SR, tailSeconds: 0, includeSends: false };

describe('instrument plugin freeze', () => {
  it('a current render replaces the built-in patch', () => {
    const { song, frozen, assets } = setup();
    const out = renderTrack(song, 'keys', { ...opts, assets });
    // The output is the frozen audio through the channel strip: perfectly correlated with it.
    const x = out.channels[0].subarray(0, SR);
    const y = frozen.channels[0].subarray(0, SR);
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i < SR; i++) {
      xy += x[i] * y[i];
      xx += x[i] * x[i];
      yy += y[i] * y[i];
    }
    expect(rms(x)).toBeGreaterThan(0.05);
    expect(xy / Math.sqrt(xx * yy)).toBeGreaterThan(0.99);
  });

  it('stale, bypassed or missing renders fall back to the patch', () => {
    const { song, track, assets } = setup();
    const frozenOut = renderTrack(song, 'keys', { ...opts, assets });
    const stale = structuredClone(song);
    stale.tracks[0].notes[0].velocity = 50;
    const a = renderTrack(stale, 'keys', { ...opts, assets });
    const bypassed = structuredClone(song);
    bypassed.tracks[0].instrumentPlugin!.bypass = true;
    const b = renderTrack(bypassed, 'keys', { ...opts, assets });
    const missing = renderTrack(song, 'keys', { ...opts, assets: () => undefined });
    for (const x of [a, b, missing])
      expect(x.channels[0].slice(0, 2000)).not.toEqual(frozenOut.channels[0].slice(0, 2000));
    expect(track.instrumentPlugin!.render!.key).toBe(pluginRenderKey(song, track));
  });
});
