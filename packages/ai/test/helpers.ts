import { createEmptySong, PPQ, type Note, type Song, type Track } from '@songdeck/core';
import {
  DirectTransport,
  MemoryCredentialStore,
  type CreateProviderDeps,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ModelInfo,
} from '../src';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
  bytes?: Uint8Array;
}

export type FetchHandler = (call: RecordedCall) => Response | Promise<Response>;

/** A recording fetch mock. */
export function mockFetch(handler: FetchHandler) {
  const calls: RecordedCall[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init.headers);
    let body: string | undefined;
    let bytes: Uint8Array | undefined;
    if (typeof init.body === 'string') body = init.body;
    else if (init.body instanceof Uint8Array) {
      bytes = init.body;
      body = new TextDecoder().decode(init.body);
    } else if (init.body instanceof ArrayBuffer) {
      bytes = new Uint8Array(init.body);
      body = new TextDecoder().decode(bytes);
    }
    const call: RecordedCall = { url, method: (init.method ?? 'GET').toUpperCase(), headers, body, bytes };
    calls.push(call);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return handler(call);
  };
  return { fetch: fn, calls };
}

export function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function bytesResponse(bytes: Uint8Array, contentType = 'audio/wav', headers: Record<string, string> = {}): Response {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Response(copy, { status: 200, headers: { 'content-type': contentType, ...headers } });
}

export const FAKE_WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0, 1, 2, 3, 255, 254]);

export function depsWith(fetchFn: (input: string, init?: RequestInit) => Promise<Response>, secrets: Record<string, string> = {}): CreateProviderDeps {
  return {
    transport: new DirectTransport(new MemoryCredentialStore(secrets), { fetch: fetchFn }),
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  };
}

export function bodyJson(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.body ?? '{}') as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

const BAR = PPQ * 4;

function note(id: string, pitch: number, bar0: number, beat0: number, beats: number, velocity = 90, extra: Partial<Note> = {}): Note {
  return { id, pitch, tick: bar0 * BAR + Math.round(beat0 * PPQ), duration: Math.round(beats * PPQ), velocity, ...extra };
}

export interface TestSongOptions {
  /** Tempo change (bpm) at the start of the chorus. */
  chorusBpm?: number;
  instrumental?: boolean;
}

/**
 * Intro (4) · Verse 1 (8) · Chorus 1 (8) · Outro (4) = 24 bars, 4/4, E minor, 120 BPM.
 * Tracks: Bass (8ths), Drums, Lead Vocal (with syllables in verse+chorus).
 */
