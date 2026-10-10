import { songDurationSeconds } from '@songdeck/core';
import { describe, expect, it } from 'vitest';
import {
  buildElevenLabsCompositionPlan,
  buildMusicGenerationRequest,
  buildSingingRequest,
  ConsentRequiredError,
  configFromPreset,
  createProvider,
  decodeMultipart,
  lyriaPredictUrl,
  normalizeCapabilities,
} from '../src';
import { bodyJson, bytesResponse, depsWith, FAKE_WAV, jsonResponse, makeSong, mockFetch } from './helpers';

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

describe('ElevenLabs Music', () => {
  it('builds a composition plan whose durations sum to the song length (tempo map aware)', () => {
    const song = makeSong({ chorusBpm: 90 });
    const plan = buildElevenLabsCompositionPlan(song);
    const totalMs = Math.round(songDurationSeconds(song) * 1000);
    // Intro 4 bars + Verse 8 bars @120 = 24 s; Chorus 8 bars + Outro 4 bars @90 = 32 s.
    expect(totalMs).toBe(56000);
    expect(plan.sections.map((s) => s.section_name)).toEqual(['Intro', 'Verse 1', 'Chorus 1', 'Outro']);
    expect(plan.sections.map((s) => s.duration_ms)).toEqual([8000, 16000, 21333, 10667]);
    expect(plan.sections.reduce((a, s) => a + s.duration_ms, 0)).toBe(totalMs);
    expect(plan.sections[1].lines).toEqual([
      'I walk alone through the night',
      'Counting the lights on the water',
    ]);
    expect(plan.sections[2].lines).toEqual(['Fire in the sky', 'Carry me home']);
    expect(plan.sections[0].lines).toEqual([]);
    expect(plan.sections[0].negative_local_styles).toContain('vocals');
    expect(plan.sections[2].positive_local_styles).toEqual(
      expect.arrayContaining(['chorus', 'Emotional release', 'peak energy, full arrangement']),
    );
    expect(plan.positive_global_styles).toEqual(
      expect.arrayContaining([
        'Emo',
        'Pop-punk',
        'Melancholy verses',
        'Bass',
        'Drums',
        'tenor lead vocal',
        'warm analog tape',
        '120 bpm',
        'E minor',
      ]),
    );
    expect(plan.negative_global_styles).toEqual(['lo-fi noise']);
  });

  it('instrumental songs get no lines and "vocals" as a negative global style; short sections merge', () => {
    const song = makeSong({ instrumental: true });
    song.sections[0].bars = 1; // 2 s intro < 3 s minimum → merged into the verse
    const plan = buildElevenLabsCompositionPlan(song);
    expect(plan.negative_global_styles).toContain('vocals');
    expect(plan.sections.every((s) => s.lines.length === 0)).toBe(true);
    expect(plan.sections[0].section_name).toBe('Intro + Verse 1');
    expect(plan.sections.reduce((a, s) => a + s.duration_ms, 0)).toBe(
      Math.round(songDurationSeconds(song) * 1000),
    );
    expect(plan.sections.every((s) => s.duration_ms >= 3000)).toBe(true);
  });

  it('POSTs /music with xi-api-key, output_format and the composition plan', async () => {
    const m = mockFetch(() => bytesResponse(FAKE_WAV, 'audio/mpeg'));
    const inst = createProvider(
      configFromPreset('elevenlabs-music'),
      depsWith(m.fetch, { 'provider:elevenlabs-music': 'xi-secret-key' }),
    );
    const song = makeSong();
    const res = await inst.audioGeneration!.generateMusic(buildMusicGenerationRequest(song));
    const call = m.calls[0];
    expect(call.url).toBe('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128');
    expect(call.headers.get('xi-api-key')).toBe('xi-secret-key');
    const body = bodyJson(call) as Record<string, any>;
    expect(body.model_id).toBe('music_v1');
    expect(body.composition_plan.sections).toHaveLength(4);
    expect(body).not.toHaveProperty('prompt');
    expect(res.audio.mimeType).toBe('audio/mpeg');
    expect(res.audio.data).toEqual(FAKE_WAV);
    expect(res.durationSeconds).toBe(48);

    // Prompt mode when no song/sections are supplied.
    await inst.audioGeneration!.generateMusic({
      prompt: 'dreamy synthwave',
      durationSeconds: 5,
      instrumental: true,
    });
    const body2 = bodyJson(m.calls[1]) as Record<string, any>;
    expect(body2).toEqual({
      prompt: 'dreamy synthwave',
      music_length_ms: 10000,
      force_instrumental: true,
      model_id: 'music_v1',
    });
  });
});

