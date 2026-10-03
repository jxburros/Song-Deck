import {
  LockKeys,
  branchLog,
  channelFor,
  createTimeMap,
  isLocked,
  sectionLayout,
  stableStringify,
  tickToMusical,
  type AudioAssetMeta,
  type AudioClip,
  type Note,
  type Project,
  type ProvenanceRecord,
  type RightsMetadata,
  type SectionSpan,
  type Song,
  type Track,
  type VocalExpression,
  type VocalMode,
  type VocalRender,
  type VoiceConsent,
  type VoiceKind,
  type VoiceModelRecord,
  type VoiceType,
} from '@songdeck/core';
import { STOCK_VOICES, resolveSingingVoice } from '@songdeck/audio';
import { isValidConsent, type VoiceInfo } from '@songdeck/ai';

/**
 * Vocal subsystem model (spec §32-§37): pure helpers shared by the Vocals mode, its task
 * handlers and the render pipeline. Vocals are independent of the instrumentation: a vocal
 * MIDI track (vocal.mid) + lyrics + expression + a voice → a render audio track that Mix &
 * Master treats like any other stem.
 */

/** Generator ids marking the audio tracks Vocals mode owns. */
export const VOCAL_RENDER_GENERATOR = 'vocal-render';
export const VOCAL_TAKES_GENERATOR = 'vocal-takes';
/** The on-device formant singer (always available, spec §51). */
export const BUILTIN_SINGER_ID = 'internal-singer';

// ---------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------

export function isVocalMidiTrack(t: Track): boolean {
  return (
    t.kind === 'midi' &&
    (t.role === 'vocal' || t.instrumentId === 'lead-vocal' || t.instrumentId === 'backing-vocal')
  );
}

export function vocalMidiTracks(song: Song): Track[] {
  return song.tracks.filter(isVocalMidiTrack);
}

/** The lead vocal: a melody vocal track first, then any vocal MIDI track. */
export function defaultVocalTrack(song: Song): Track | undefined {
  const vocals = vocalMidiTracks(song);
  return (
    vocals.find((t) => t.instrumentId === 'lead-vocal' && t.notes.length) ??
    vocals.find((t) => t.constraints.function === 'melody') ??
    vocals.find((t) => t.notes.length) ??
    vocals[0]
  );
}

export function renderTrackFor(song: Song, midiTrackId: string): Track | undefined {
  return song.tracks.find(
    (t) =>
      t.kind === 'audio' && t.generator?.id === VOCAL_RENDER_GENERATOR && t.sourceTrackId === midiTrackId,
  );
}

export function takesTrackFor(song: Song, midiTrackId: string): Track | undefined {
  return song.tracks.find(
    (t) => t.kind === 'audio' && t.generator?.id === VOCAL_TAKES_GENERATOR && t.sourceTrackId === midiTrackId,
  );
}

/** "Lead Vocal" → "lead_vocal" (spec §34 output `lead_vocal.wav`). */
export function fileStem(name: string, sep = '_'): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, 'g'), '');
  return s || 'vocal';
}

/** Symbolic file name of the vocal track (spec §73 lists `vocal.mid`). */
export function vocalMidiName(song: Song, trackId: string): string {
  const lead = defaultVocalTrack(song);
  const t = song.tracks.find((x) => x.id === trackId);
  if (!t || lead?.id === t.id) return 'vocal.mid';
  return `${fileStem(t.name, '-')}.mid`;
}

export function lastNoteEnd(track: Track): number {
  return track.notes.reduce((m, n) => Math.max(m, n.tick + n.duration), 0);
}

export function beatTicksAt(song: Song): number {
  const den = song.meterMap[0]?.denominator ?? 4;
  return (song.ppq * 4) / den;
}

// ---------------------------------------------------------------------------------------------
// Modes (spec §33)
// ---------------------------------------------------------------------------------------------

export type VocalTab =
  'lyrics' | 'melody' | 'expression' | 'render' | 'regenerate' | 'voices' | 'conversion' | 'recording';