export function makeSong(opts: TestSongOptions = {}): Song {
  const song = createEmptySong({ title: 'Test Song', bpm: 120, key: { tonic: 4, mode: 'minor' }, id: 'song_test', seed: 7 });
  song.sections = [
    { id: 'sec_intro', name: 'Intro', kind: 'intro', bars: 4, energy: 30, purpose: 'Establish motif' },
    { id: 'sec_v1', name: 'Verse 1', kind: 'verse', bars: 8, energy: 45, energyEnd: 55, purpose: 'Tell the story', mood: ['melancholy'] },
    { id: 'sec_ch1', name: 'Chorus 1', kind: 'chorus', bars: 8, energy: 85, purpose: 'Emotional release' },
    { id: 'sec_outro', name: 'Outro', kind: 'outro', bars: 4, energy: 25 },
  ];
  if (opts.chorusBpm) song.tempoMap = [{ tick: 0, bpm: 120 }, { tick: 12 * BAR, bpm: opts.chorusBpm }];
  const prog = [
    { root: 4, quality: 'min' as const, symbol: 'Em', roman: 'i' },
    { root: 0, quality: 'maj' as const, symbol: 'C', roman: 'VI' },
    { root: 7, quality: 'maj' as const, symbol: 'G', roman: 'III' },
    { root: 2, quality: 'maj' as const, symbol: 'D', roman: 'VII' },
  ];
  song.chords = Array.from({ length: 24 }, (_, bar) => ({ id: `ch_${bar}`, tick: bar * BAR, duration: BAR, ...prog[bar % 4] }));
  const bassNotes: Note[] = [];
  for (let bar = 0; bar < 24; bar++) {
    const root = [40, 36, 43, 38][bar % 4];
    for (let e = 0; e < 8; e++) bassNotes.push(note(`b_${bar}_${e}`, root, bar, e * 0.5, 0.5, e % 2 === 0 ? 96 : 80));
  }
  const drumNotes: Note[] = [];
  for (let bar = 0; bar < 24; bar++) {
    drumNotes.push(note(`k_${bar}_0`, 36, bar, 0, 0.25, 110), note(`s_${bar}_1`, 38, bar, 1, 0.25, 100), note(`k_${bar}_2`, 36, bar, 2, 0.25, 105), note(`s_${bar}_3`, 38, bar, 3, 0.25, 100));
    for (let e = 0; e < 8; e++) drumNotes.push(note(`h_${bar}_${e}`, 42, bar, e * 0.5, 0.25, 70));
  }
  const vocalNotes: Note[] = [];
  const syllables = ['I', 'walk', 'a-', 'lone', 'through', 'the', 'night'];
  for (let bar = 4; bar < 20; bar++) {
    for (let b = 0; b < 4; b++) {
      const i = (bar * 4 + b) % syllables.length;
      vocalNotes.push(note(`v_${bar}_${b}`, 64 + ((bar + b) % 5), bar, b, 1, 85, { syllable: syllables[i] }));
    }
  }
  const track = (t: Partial<Track> & Pick<Track, 'id' | 'name' | 'role' | 'instrumentId'>): Track => ({
    kind: 'midi',
    constraints: {},
    notes: [],
    clips: [],
    color: '#888',
    stemGroup: 'others',
    ...t,
  });
  song.tracks = [
    track({ id: 'trk_bass', name: 'Bass', role: 'bass', instrumentId: 'electric-bass', notes: bassNotes, constraints: { lowest: 28, highest: 55, complexity: 'medium', function: 'bass-line' }, stemGroup: 'bass' }),
    track({ id: 'trk_drums', name: 'Drums', role: 'drums', instrumentId: 'drum-kit', notes: drumNotes, midiChannel: 9, stemGroup: 'drums' }),
    track({ id: 'trk_vox', name: 'Lead Vocal', role: 'vocal', instrumentId: 'voice', notes: vocalNotes, vocal: { voiceType: 'tenor', mode: 'ai-singer' }, stemGroup: 'vocals' }),
  ];
  song.lyrics = opts.instrumental
    ? []
    : [
        { id: 'ly_1', sectionId: 'sec_v1', text: 'I walk alone through the night' },
        { id: 'ly_2', sectionId: 'sec_v1', text: 'Counting the lights on the water' },
        { id: 'ly_3', sectionId: 'sec_ch1', text: 'Fire in the sky' },
        { id: 'ly_4', sectionId: 'sec_ch1', text: 'Carry me home' },
      ];
  if (opts.instrumental) {
    song.vocals.mode = 'none';
    song.tracks = song.tracks.filter((t) => t.role !== 'vocal');
  }
  song.genreBlend = [{ genreId: 'emo', weight: 0.6 }, { genreId: 'pop-punk', weight: 0.4 }];
  song.blueprint = {
    title: 'Test Song',
    tempo: 120,
    meter: { numerator: 4, denominator: 4 },
    key: { tonic: 4, mode: 'minor' },
    styles: ['Emo', 'Pop-punk'],
    genreBlend: song.genreBlend,
    moods: ['Melancholy verses', 'Cathartic chorus'],
    instrumentation: [],
    structure: [],
    macros: song.macros,
    seed: 7,
  };
  song.production.prompt = 'warm analog tape, wide guitars';
  song.production.negativePrompt = 'lo-fi noise';
  song.locks = { 'track:trk_drums:section:sec_ch1': true };
  song.mixer.channels = {
    trk_bass: { volumeDb: -6, pan: 0, mute: false, solo: false, eq: { ...song.mixer.master.eq, lowMidDb: -2 }, compressor: { ...song.mixer.master.compressor }, reverbSend: 0.1, delaySend: 0, width: 1, drive: 0 },
  };
  return song;
}

// ---------------------------------------------------------------------------
// Fake LLM
// ---------------------------------------------------------------------------

export class FakeLLM implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  constructor(
    private readonly replies: (string | ((req: LLMRequest) => string))[],
    private readonly models: ModelInfo[] = [],
  ) {}
  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const r = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
    const text = typeof r === 'function' ? r(req) : r;
    return { text, model: req.model ?? 'fake-model', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.001 };
  }
}