describe('Stability Stable Audio', () => {
  it('sends multipart text-to-audio with bearer auth and accept audio/*', async () => {
    const m = mockFetch(() => bytesResponse(FAKE_WAV, 'audio/wav', { seed: '1234' }));
    const cfg = configFromPreset('stability-audio', {
      extra: { outputFormat: 'wav', steps: 50, cfgScale: 7 },
    });
    const inst = createProvider(
      cfg,
      depsWith(m.fetch, { 'provider:stability-audio': 'sk-stability-0123456789abcdef' }),
    );
    const res = await inst.audioGeneration!.generateMusic({
      prompt: 'epic orchestral',
      negativePrompt: 'vocals',
      durationSeconds: 30.4,
      seed: 42,
    });
    const call = m.calls[0];
    expect(call.url).toBe('https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio');
    expect(call.headers.get('authorization')).toBe('Bearer sk-stability-0123456789abcdef');
    expect(call.headers.get('accept')).toBe('audio/*');
    const ct = call.headers.get('content-type')!;
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    const fields = Object.fromEntries(decodeMultipart(call.bytes!, ct).map((p) => [p.name, p.text]));
    expect(fields).toEqual({
      prompt: 'epic orchestral. Avoid: vocals',
      duration: '30',
      seed: '42',
      steps: '50',
      cfg_scale: '7',
      output_format: 'wav',
      model: 'stable-audio-2',
    });
    expect(res.seed).toBe(1234);
    expect(res.costUsd).toBe(0.2);
  });

  it('audio-to-audio sends the audio file and strength', async () => {
    const m = mockFetch(() => bytesResponse(FAKE_WAV, 'audio/wav'));
    const inst = createProvider(
      configFromPreset('stability-audio'),
      depsWith(m.fetch, { 'provider:stability-audio': 'sk-stability-0123456789abcdef' }),
    );
    await inst.audioGeneration!.transformAudio({
      audio: { mimeType: 'audio/wav', data: FAKE_WAV },
      prompt: 'produced rock guitar',
      strength: 0.35,
      durationSeconds: 20,
    });
    const call = m.calls[0];
    expect(call.url).toBe('https://api.stability.ai/v2beta/audio/stable-audio-2/audio-to-audio');
    const parts = decodeMultipart(call.bytes!, call.headers.get('content-type')!);
    const audio = parts.find((p) => p.name === 'audio')!;
    expect(audio.filename).toBe('input.wav');
    expect(audio.contentType).toBe('audio/wav');
    expect([...audio.data]).toEqual([...FAKE_WAV]);
    expect(parts.find((p) => p.name === 'strength')!.text).toBe('0.35');
  });
});

