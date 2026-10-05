import { describe, expect, it } from 'vitest';
import {
  configFromPreset,
  createProvider,
  normalizeLyricTags,
  taggedLyrics,
  type MusicGenerationRequest,
} from '../src';
import { bodyJson, bytesResponse, depsWith, FAKE_WAV, jsonResponse, mockFetch } from './helpers';

const sections: MusicGenerationRequest['sections'] = [
  { name: 'Intro', kind: 'intro', startSeconds: 0, endSeconds: 8, lines: [] },
  { name: 'Verse 1', kind: 'verse', startSeconds: 8, endSeconds: 24, lines: ['line one', 'line two'] },
  { name: 'Chorus 1', kind: 'chorus', startSeconds: 24, endSeconds: 40, lines: ['sing it'] },
];

describe('cloud full-song generators', () => {
  it('tagged lyrics come from the sections, with bare tags for instrumental sections', () => {
    expect(taggedLyrics({ prompt: '', durationSeconds: 40, sections }, 5000)).toBe(
      '[Intro]\n\n[Verse]\nline one\nline two\n\n[Chorus]\nsing it',
    );
    expect(normalizeLyricTags('[verse]\na\n[CHORUS 2]\nb')).toBe('[Verse]\na\n[Chorus]\nb');
    expect(
      taggedLyrics({ prompt: '', durationSeconds: 1, lyrics: 'x'.repeat(10) + '\n' + 'y'.repeat(10) }, 15),
    ).toBe('x'.repeat(10));
  });

  it('MiniMax: hex audio inline, tagged lyrics, prompt hints, error codes', async () => {
    const hex = Array.from(FAKE_WAV, (b) => b.toString(16).padStart(2, '0')).join('');
    let n = 0;
    const m = mockFetch(() =>
      n++ === 0
        ? jsonResponse({
            data: { audio: hex, status: 2 },
            extra_info: { music_duration: 95_000, music_sample_rate: 44100 },
            base_resp: { status_code: 0, status_msg: 'success' },
          })
        : jsonResponse({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }),
    );
    const inst = createProvider(
      configFromPreset('minimax-music'),
      depsWith(m.fetch, { 'provider:minimax-music': 'k' }),
    );
    const res = await inst.audioGeneration!.generateMusic({
      prompt: 'dreamy indie pop',
      durationSeconds: 40,
      bpm: 96,
      key: 'A minor',
      sections,
    });
    const call = m.calls[0];
    expect(call.url).toBe('https://api.minimax.io/v1/music_generation');
    expect(call.headers.get('authorization')).toBe('Bearer k');
    const body = bodyJson(call);
    expect(body.model).toBe('music-2.6');
    expect(body.prompt).toBe('dreamy indie pop. 96 BPM, key of A minor');
    expect(body.lyrics).toContain('[Verse]\nline one');
    expect(body.output_format).toBe('hex');
    expect(body).not.toHaveProperty('is_instrumental');
    expect([...res.audio.data]).toEqual([...FAKE_WAV]);
    expect(res.audio.mimeType).toBe('audio/mpeg');
    expect(res.durationSeconds).toBe(95);
    expect(res.costUsd).toBe(0.15);
    await expect(
      inst.audioGeneration!.generateMusic({ prompt: 'x', durationSeconds: 10, instrumental: true }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(bodyJson(m.calls[1]).is_instrumental).toBe(true);
  });

  it('Mureka: submit → poll → download every take without credentials', async () => {
    let polls = 0;
    const m = mockFetch((call) => {
      if (call.url.endsWith('/v1/song/generate')) return jsonResponse({ id: 'task-1', status: 'preparing' });
      if (call.url.includes('/v1/song/query/task-1'))
        return jsonResponse(
          ++polls < 2
            ? { id: 'task-1', status: 'running' }
            : {
                id: 'task-1',
                status: 'succeeded',
                model: 'mureka-9',
                choices: [
                  { url: 'https://cdn.mureka.ai/a.mp3', duration: 61_000 },
                  { url: 'https://cdn.mureka.ai/b.mp3', duration: 60_000 },
                ],
              },
        );
      if (call.url.startsWith('https://cdn.mureka.ai/')) return bytesResponse(FAKE_WAV, 'audio/mpeg');
      return jsonResponse({ error: 'unexpected' }, 404);
    });
    const config = configFromPreset('mureka', {
      extra: { downloadHosts: ['*.mureka.ai'], pollIntervalMs: 0 },
    });
    const inst = createProvider(config, depsWith(m.fetch, { 'provider:mureka': 'mk' }));
    const res = await inst.audioGeneration!.generateMusic({
      prompt: 'rock',
      durationSeconds: 60,
      sections,
      samples: 2,
    });
    expect(bodyJson(m.calls[0])).toMatchObject({ model: 'auto', n: 2 });
    expect(String(bodyJson(m.calls[0]).lyrics)).toContain('[Chorus]\nsing it');
    const downloads = m.calls.filter((c) => c.url.startsWith('https://cdn.mureka.ai/'));
    expect(downloads).toHaveLength(2);
    expect(downloads.every((c) => !c.headers.get('authorization'))).toBe(true);
    expect(m.calls[1].headers.get('authorization')).toBe('Bearer mk');
    expect(res.durationSeconds).toBe(61);
    expect(res.alternatives).toHaveLength(1);
    expect(res.model).toBe('mureka-9');
  });

  it('Mureka: instrumental endpoint without lyrics and a clear failure message', async () => {
    const m = mockFetch((call) =>
      call.url.endsWith('/v1/instrumental/generate')
        ? jsonResponse({ id: 't2' })
        : jsonResponse({ id: 't2', status: 'failed', failed_reason: 'content policy' }),
    );
    const inst = createProvider(
      configFromPreset('mureka', { extra: { pollIntervalMs: 0 } }),
      depsWith(m.fetch, { 'provider:mureka': 'mk' }),
    );
    await expect(
      inst.audioGeneration!.generateMusic({ prompt: 'ambient', durationSeconds: 30, instrumental: true }),
    ).rejects.toThrow(/failed: content policy/);
    expect(m.calls[1].url).toBe('https://api.mureka.ai/v1/instrumental/query/t2');
  });
});