export interface VocalModeInfo {
  mode: VocalMode;
  label: string;
  icon: string;
  /** What choosing the mode does (shown on its card). */
  does: string;
  /** Tab that does the mode's work. */
  tab: VocalTab;
}

export const VOCAL_MODES: VocalModeInfo[] = [
  {
    mode: 'none',
    label: 'No vocal',
    icon: 'minus',
    does: 'Instrumental only. The vocal track stays in the project (with its lyrics) but is silent in playback, renders and exports.',
    tab: 'melody',
  },
  {
    mode: 'melody-only',
    label: 'Vocal melody only',
    icon: 'midi',
    does: 'Delivers vocal.mid — melody, lyric syllables and expression. Playback previews it with the guide singer; no vocal audio is rendered.',
    tab: 'melody',
  },
  {
    mode: 'placeholder',
    label: 'Placeholder vocal',
    icon: 'waveform',
    does: 'A temporary synthesized vocal for arranging: the built-in formant singer sings the lyrics live, or renders lead_vocal.wav.',
    tab: 'render',
  },
  {
    mode: 'ai-singer',
    label: 'AI singer',
    icon: 'sparkles',
    does: 'A SINGING_SYNTHESIS provider sings lead_vocal.wav from lyrics, vocal MIDI, phonemes, expression and dynamics.',
    tab: 'render',
  },
  {
    mode: 'voice-conversion',
    label: 'User voice conversion',
    icon: 'users',
    does: 'Renders a neutral performance with the built-in singer, then converts it to an authorized target voice (consent required).',
    tab: 'conversion',
  },
  {
    mode: 'recorded',
    label: 'Recorded vocal',
    icon: 'mic',
    does: 'You record takes over the playing song; the active take is the vocal. A take can be transcribed back into vocal MIDI.',
    tab: 'recording',
  },
];

export function modeInfo(mode: VocalMode): VocalModeInfo {
  return VOCAL_MODES.find((m) => m.mode === mode) ?? VOCAL_MODES[1];
}

/**
 * Which vocal source is audible for the song's vocal mode (mixer mutes, honoring `mixer:` locks):
 *  none → nothing (the renderer silences the vocal MIDI); melody-only → vocal MIDI (guide singer);
 *  placeholder / ai-singer / voice-conversion → the render track when it has a render, else the
 *  vocal MIDI; recorded → the active takes, else the vocal MIDI.
 */
export function applyVocalMonitoring(song: Song, midiTrackId: string): { song: Song; skipped: string[] } {
  const midi = song.tracks.find((t) => t.id === midiTrackId);
  if (!midi) return { song, skipped: [] };
  const mode = song.vocals.mode;
  const render = renderTrackFor(song, midiTrackId);
  const takes = takesTrackFor(song, midiTrackId);
  const hasRender = !!render?.clips.some((c) => !c.muted);
  const hasTake = !!takes?.clips.some((c) => !c.muted);
  const want = new Map<string, boolean>(); // track id → muted
  const renderAudible =
    (mode === 'placeholder' || mode === 'ai-singer' || mode === 'voice-conversion') && hasRender;
  const takeAudible = mode === 'recorded' && hasTake;
  // 'none' silences the vocal MIDI through its track vocal mode (renderer); its channel mute is only
  // managed while a vocal audio track (render / takes) exists to take over from it.
  if (render || takes) want.set(midi.id, renderAudible || takeAudible);
  if (render) want.set(render.id, !renderAudible);
  if (takes) want.set(takes.id, !takeAudible);
  const channels = { ...song.mixer.channels };
  const skipped: string[] = [];
  let changed = false;
  for (const [id, muted] of want) {
    const ch = channelFor(song, id);
    if (ch.mute === muted) continue;
    if (isLocked(song.locks, LockKeys.mixer(id))) {
      skipped.push(song.tracks.find((t) => t.id === id)?.name ?? id);
      continue;
    }
    channels[id] = { ...ch, mute: muted };
    changed = true;
  }
  // Keep the track-level vocal mode in step with the song (the renderer silences 'none').
  const tracks = song.tracks.map((t) =>
    t.id === midi.id && t.vocal?.mode !== mode ? { ...t, vocal: { ...(t.vocal ?? {}), mode } } : t,
  );
  const tracksChanged = tracks.some((t, i) => t !== song.tracks[i]);
  if (!changed && !tracksChanged) return { song, skipped };
  return { song: { ...song, tracks, mixer: changed ? { ...song.mixer, channels } : song.mixer }, skipped };
}