describe('Google Lyria (Vertex AI)', () => {
  it('posts the predict body with an OAuth bearer token and decodes predictions', async () => {
    const m = mockFetch(() =>
      jsonResponse({
        predictions: [
          { bytesBase64Encoded: b64(FAKE_WAV), mimeType: 'audio/wav' },
          { bytesBase64Encoded: b64(new Uint8Array([1, 2, 3])) },
        ],
      }),
    );
    const cfg = configFromPreset('google-lyria', {
      extra: { vertexProject: 'my-proj', vertexLocation: 'europe-west4' },
    });
    const inst = createProvider(
      cfg,
      depsWith(m.fetch, { 'provider:google-lyria': 'ya29.test-oauth-access-token-0123456789' }),
    );
    const res = await inst.audioGeneration!.generateMusic({
      prompt: 'calm piano',
      negativePrompt: 'drums',
      durationSeconds: 30,
      samples: 2,
    });
    const call = m.calls[0];
    expect(call.url).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/my-proj/locations/europe-west4/publishers/google/models/lyria-002:predict',
    );
    expect(call.headers.get('authorization')).toBe('Bearer ya29.test-oauth-access-token-0123456789');
    expect(bodyJson(call)).toEqual({
      instances: [{ prompt: 'calm piano', negative_prompt: 'drums' }],
      parameters: { sample_count: 2 },
    });
    expect(res.audio.data).toEqual(FAKE_WAV);
    expect(res.alternatives).toHaveLength(1);
    expect(res.costUsd).toBeCloseTo(0.12, 10);
    // seed and sample_count are mutually exclusive
    await inst.audioGeneration!.generateMusic({ prompt: 'x', durationSeconds: 30, seed: 9 });
    expect(bodyJson(m.calls[1])).toEqual({ instances: [{ prompt: 'x', seed: 9 }], parameters: {} });
    expect(() => lyriaPredictUrl(configFromPreset('google-lyria'), 'lyria-002')).toThrow(/project/);
  });
});

