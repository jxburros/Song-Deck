import { describe, expect, it } from 'vitest';
import { configFromPreset, createProvider } from '../src';
import { bodyJson, depsWith, FAKE_WAV, jsonResponse, mockFetch } from './helpers';

const audio = { mimeType: 'audio/wav', data: FAKE_WAV };

describe('separation vocabulary and validation', () => {
  it('requests all stems advertised by a bridge and honours explicit subsets', async () => {
    const stems = ['drums', 'bass', 'vocals', 'other', 'guitar', 'piano', 'strings'];
    const m = mockFetch((call) =>
      call.url.endsWith('/info')
        ? jsonResponse({ stems })
        : jsonResponse({ stems: Object.fromEntries(stems.map((s) => [s, 'UklGRg=='])), model: 'extended' }),
    );
    const provider = createProvider(configFromPreset('demucs-local'), depsWith(m.fetch));
    expect(Object.keys((await provider.separation!.separateStems({ audio })).stems)).toEqual(stems);
    expect(bodyJson(m.calls[1]).stems).toEqual(stems);
    await provider.separation!.separateStems({ audio, stems: ['vocals'] });
    expect(m.calls).toHaveLength(3);
    expect(bodyJson(m.calls[2]).stems).toEqual(['vocals']);
  });

  it('supports old bridges without discovery and rejects empty results', async () => {
    const m = mockFetch((call) =>
      call.url.endsWith('/info') ? jsonResponse({}, 404) : jsonResponse({ stems: {} }),
    );
    const provider = createProvider(configFromPreset('demucs-local'), depsWith(m.fetch));
    await expect(provider.separation!.separateStems({ audio })).rejects.toThrow(/no usable stems/);
    expect(bodyJson(m.calls[1]).stems).toEqual(['drums', 'bass', 'vocals', 'other']);
  });
});

it('sanitizes malformed transcription results at the provider boundary', async () => {
  const m = mockFetch(() =>
    jsonResponse({
      tempo: -1,
      notes: [
        null,
        { pitch: 60, start: -1, end: -0.1 },
        { pitch: 61, start: -0.1, end: 0.5, velocity: 'bad', confidence: 'bad' },
        { pitch: 62, start: 1, end: 0.5 },
      ],
    }),
  );
  const provider = createProvider(configFromPreset('basic-pitch-local'), depsWith(m.fetch));
  const result = await provider.transcription!.transcribeNotes({ audio });
  expect(result.notes).toEqual([{ pitch: 61, start: 0, end: 0.5, velocity: 80, confidence: 0.5 }]);
  expect(result.tempo).toBeUndefined();
});

it.each([
  ['singing', 'vocals'],
  ['humming', 'vocals'],
  ['full-mix', 'mix'],
  ['isolated', 'other'],
  ['bass', 'bass'],
])('translates the studio source %s into the bridge source %s', async (source, expected) => {
  const m = mockFetch(() => jsonResponse({ notes: [] }));
  const provider = createProvider(configFromPreset('basic-pitch-local'), depsWith(m.fetch));
  await provider.transcription!.transcribeNotes({ audio, source });
  expect(bodyJson(m.calls[0]).source).toBe(expected);
});

it('honours explicitly cleared blueprint tags instead of restoring defaults', async () => {
  const { parseBlueprintJson } = await import('../src/composition');
  const { defaultBlueprint } = await import('@songdeck/core');
  const defaults = defaultBlueprint({ tags: ['warm'] });
  expect(parseBlueprintJson({ tags: [] }, { defaults }).value?.blueprint.tags).toBeUndefined();
  expect(parseBlueprintJson({}, { defaults }).value?.blueprint.tags).toEqual(['warm']);
});