// ---------------------------------------------------------------------------------------------
// Phrases (per-phrase expression, §37 "here")
// ---------------------------------------------------------------------------------------------

export interface VocalPhrase {
  id: string;
  index: number;
  label: string;
  sectionId: string;
  sectionName: string;
  startTick: number;
  endTick: number;
  noteIds: string[];
  /** Sung text reconstructed from the note syllables ("" when none are attached). */
  text: string;
}

/** Text sung by notes: "ca-" "thar-" "tic" → "cathartic"; "_" melismas are skipped. */
export function sungText(notes: Note[]): string {
  let out = '';
  let open = false;
  for (const n of notes) {
    const s = (n.syllable ?? '').trim();
    if (!s || s === '_' || s === '-') continue;
    for (const part of s.split(/\s+/)) {
      const cont = part.endsWith('-');
      const clean = part.replace(/^-|-$/g, '');
      out += (open ? '' : out ? ' ' : '') + clean;
      open = cont;
    }
  }
  return out;
}

/**
 * Phrases of a vocal track, per section: the composer's Phrase records (one per lyric line /
 * motif statement) with a timing tolerance for humanized notes, and — for notes no record
 * covers — groups split at rests of half a beat or more.
 */
export function vocalPhrases(song: Song, track: Track): VocalPhrase[] {
  const notes = [...track.notes].sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
  if (!notes.length) return [];
  const beat = beatTicksAt(song);
  const tol = beat / 4;
  const records = song.phrases
    .filter((p) => p.trackId === track.id)
    .sort((a, b) => a.startTick - b.startTick);
  const out: VocalPhrase[] = [];
  for (const span of sectionLayout(song)) {
    const secNotes = notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
    if (!secNotes.length) continue;
    const groups: { id?: string; notes: Note[] }[] = [];
    const byRecord = new Map<string, Note[]>();
    const loose: Note[] = [];
    for (const n of secNotes) {
      const inside =
        records.find((r) => n.tick >= r.startTick && n.tick < r.endTick) ??
        records.find((r) => n.tick >= r.startTick - tol && n.tick < r.endTick);
      if (inside) byRecord.set(inside.id, [...(byRecord.get(inside.id) ?? []), n]);
      else loose.push(n);
    }
    for (const [id, g] of byRecord) groups.push({ id, notes: g });
    let cur: Note[] = [];
    let curEnd = -Infinity;
    for (const n of loose) {
      if (cur.length && n.tick - curEnd >= beat / 2) {
        groups.push({ notes: cur });
        cur = [];
        curEnd = -Infinity;
      }
      cur.push(n);
      curEnd = Math.max(curEnd, n.tick + n.duration);
    }
    if (cur.length) groups.push({ notes: cur });
    groups.sort((a, b) => a.notes[0].tick - b.notes[0].tick);
    groups.forEach((g, i) => {
      const start = g.notes[0].tick;
      out.push({
        id: g.id ?? `${span.section.id}:${start}`,
        index: i,
        label: `${span.section.name} · phrase ${i + 1}`,
        sectionId: span.section.id,
        sectionName: span.section.name,
        startTick: start,
        endTick: Math.max(...g.notes.map((n) => n.tick + n.duration)),
        noteIds: g.notes.map((n) => n.id),
        text: sungText(g.notes),
      });
    });
  }
  return out;
}

/**
 * Grow a tick range to the surrounding rests so a re-sung range starts and ends in silence
 * (legato lines are never cut mid-phrase; the splice crossfade sits in the gap).
 */
