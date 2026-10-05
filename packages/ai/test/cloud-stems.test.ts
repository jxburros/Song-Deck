import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { configFromPreset, createProvider, stemNameFrom } from '../src';
import { bodyJson, bytesResponse, depsWith, FAKE_WAV, jsonResponse, mockFetch } from './helpers';

const audio = { mimeType: 'audio/wav', data: FAKE_WAV, durationSeconds: 60 };

describe('cloud stem separation', () => {
  it('normalises stem names from files and labels', () => {
    expect(stemNameFrom('stems/Vocals.mp3')).toBe('vocals');
    expect(stemNameFrom('no_vocals.wav')).toBe('instrumental');
    expect(stemNameFrom('drum')).toBe('drums');
    expect(stemNameFrom('Electric Guitar.mp3')).toBe('guitar');
    expect(stemNameFrom('Other.mp3')).toBe('other');
  });

  it('ElevenLabs: multipart upload, six stems by default, ZIP unpacked into named stems', async () => {
    const zip = zipSync({
      'vocals.mp3': new Uint8Array([1, 2]),
      'drums.mp3': new Uint8Array([3]),
      'bass.mp3': new Uint8Array([4]),
      'other.mp3': new Uint8Array([5]),
      '__MACOSX/._x': new Uint8Array([9]),
    });
    const m = mockFetch(() => bytesResponse(zip, 'application/zip'));
    const inst = createProvider(
      configFromPreset('elevenlabs-music'),
      depsWith(m.fetch, { 'provider:elevenlabs-music': 'sk_x' }),
    );
    const res = await inst.separation!.separateStems({ audio });
    const call = m.calls[0];
    expect(call.url).toBe('https://api.elevenlabs.io/v1/music/stem-separation?output_format=mp3_44100_192');
    expect(call.headers.get('xi-api-key')).toBe('sk_x');
    expect(call.body).toContain('six_stems_v1');
    expect(Object.keys(res.stems).sort()).toEqual(['bass', 'drums', 'other', 'vocals']);
    expect(res.stems.vocals.mimeType).toBe('audio/mpeg');
    expect([...res.stems.vocals.data]).toEqual([1, 2]);
    await inst.separation!.separateStems({ audio, stems: ['vocals'] });
    expect(m.calls[1].body).toContain('two_stems_v1');
  });

  it('AudioShake: asset upload → task with one target per stem → poll → download links', async () => {
    let polls = 0;
    const m = mockFetch((call) => {
      if (call.url === 'https://api.audioshake.ai/assets') return jsonResponse({ id: 'asset-1' });
      if (call.url === 'https://api.audioshake.ai/tasks') return jsonResponse({ id: 'task-1' });
      if (call.url === 'https://api.audioshake.ai/tasks/task-1')
        return jsonResponse({
          id: 'task-1',
          targets: ['vocals', 'drums', 'bass', 'other'].map((model) => ({
            model,
            status: ++polls > 4 ? 'completed' : 'processing',
            output: [{ format: 'wav', link: `https://files.audioshake.ai/${model}.wav?sig=1` }],
          })),
        });
      if (call.url.startsWith('https://files.audioshake.ai/')) return bytesResponse(FAKE_WAV);
      return jsonResponse({}, 404);
    });
    const inst = createProvider(
      configFromPreset('audioshake', { extra: { pollIntervalMs: 0 } }),
      depsWith(m.fetch, { 'provider:audioshake': 'as-key' }),
    );
    const res = await inst.separation!.separateStems({ audio });
    expect(m.calls[0].headers.get('x-api-key')).toBe('as-key');
    expect(bodyJson(m.calls[1])).toEqual({
      assetId: 'asset-1',
      targets: ['drums', 'bass', 'vocals', 'other'].map((model) => ({ model, formats: ['wav'] })),
    });
    expect(Object.keys(res.stems).sort()).toEqual(['bass', 'drums', 'other', 'vocals']);
    const downloads = m.calls.filter((c) => c.url.startsWith('https://files.audioshake.ai/'));
    expect(downloads).toHaveLength(4);
    expect(downloads.every((c) => !c.headers.get('x-api-key'))).toBe(true);
  });

  it('LALAL.AI: raw upload, one split per stem, batch check, stem tracks only', async () => {
    let checks = 0;
    const m = mockFetch((call) => {
      if (call.url.endsWith('/upload/')) return jsonResponse({ id: 'src-1' });
      if (call.url.endsWith('/split/stem_separator/')) {
        const stem = (bodyJson(call).presets as { stem: string }).stem;
        return jsonResponse({ task_id: `t-${stem}` });
      }
      if (call.url.endsWith('/check/')) {
        const ids = bodyJson(call).task_ids as string[];
        return jsonResponse({
          result: Object.fromEntries(
            ids.map((id) => [
              id,
              ++checks > 3
                ? {
                    status: 'success',
                    result: {
                      tracks: [
                        { type: 'stem', label: id.slice(2), url: `https://d.lalal.ai/${id}-stem.wav` },
                        { type: 'back', label: 'back', url: `https://d.lalal.ai/${id}-back.wav` },
                      ],
                    },
                  }
                : { status: 'progress', progress: 10 },
            ]),
          ),
        });
      }
      if (call.url.startsWith('https://d.lalal.ai/')) return bytesResponse(FAKE_WAV);
      return jsonResponse({}, 404);
    });
    const inst = createProvider(
      configFromPreset('lalal', { extra: { pollIntervalMs: 0 } }),
      depsWith(m.fetch, { 'provider:lalal': 'lic' }),
    );
    const res = await inst.separation!.separateStems({ audio });
    const upload = m.calls[0];
    expect(upload.url).toBe('https://www.lalal.ai/api/v1/upload/');
    expect(upload.headers.get('x-license-key')).toBe('lic');
    expect(upload.headers.get('content-disposition')).toBe('attachment; filename="mix.wav"');
    const splits = m.calls.filter((c) => c.url.endsWith('/split/stem_separator/')).map((c) => bodyJson(c));
    expect(splits.map((b) => (b.presets as { stem: string }).stem)).toEqual(['drum', 'bass', 'vocals']);
    expect(splits[0]).toMatchObject({
      source_id: 'src-1',
      presets: { extraction_level: 'deep_extraction', splitter: 'auto' },
    });
    expect(Object.keys(res.stems).sort()).toEqual(['bass', 'drums', 'vocals']);
    expect(m.calls.some((c) => c.url.includes('-back.wav'))).toBe(false);
  });
});