describe('Song Deck local bridge contracts', () => {
  it('music bridge: GET /info and POST /generate with the documented body', async () => {
    const m = mockFetch((call) => {
      if (call.url.endsWith('/info'))
        return jsonResponse({
          name: 'ACE-Step bridge',
          version: '1.5.0',
          models: [{ id: 'ace-step-v1.5', name: 'ACE-Step 1.5' }],
          capabilities: ['TEXT_TO_MUSIC', 'LYRIC_CONDITIONING', 'audio_to_audio', 'INPAINTING'],
          hardware: { min_vram_gb: 4 },
        });
      return bytesResponse(FAKE_WAV, 'audio/wav', { 'x-seed': '77', 'x-model': 'ace-step-v1.5' });
    });
    const inst = createProvider(configFromPreset('ace-step-local'), depsWith(m.fetch));
    const models = await inst.audioGeneration!.discoverModels();
    expect(m.calls[0].url).toBe('http://127.0.0.1:8810/info');
    expect(models[0].id).toBe('ace-step-v1.5');
    expect(models[0].capabilities).toEqual([
      'TEXT_TO_MUSIC',
      'LYRIC_CONDITIONING',
      'AUDIO_TO_AUDIO',
      'INPAINTING',
    ]);
    const req = buildMusicGenerationRequest(makeSong(), {
      seed: 5,
      guideAudio: { mimeType: 'audio/wav', data: FAKE_WAV },
      strength: 0.4,
    });
    const res = await inst.audioGeneration!.generateMusic(req);
    const gen = m.calls[1];
    expect(gen.url).toBe('http://127.0.0.1:8810/generate');
    const body = bodyJson(gen) as Record<string, any>;
    expect(body.duration_seconds).toBe(48);
    expect(body.seed).toBe(5);
    expect(body.bpm).toBe(120);
    expect(body.key).toBe('E minor');
    expect(body.instrumental).toBe(false);
    expect(body.lyrics).toContain('[verse]\nI walk alone through the night');
    expect(body.sections).toEqual([
      { name: 'Intro', start_seconds: 0, end_seconds: 8 },
      { name: 'Verse 1', start_seconds: 8, end_seconds: 24 },
      { name: 'Chorus 1', start_seconds: 24, end_seconds: 40 },
      { name: 'Outro', start_seconds: 40, end_seconds: 48 },
    ]);
    expect(body.guide_audio_base64).toBe(b64(FAKE_WAV));
    expect(body.strength).toBe(0.4);
    expect(res.seed).toBe(77);
    expect(res.model).toBe('ace-step-v1.5');
    expect(res.costUsd).toBe(0);

    await inst.audioGeneration!.inpaintAudio!({
      audio: { mimeType: 'audio/wav', data: FAKE_WAV },
      startSeconds: 24,
      endSeconds: 40,
      prompt: 'bigger chorus',
      seed: 3,
    });
    expect(m.calls[2].url).toBe('http://127.0.0.1:8810/inpaint');
    expect(bodyJson(m.calls[2])).toEqual({
      audio_base64: b64(FAKE_WAV),
      start_seconds: 24,
      end_seconds: 40,
      prompt: 'bigger chorus',
      seed: 3,
    });
    await inst.audioGeneration!.transformAudio({
      audio: { mimeType: 'audio/wav', data: FAKE_WAV },
      prompt: 'p',
      strength: 0.5,
      seed: 1,
    });
    expect(bodyJson(m.calls[3])).toEqual({
      audio_base64: b64(FAKE_WAV),
      prompt: 'p',
      strength: 0.5,
      seed: 1,
    });
    // OUTPAINTING not advertised → extend is unsupported
    await expect(
      inst.audioGeneration!.extendAudio!({
        audio: { mimeType: 'audio/wav', data: FAKE_WAV },
        prompt: 'p',
        durationSeconds: 10,
      }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('singing bridge: /voices and /synthesize with snake_case notes and expression', async () => {
    const m = mockFetch((call) => {
      if (call.url.endsWith('/voices'))
        return jsonResponse([
          { id: 'v1', name: 'Aria', voice_type: 'soprano', language: 'en', kind: 'stock' },
        ]);
      return bytesResponse(FAKE_WAV);
    });
    const inst = createProvider(configFromPreset('diffsinger-local'), depsWith(m.fetch));
    const voices = await inst.singing!.listVoices();
    expect(voices).toEqual([{ id: 'v1', name: 'Aria', voiceType: 'soprano', language: 'en', kind: 'stock' }]);
    const song = makeSong();
    const req = buildSingingRequest(song, 'trk_vox', {
      voiceId: 'v1',
      seed: 11,
      startTick: 4 * 1920,
      endTick: 5 * 1920,
    });
    expect(req.notes).toHaveLength(4);
    expect(req.notes[0].startSeconds).toBe(8);
    expect(req.notes[0].durationSeconds).toBe(0.5);
    await inst.singing!.synthesizeSinging(req);
    const body = bodyJson(m.calls[1]) as Record<string, any>;
    expect(m.calls[1].url).toBe('http://127.0.0.1:8811/synthesize');
    expect(body.voice_id).toBe('v1');
    expect(body.tempo_bpm).toBe(120);
    expect(body.sample_rate).toBe(44100);
    expect(body.seed).toBe(11);
    expect(body.notes[0]).toMatchObject({
      pitch: expect.any(Number),
      start_seconds: 8,
      duration_seconds: 0.5,
      velocity: 85,
    });
    expect(typeof body.notes[0].lyric).toBe('string');
    expect(body.notes[0].expression).toMatchObject({
      breathiness: 0.2,
      tension: 0.4,
      vibrato: 0.3,
      vibrato_rate: 5.5,
      onset: 'normal',
      release: 'normal',
    });
    await inst.singing!.regeneratePhrase!({ ...req, startSeconds: 8, endSeconds: 10 });
    const b2 = bodyJson(m.calls[2]) as Record<string, any>;
    expect(m.calls[2].url).toBe('http://127.0.0.1:8811/regenerate_phrase');
    expect(b2.start_seconds).toBe(8);
    expect(b2.end_seconds).toBe(10);
  });

  it('transcription, separation and mastering bridges', async () => {
    const m = mockFetch((call) => {
      if (call.url.endsWith('/info')) return jsonResponse({}, 404);
      if (call.url.endsWith('/transcribe'))
        return jsonResponse({
          notes: [
            { pitch: 64, start: 0.5, end: 1, velocity: 90, confidence: 0.9 },
            { pitch: 300, start: 2, end: 1, velocity: 1, confidence: 1 },
          ],
          tempo: 118.5,
          key: 'E minor',
        });
      if (call.url.endsWith('/separate'))
        return jsonResponse({
          stems: { drums: b64(FAKE_WAV), vocals: b64(new Uint8Array([9])) },
          model: 'htdemucs_ft',
        });
      return bytesResponse(FAKE_WAV);
    });
    const deps = depsWith(m.fetch);
    const tr = createProvider(configFromPreset('basic-pitch-local'), deps);
    const t = await tr.transcription!.transcribeNotes({
      audio: { mimeType: 'audio/wav', data: FAKE_WAV },
      source: 'bass',
    });
    expect(bodyJson(m.calls[0])).toEqual({ audio_base64: b64(FAKE_WAV), source: 'bass' });
    expect(t.notes).toEqual([{ pitch: 64, start: 0.5, end: 1, velocity: 90, confidence: 0.9 }]);
    expect(t.tempo).toBe(118.5);
    const sep = createProvider(configFromPreset('demucs-local'), deps);
    const s = await sep.separation!.separateStems({ audio: { mimeType: 'audio/wav', data: FAKE_WAV } });
    expect(bodyJson(m.calls[2])).toEqual({
      audio_base64: b64(FAKE_WAV),
      stems: ['drums', 'bass', 'vocals', 'other'],
    });
    expect(Object.keys(s.stems)).toEqual(['drums', 'vocals']);
    expect(s.stems.drums.data).toEqual(FAKE_WAV);
    expect(s.model).toBe('htdemucs_ft');
    const mas = createProvider(configFromPreset('mastering-local'), deps);
    await mas.mastering!.master({
      audio: { mimeType: 'audio/wav', data: FAKE_WAV },
      target: 'streaming',
      reference: { mimeType: 'audio/wav', data: new Uint8Array([7]) },
    });
    expect(m.calls[3].url).toBe('http://127.0.0.1:8815/master');
    expect(bodyJson(m.calls[3])).toEqual({
      audio_base64: b64(FAKE_WAV),
      target: 'streaming',
      reference_audio_base64: b64(new Uint8Array([7])),
    });
  });

  it('voice-conversion bridge enforces consent before any request', async () => {
    const m = mockFetch(() => bytesResponse(FAKE_WAV));
    const inst = createProvider(configFromPreset('rvc-local'), depsWith(m.fetch));
    const audio = { mimeType: 'audio/wav', data: FAKE_WAV };
    await expect(
      inst.voiceConversion!.convertVoice({ audio, targetVoice: { id: 'singer-x', kind: 'third-party' } }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    await expect(
      inst.voiceConversion!.convertVoice({
        audio,
        targetVoice: { id: 'me', kind: 'user-trained' },
        consent: {
          attestedBy: '',
          rightsHolder: 'Me',
          basis: 'own-voice',
          attestedAt: '2026-10-01T00:00:00Z',
        },
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(m.calls).toHaveLength(0);
    const ok = await inst.voiceConversion!.convertVoice({
      audio,
      targetVoice: { id: 'me', kind: 'user-trained' },
      consent: {
        attestedBy: 'Jeff',
        rightsHolder: 'Jeff',
        basis: 'own-voice',
        attestedAt: '2026-10-01T00:00:00Z',
      },
      pitchShift: 2,
    });
    expect(ok.voiceId).toBe('me');
    expect(bodyJson(m.calls[0])).toEqual({
      audio_base64: b64(FAKE_WAV),
      target_voice_id: 'me',
      pitch_shift: 2,
    });
    // Stock voices need no attestation.
    await inst.voiceConversion!.convertVoice({ audio, targetVoice: { id: 'stock-alto', kind: 'stock' } });
    expect(m.calls).toHaveLength(2);
  });

  it('normalizes capability names reported by bridges', () => {
    expect(
      normalizeCapabilities(['structured_output', 'text-input', 'AUDIO_INPUT', 'bogus', 'singing']),
    ).toEqual(['STRUCTURED_JSON', 'TEXT_INPUT', 'AUDIO_INPUT', 'SINGING_SYNTHESIS']);
  });
});