export function expandToRests(
  song: Song,
  track: Track,
  startTick: number,
  endTick: number,
): { startTick: number; endTick: number } {
  const notes = [...track.notes].sort((a, b) => a.tick - b.tick);
  const inRange = notes.map((n, i) => ({ n, i })).filter(({ n }) => n.tick >= startTick && n.tick < endTick);
  if (!inRange.length) return { startTick, endTick };
  const minGap = beatTicksAt(song) / 4;
  let i = inRange[0].i;
  let j = inRange[inRange.length - 1].i;
  const endOf = (k: number) => notes[k].tick + notes[k].duration;
  while (i > 0 && notes[i].tick - endOf(i - 1) < minGap) i--;
  let end = endOf(j);
  while (j < notes.length - 1 && notes[j + 1].tick - end < minGap) {
    j++;
    end = Math.max(end, endOf(j));
  }
  return {
    startTick: Math.min(startTick, notes[i].tick),
    endTick: Math.max(endTick, notes[j].tick + 1, end),
  };
}

// ---------------------------------------------------------------------------------------------
// Expression (spec §35)
// ---------------------------------------------------------------------------------------------

export type ExpressionKey =
  'breathiness' | 'tension' | 'vibrato' | 'vibratoRate' | 'energy' | 'onset' | 'release';

export const EXPRESSION_FIELDS: {
  key: ExpressionKey;
  label: string;
  kind: 'amount' | 'rate' | 'choice';
  hint: string;
  options?: string[];
}[] = [
  { key: 'breathiness', label: 'Breathiness', kind: 'amount', hint: 'Air in the tone' },
  { key: 'tension', label: 'Tension', kind: 'amount', hint: 'Vocal effort / brightness' },
  { key: 'vibrato', label: 'Vibrato', kind: 'amount', hint: 'Vibrato depth' },
  { key: 'vibratoRate', label: 'Vibrato rate', kind: 'rate', hint: 'Hz' },
  { key: 'energy', label: 'Energy', kind: 'amount', hint: 'Projection / loudness' },
  {
    key: 'onset',
    label: 'Onset',
    kind: 'choice',
    hint: 'How notes start',
    options: ['soft', 'normal', 'hard', 'scoop'],
  },
  {
    key: 'release',
    label: 'Release',
    kind: 'choice',
    hint: 'How phrases end',
    options: ['normal', 'falling', 'rising', 'breathy', 'cut'],
  },
];

export const EXPRESSION_FALLBACK: Required<
  Pick<
    VocalExpression,
    'breathiness' | 'tension' | 'vibrato' | 'vibratoRate' | 'energy' | 'onset' | 'release'
  >
> = {
  breathiness: 0.2,
  tension: 0.4,
  vibrato: 0.3,
  vibratoRate: 5.5,
  energy: 0.5,
  onset: 'normal',
  release: 'normal',
};

/** Expression the singer receives for a note: defaults, then per-note overrides (spec §35). */
export function effectiveExpression(song: Song, n: Note): VocalExpression {
  return { ...(song.vocals.defaultExpression ?? {}), ...(n.expression ?? {}) };
}

export interface ExpressionSupport {
  supported: ExpressionKey[];
  /** True when the provider did not declare what it supports (everything is sent). */
  unknown: boolean;
  note: string;
}

const ALL_EXPRESSION: ExpressionKey[] = EXPRESSION_FIELDS.map((f) => f.key);

/** Which expression parameters a singing provider honors; the rest are ignored (spec §35). */
export function expressionSupport(
  providerId: string | undefined,
  adapter?: string,
  declared?: unknown,
): ExpressionSupport {
  if (Array.isArray(declared) && declared.length) {
    const keys = declared
      .map(String)
      .filter((k): k is ExpressionKey => (ALL_EXPRESSION as string[]).includes(k));
    return { supported: keys, unknown: false, note: 'As declared in the provider configuration.' };
  }
  if (!providerId || providerId === BUILTIN_SINGER_ID || adapter === 'internal') {
    return {
      supported: ALL_EXPRESSION,
      unknown: false,
      note: 'The built-in formant singer models every parameter (glottal tension, aspiration, delayed vibrato, onset and release gestures).',
    };
  }
  if (adapter === 'singing-http') {
    return {
      supported: ['breathiness', 'tension', 'energy', 'vibrato', 'vibratoRate'],
      unknown: false,
      note: 'DiffSinger / OpenVPI variance controls. Onset and release are sent to the bridge but most voicebanks ignore them.',
    };
  }
  return {
    supported: ALL_EXPRESSION,
    unknown: true,
    note: 'This provider does not declare its expression controls — every parameter is sent and unsupported ones are ignored.',
  };
}

