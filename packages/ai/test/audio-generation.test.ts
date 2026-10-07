import { describe, expect, it } from 'vitest';
import {
  AUDIO_INPUTS,
  AUDIO_PROCESSES,
  PROVIDER_PRESETS,
  audioEngineProfile,
  configFromPreset,
  describeAudioEngine,
  isAudioEngine,
  processesForCapabilities,
  type AudioEngineSource,
} from '../src';

function fromPreset(presetId: string, extra?: Record<string, unknown>): AudioEngineSource {
  const config = configFromPreset(presetId, extra ? { extra } : {});
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)!;
  return {
    id: config.id,
    name: config.name,
    adapter: config.adapter,
    location: config.location,
    capabilities: preset.capabilities,
    config,
  };
}

const support = (view: ReturnType<typeof describeAudioEngine>, id: string) =>
  view?.inputs.find((i) => i.input.id === id)?.use.support;

describe('audio generation catalog', () => {
  it('describes every music, singing, voice and instrument preset', () => {
    const audio = PROVIDER_PRESETS.filter((p) =>
      ['music', 'singing', 'voice-conversion', 'instrument-host', 'managed'].includes(p.category),
    );
    expect(audio.length).toBeGreaterThan(5);
    for (const preset of audio) {
      const view = describeAudioEngine(fromPreset(preset.id));
      expect(view, preset.id).toBeDefined();
      expect(view!.processes.length, preset.id).toBeGreaterThan(0);
      expect(view!.inputs.length, preset.id).toBeGreaterThan(0);
    }
  });

  it('leaves text and analysis providers out', () => {
    expect(describeAudioEngine(fromPreset('openai'))).toBeUndefined();
    expect(isAudioEngine(fromPreset('openai'))).toBe(false);
    expect(isAudioEngine(fromPreset('demucs-local'))).toBe(false);
    expect(isAudioEngine(fromPreset('elevenlabs-music'))).toBe(true);
  });

  it('matches what the cloud adapters send', () => {
    const eleven = describeAudioEngine(fromPreset('elevenlabs-music'));
    expect(eleven!.processes).toEqual(['text-to-music', 'song-with-vocals']);
    expect(support(eleven, 'lyrics')).toBe('used');
    expect(support(eleven, 'guide-audio')).toBe('ignored');
    expect(support(eleven, 'seed')).toBe('ignored');

    const stability = describeAudioEngine(fromPreset('stability-audio'));
    expect(stability!.processes).toContain('follow-guide');
    expect(support(stability, 'guide-audio')).toBe('used');
    expect(support(stability, 'strength')).toBe('used');
    expect(support(stability, 'lyrics')).toBe('ignored');

    const lyria = describeAudioEngine(fromPreset('google-lyria'));
    expect(support(lyria, 'takes')).toBe('used');
    expect(support(lyria, 'duration')).toBe('ignored');
  });

  it('shows current setting values and defaults', () => {
    const view = describeAudioEngine(fromPreset('stability-audio', { steps: 50, outputFormat: 'mp3' }));
    const byKey = Object.fromEntries(view!.settings.map((s) => [s.key, s]));
    expect(byKey.steps.value).toBe(50);
    expect(byKey.outputFormat.value).toBe('mp3');
    expect(byKey.outputFormat.defaultValue).toBe('wav');
    expect(byKey['config.defaultModel'].value).toBe('stable-audio-2');
    expect(byKey.cfgScale.value).toBeUndefined();
  });

  it('derives a local bridge’s inputs from the capabilities it reports', () => {
    const base = fromPreset('custom-audio-http');
    const textOnly = describeAudioEngine({ ...base, capabilities: ['TEXT_TO_MUSIC'] });
    expect(textOnly!.processes).toEqual(['text-to-music']);
    expect(support(textOnly, 'guide-audio')).toBe('ignored');
    expect(support(textOnly, 'lyrics')).toBe('ignored');

    const full = describeAudioEngine(fromPreset('ace-step-local'));
    expect(full!.processes).toEqual(
      expect.arrayContaining(['song-with-vocals', 'follow-guide', 'transform', 'inpaint', 'extend']),
    );
    expect(support(full, 'guide-audio')).toBe('used');
    expect(support(full, 'reference-audio')).toBe('used');
    expect(support(full, 'region')).toBe('used');
  });

  it('does not change the shared profile when capabilities are narrowed', () => {
    const src = fromPreset('elevenlabs-music');
    const narrowed = describeAudioEngine({ ...src, capabilities: ['TEXT_TO_MUSIC', 'INSTRUMENTAL_ONLY'] });
    expect(support(narrowed, 'lyrics')).toBe('ignored');
    expect(narrowed!.processes).toEqual(['text-to-music']);
    expect(audioEngineProfile('elevenlabs-music')!.inputs.lyrics!.support).toBe('used');
  });

  it('describes the on-device engines', () => {
    const producer = describeAudioEngine({
      id: 'internal-producer',
      name: 'Built-in DSP producer',
      adapter: 'internal',
      location: 'internal',
      capabilities: [
        'STEM_GENERATION',
        'STEM_CONDITIONING',
        'MIDI_CONDITIONING',
        'AUDIO_TO_AUDIO',
        'STEM_OUTPUT',
      ],
    });
    expect(producer!.processes).toEqual(['render-composition', 'transform']);
    expect(describeAudioEngine({ ...producer!, capabilities: [], id: 'internal-composer' })).toBeUndefined();
  });

  it('maps capabilities to processes', () => {
    expect(processesForCapabilities(['SINGING_SYNTHESIS'])).toEqual(['singing']);
    expect(processesForCapabilities(['TEXT_TO_MUSIC', 'STEM_CONDITIONING'])).toEqual([
      'follow-guide',
      'text-to-music',
    ]);
    expect(new Set(AUDIO_PROCESSES.map((p) => p.id)).size).toBe(AUDIO_PROCESSES.length);
    expect(new Set(AUDIO_INPUTS.map((i) => i.id)).size).toBe(AUDIO_INPUTS.length);
  });
});
