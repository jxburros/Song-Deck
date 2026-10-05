import { describe, expect, it } from 'vitest';
import {
  configFromPreset,
  createProvider,
  decodeMultipart,
  finalizeLyrics,
  groupWordsIntoSegments,
  Orchestrator,
  ProviderRegistry,
  CapabilityRouter,
  type ProviderConfig,
} from '../src';
import { bodyJson, depsWith, FAKE_WAV, jsonResponse, mockFetch } from './helpers';

const audio = { mimeType: 'audio/wav', data: FAKE_WAV, durationSeconds: 120 };

function parts(call: { bytes?: Uint8Array; headers: Headers }) {
  const decoded = decodeMultipart(call.bytes!, call.headers.get('content-type')!);
  const values = (name: string) =>
    decoded
      .filter((p) => p.name === name)
      .map((p) => (p.filename ? p.filename : new TextDecoder().decode(p.data)));
  return { decoded, values };
}

describe('lyrics transcription adapters', () => {
  it('OpenAI: whisper-1 verbose_json with word + segment timings, words attached to segments, cost per minute', async () => {
    const m = mockFetch(() =>
      jsonResponse({
        text: 'Hello darkness my old friend',
        language: 'english',
        duration: 120,
        segments: [
          { start: 0.5, end: 2, text: ' Hello darkness' },
          { start: 3, end: 4.5, text: ' my old friend' },
        ],
        words: [
          { word: 'Hello', start: 0.5, end: 1 },
          { word: 'darkness', start: 1.1, end: 2 },
          { word: 'my', start: 3, end: 3.3 },
          { word: 'old', start: 3.4, end: 3.8 },
          { word: 'friend', start: 3.9, end: 4.5 },
        ],
      }),
    );
    const inst = createProvider(configFromPreset('openai'), depsWith(m.fetch, { 'provider:openai': 'sk-x' }));
    expect(inst.lyricTranscription).toBeDefined();
    const res = await inst.lyricTranscription!.transcribeLyrics({
      audio,
      language: 'en',
      prompt: 'old friend',
    });
    const call = m.calls[0];
    expect(call.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(call.headers.get('authorization')).toBe('Bearer sk-x');
    const p = parts(call);
    expect(p.values('model')).toEqual(['whisper-1']);
    expect(p.values('response_format')).toEqual(['verbose_json']);
    expect(p.values('timestamp_granularities[]')).toEqual(['word', 'segment']);
    expect(p.values('language')).toEqual(['en']);
    expect(p.values('prompt')).toEqual(['old friend']);
    expect(p.values('file')).toEqual(['vocals.wav']);
    expect(res.language).toBe('en');
    expect(res.wordTimestamps).toBe(true);
    expect(res.segments).toHaveLength(2);
    expect(res.segments[1].words!.map((w) => w.word)).toEqual(['my', 'old', 'friend']);
    expect(res.segments[0].text).toBe('Hello darkness');
    expect(res.costUsd).toBeCloseTo(0.012, 6);
  });

  it('OpenAI: gpt-4o-transcribe only returns text (json, no timings)', async () => {
    const m = mockFetch(() => jsonResponse({ text: 'la la la' }));
    const config: ProviderConfig = configFromPreset('openai', {
      extra: { transcriptionModel: 'gpt-4o-transcribe' },
    });
    const inst = createProvider(config, depsWith(m.fetch, { 'provider:openai': 'sk-x' }));
    const res = await inst.lyricTranscription!.transcribeLyrics({ audio, model: 'gpt-5' });
    const p = parts(m.calls[0]);
    expect(p.values('model')).toEqual(['gpt-4o-transcribe']);
    expect(p.values('response_format')).toEqual(['json']);
    expect(p.values('timestamp_granularities[]')).toEqual([]);
    expect(res.wordTimestamps).toBe(false);
    expect(res.text).toBe('la la la');
  });

  it('OpenAI: rejects uploads over 25 MB before sending', async () => {
    const m = mockFetch(() => jsonResponse({ text: '' }));
    const inst = createProvider(configFromPreset('openai'), depsWith(m.fetch, { 'provider:openai': 'sk-x' }));
    await expect(
      inst.lyricTranscription!.transcribeLyrics({
        audio: { mimeType: 'audio/wav', data: new Uint8Array(26 * 1024 * 1024) },
      }),
    ).rejects.toThrow(/25 MB/);
    expect(m.calls).toHaveLength(0);
  });

  it('Groq: whisper-large-v3-turbo by default', async () => {
    const m = mockFetch(() => jsonResponse({ text: 'x', words: [{ word: 'x', start: 0, end: 0.2 }] }));
    const inst = createProvider(configFromPreset('groq'), depsWith(m.fetch, { 'provider:groq': 'gsk_x' }));
    await inst.lyricTranscription!.transcribeLyrics({ audio });
    expect(m.calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(parts(m.calls[0]).values('model')).toEqual(['whisper-large-v3-turbo']);
  });

  it('ElevenLabs Scribe: words only (spacing/events dropped), phrases split at pauses', async () => {
    const m = mockFetch(() =>
      jsonResponse({
        language_code: 'en',
        text: 'Hold on. Let go',
        words: [
          { text: 'Hold', start: 0, end: 0.3, type: 'word', logprob: -0.1 },
          { text: ' ', start: 0.3, end: 0.35, type: 'spacing' },
          { text: 'on.', start: 0.35, end: 0.8, type: 'word' },
          { text: '(music)', start: 0.8, end: 2, type: 'audio_event' },
          { text: 'Let', start: 3, end: 3.2, type: 'word' },
          { text: 'go', start: 3.2, end: 3.9, type: 'word' },
        ],
      }),
    );
    const inst = createProvider(
      configFromPreset('elevenlabs-music'),
      depsWith(m.fetch, { 'provider:elevenlabs-music': 'sk_x' }),
    );
    const res = await inst.lyricTranscription!.transcribeLyrics({ audio, language: 'en' });
    expect(m.calls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(m.calls[0].headers.get('xi-api-key')).toBe('sk_x');
    const p = parts(m.calls[0]);
    expect(p.values('model_id')).toEqual(['scribe_v1']);
    expect(p.values('timestamps_granularity')).toEqual(['word']);
    expect(p.values('language_code')).toEqual(['en']);
    expect(res.segments.map((s) => s.text)).toEqual(['Hold on.', 'Let go']);
    expect(res.segments[0].words![0].confidence).toBeCloseTo(Math.exp(-0.1), 6);
  });

  it('local lyrics bridge contract', async () => {
    const m = mockFetch(() =>
      jsonResponse({
        text: 'one two',
        language: 'en',
        model: 'large-v3-turbo',
        segments: [
          {
            start: 0,
            end: 1,
            text: 'one two',
            words: [
              { word: 'one', start: 0, end: 0.4, confidence: 0.9 },
              { word: 'two', start: 0.5, end: 1, confidence: 1.4 },
            ],
          },
        ],
      }),
    );
    const inst = createProvider(configFromPreset('whisper-local'), depsWith(m.fetch));
    const res = await inst.lyricTranscription!.transcribeLyrics({
      audio,
      prompt: 'one two',
      wordTimestamps: true,
    });
    expect(m.calls[0].url).toBe('http://127.0.0.1:8816/transcribe_lyrics');
    const body = bodyJson(m.calls[0]);
    expect(body.prompt).toBe('one two');
    expect(body.word_timestamps).toBe(true);
    expect(typeof body.audio_base64).toBe('string');
    expect(res.model).toBe('large-v3-turbo');
    expect(res.segments[0].words![1].confidence).toBe(1);
  });

  it('helpers: grouping and clean-up', () => {
    const segs = groupWordsIntoSegments([
      { word: 'b', start: 0.5, end: 0.7 },
      { word: 'a', start: 0, end: 0.4 },
      { word: 'c', start: 2, end: 2.2 },
      { word: '  ', start: 3, end: 3.1 },
      { word: 'bad', start: 5, end: 4 },
    ]);
    expect(segs.map((s) => s.text)).toEqual(['a b', 'c']);
    const res = finalizeLyrics([
      { start: 1, end: 2, text: '' },
      { start: 0, end: 1, text: ' hi ' },
    ]);
    expect(res.segments.map((s) => s.text)).toEqual(['hi']);
    expect(res.wordTimestamps).toBe(false);
  });

  it('routes the lyric-transcription role to OpenAI even when only chat models are listed', async () => {
    const m = mockFetch((call) =>
      call.url.endsWith('/models')
        ? jsonResponse({ data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] })
        : jsonResponse({ text: 'hey', words: [{ word: 'hey', start: 0, end: 0.3 }] }),
    );
    const registry = new ProviderRegistry({ deps: depsWith(m.fetch, { 'provider:openai': 'sk-x' }) });
    registry.configure([configFromPreset('openai', { defaultModel: 'gpt-5' })]);
    await registry.discoverModels('openai');
    const orch = new Orchestrator({ registry, router: new CapabilityRouter(registry) });
    const run = await orch.transcribeLyrics({ audio }, { skipConfirm: true });
    expect(run.result.text).toBe('hey');
    expect(m.calls.at(-1)!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(parts(m.calls.at(-1)!).values('model')).toEqual(['whisper-1']);
  });
});