// ---------------------------------------------------------------------------------------------
// Render signatures (what was sung) → stale sections
// ---------------------------------------------------------------------------------------------

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** One entry per note: `tick:hash` of everything the singer receives for it. */
export function renderSignature(song: Song, track: Track): string[] {
  return [...track.notes]
    .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
    .map(
      (n) =>
        `${n.tick}:${fnv1a(stableStringify([n.pitch, n.duration, n.velocity, n.syllable ?? '', n.phonemes ?? [], effectiveExpression(song, n), n.articulation ?? '']))}`,
    );
}

export function timingKey(song: Song): string {
  return fnv1a(stableStringify([song.ppq, song.tempoMap, song.meterMap]));
}

export interface RenderedState {
  signature: string[];
  timing: string;
  voiceKey: string;
}

export interface Staleness {
  sections: SectionSpan[];
  reason: 'none' | 'notes' | 'voice' | 'timing' | 'unknown';
}

/** Sections whose vocal changed since the render (notes, syllables, expression), or everything after a voice/tempo change. */
export function staleSections(
  song: Song,
  track: Track,
  rendered: RenderedState | undefined,
  voiceKey: string,
): Staleness {
  const spans = sectionLayout(song).filter((s) =>
    track.notes.some((n) => n.tick >= s.startTick && n.tick < s.endTick),
  );
  if (!rendered) return { sections: spans, reason: 'unknown' };
  if (rendered.timing !== timingKey(song)) return { sections: spans, reason: 'timing' };
  if (rendered.voiceKey !== voiceKey) return { sections: spans, reason: 'voice' };
  const current = renderSignature(song, track);
  const tickOf = (s: string) => Number(s.slice(0, s.indexOf(':')));
  const all = sectionLayout(song);
  const stale = all.filter((span) => {
    const a = current.filter((s) => tickOf(s) >= span.startTick && tickOf(s) < span.endTick).join('|');
    const b = rendered.signature
      .filter((s) => tickOf(s) >= span.startTick && tickOf(s) < span.endTick)
      .join('|');
    return a !== b;
  });
  return { sections: stale, reason: stale.length ? 'notes' : 'none' };
}

/** Signature after splicing a re-sung range into a render. */
export function spliceSignature(
  base: string[],
  current: string[],
  startTick: number,
  endTick: number,
): string[] {
  const tickOf = (s: string) => Number(s.slice(0, s.indexOf(':')));
  const inR = (s: string) => tickOf(s) >= startTick && tickOf(s) < endTick;
  return [...base.filter((s) => !inR(s)), ...current.filter(inR)].sort((a, b) => tickOf(a) - tickOf(b));
}

// ---------------------------------------------------------------------------------------------
// Active render
// ---------------------------------------------------------------------------------------------

export interface ActiveRender {
  track: Track;
  clip: AudioClip;
  render?: VocalRender;
  asset?: AudioAssetMeta;
  provenance?: ProvenanceRecord;
  rendered?: RenderedState;
  version?: number;
}

export function provenanceOf(
  project: Project,
  asset: AudioAssetMeta | undefined,
): ProvenanceRecord | undefined {
  if (!asset) return undefined;
  return (
    project.meta.provenance.find((p) => p.id === asset.provenanceId) ??
    project.meta.provenance.find((p) => p.artifactId === asset.id)
  );
}

export function renderedStateOf(prov: ProvenanceRecord | undefined): RenderedState | undefined {
  const p = prov?.parameters as { signature?: unknown; timing?: unknown; voiceKey?: unknown } | undefined;
  if (!p || !Array.isArray(p.signature) || typeof p.timing !== 'string' || typeof p.voiceKey !== 'string')
    return undefined;
  return { signature: p.signature.map(String), timing: p.timing, voiceKey: p.voiceKey };
}

export function activeRender(project: Project, midiTrackId: string): ActiveRender | null {
  const song = project.song;
  const track = renderTrackFor(song, midiTrackId);
  const clip = track?.clips.find((c) => !c.muted) ?? track?.clips[0];
  if (!track || !clip) return null;
  const asset = project.meta.assets.find((a) => a.id === clip.assetId);
  const render = song.vocals.renders.find((r) => r.assetId === clip.assetId);
  const provenance = provenanceOf(project, asset);
  const version = (provenance?.parameters as { version?: unknown } | undefined)?.version;
  return {
    track,
    clip,
    render,
    asset,
    provenance,
    rendered: renderedStateOf(provenance),
    version: typeof version === 'number' ? version : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Artifact versions (provenance "vocal.mid v8", "lyrics.txt v5", spec §64)
// ---------------------------------------------------------------------------------------------

export function lyricsOfTrack(song: Song, trackId: string) {
  return song.lyrics.filter((l) => !l.trackId || l.trackId === trackId);
}

/** Version numbers of the vocal MIDI and the lyrics: how many times each changed along the branch history. */
export function artifactVersions(
  project: Project,
  trackId: string,
): { midi: number; lyrics: number; revision?: number } {
  let chain: Song[] = [];
  let revision: number | undefined;
  try {
    const log = branchLog(project);
    revision = log[0]?.number;
    chain = log.reverse().map((r) => r.snapshot);
  } catch {
    chain = [];
  }
  chain.push(project.song);
  let midi = 0;
  let lyrics = 0;
  let pm = '';
  let pl = '';
  for (const s of chain) {
    const t = s.tracks.find((x) => x.id === trackId);
    const m =
      t && t.notes.length
        ? fnv1a(
            stableStringify(
              t.notes.map((n) => [
                n.tick,
                n.pitch,
                n.duration,
                n.velocity,
                n.syllable ?? '',
                n.expression ?? {},
              ]),
            ),
          )
        : '';
    const lines = s.lyrics.filter((l) => !l.trackId || l.trackId === trackId);
    const l = lines.length ? fnv1a(stableStringify(lines.map((x) => [x.sectionId, x.text]))) : '';
    if (m && m !== pm) midi++;
    if (l && l !== pl) lyrics++;
    pm = m;
    pl = l;
  }
  return { midi, lyrics, revision };
}

// ---------------------------------------------------------------------------------------------
// Voices (spec §36)
// ---------------------------------------------------------------------------------------------

export interface VoiceChoice {
  /** Value stored in song.vocals.voiceId / conversionVoiceId: a stock voice id or a VoiceModelRecord id. */
  key: string;
  /** Voice id sent to the provider. */
  ref: string;
  /** Provider that sings / converts with it ('external' = not connected yet). */
  providerId: string;
  name: string;
  kind: VoiceKind;
  voiceType?: VoiceType;
  description?: string;
  source: 'built-in' | 'provider' | 'project';
  record?: VoiceModelRecord;
  consent?: VoiceConsent;
  /** Stock voices need no attestation; everything else needs valid consent (spec §36). */
  authorized: boolean;
}

export const VOICE_KIND_LABEL: Record<VoiceKind, string> = {
  stock: 'Stock synthetic',
  'user-trained': 'User-trained',
  imported: 'Imported',
  'third-party': 'Third-party',
};

export const CONSENT_BASIS_LABEL: Record<VoiceConsent['basis'], string> = {
  'own-voice': 'My own voice',
  'written-permission': 'Written permission from the rights holder',
  license: 'License',
  'public-domain': 'Public domain',
  stock: 'Stock voice',
};

export function builtInVoices(): VoiceChoice[] {
  return STOCK_VOICES.map((v) => ({
    key: v.id,
    ref: v.id,
    providerId: BUILTIN_SINGER_ID,
    name: v.name,
    kind: 'stock' as const,
    voiceType: v.voiceType,
    description: v.description,
    source: 'built-in' as const,
    authorized: true,
  }));
}

export function isBuiltInVoice(key: string | undefined): boolean {
  return !!key && STOCK_VOICES.some((v) => v.id === key);
}

export function recordChoice(rec: VoiceModelRecord): VoiceChoice {
  return {
    key: rec.id,
    ref: rec.modelRef,
    providerId: rec.providerId,
    name: rec.name,
    kind: rec.kind,
    voiceType: rec.voiceType,
    description: rec.description,
    source: 'project',
    record: rec,
    consent: rec.consent,
    authorized: rec.kind === 'stock' || isValidConsent(rec.consent),
  };
}

export function providerVoiceKey(providerId: string, voiceId: string): string {
  return `voice_${fileStem(`${providerId}_${voiceId}`, '_')}`;
}

/** Voices a provider reported (spec §36 "provider voices"), unless the project already holds a record for them. */
export function providerVoiceChoices(
  project: Project | null,
  providerId: string,
  voices: VoiceInfo[],
): VoiceChoice[] {
  const records = project?.meta.voices ?? [];
  return voices.map((v) => {
    const rec = records.find((r) => r.providerId === providerId && r.modelRef === v.id);
    if (rec) return recordChoice(rec);
    return {
      key: providerVoiceKey(providerId, v.id),
      ref: v.id,
      providerId,
      name: v.name,
      kind: v.kind,
      voiceType: v.voiceType,
      description: v.description,
      source: 'provider' as const,
      authorized: v.kind === 'stock',
    };
  });
}

export function projectVoiceChoices(project: Project | null): VoiceChoice[] {
  return (project?.meta.voices ?? []).map(recordChoice);
}

/** The voice to sing with: explicit key → project record → the track's voice type on the built-in singer. */
export function resolveVoice(
  project: Project | null,
  key: string | undefined,
  track: Track | undefined,
): VoiceChoice {
  const builtIns = builtInVoices();
  if (key) {
    const b = builtIns.find((v) => v.key === key);
    if (b) return b;
    const rec = project?.meta.voices.find((r) => r.id === key);
    if (rec) return recordChoice(rec);
  }
  if (track) {
    const v = resolveSingingVoice(track);
    return builtIns.find((x) => x.key === v.id) ?? builtIns[0];
  }
  return builtIns[0];
}

export function consentSummary(c: VoiceConsent | undefined): string {
  if (!c) return 'No authorization on file';
  const when = c.attestedAt ? new Date(c.attestedAt).toLocaleDateString() : '';
  return `${CONSENT_BASIS_LABEL[c.basis] ?? c.basis} · rights holder ${c.rightsHolder} · attested by ${c.attestedBy}${when ? ` on ${when}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Rights (spec §65)
// ---------------------------------------------------------------------------------------------

type ListKey =
  'lyricWriters' | 'performers' | 'voiceModels' | 'modelProviders' | 'humanComposers' | 'sourceReferences';

/** Add (never remove) attribution entries. */
export function withRights(
  project: Project,
  add: Partial<Record<ListKey, (string | undefined | null)[]>>,
): Project {
  const rights: RightsMetadata = { ...project.meta.rights };
  let changed = false;
  for (const [k, values] of Object.entries(add) as [ListKey, (string | undefined | null)[]][]) {
    const cur = rights[k] ?? [];
    const next = [...cur];
    for (const v of values) {
      const s = v?.trim();
      if (s && !next.some((x) => x.toLowerCase() === s.toLowerCase())) next.push(s);
    }
    if (next.length !== cur.length) {
      rights[k] = next;
      changed = true;
    }
  }
  return changed ? { ...project, meta: { ...project.meta, rights } } : project;
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

export function secondsOfTick(song: Song, tick: number): number {
  return createTimeMap(song).tickToSeconds(tick);
}

export function formatBars(song: Song, startTick: number, endTick: number): string {
  const a = tickToMusical(song, startTick).bar;
  const b = tickToMusical(song, Math.max(startTick, endTick - 1)).bar;
  return a === b ? `bar ${a}` : `bars ${a}–${b}`;
}
