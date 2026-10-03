/**
 * Prompt templates for the composition tasks (spec §58 plan_song / modify_composition /
 * analyze_music / explain_music, plus blueprint design, lyrics, chat and mix assistance).
 *
 * Templates are provider-neutral: the same text goes to every LLM; adapters only differ in how the
 * JSON schema is enforced (native structured output vs. prompt instructions).
 */
import { keyName, type Blueprint } from '@songdeck/core';
import { musicContextToPrompt, type MusicContext } from '../context';
import type {
  AnalyzeMusicRequest,
  ChatRequest,
  DesignBlueprintRequest,
  ExplainMusicRequest,
  GenerateLyricsRequest,
  MixAssistRequest,
  ModifyCompositionRequest,
  PlanSongRequest,
} from '../types';
import {
  ASSISTANT_IDENTITY,
  EDITING_RULES,
  MIX_REFERENCE,
  MUSIC_IR_CONVENTIONS,
  OPERATION_REFERENCE,
} from './conventions';

export interface PromptPair {
  system: string;
  user: string;
}

function join(...parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join('\n\n');
}

function blueprintSummary(b: Blueprint): string {
  const lines = [
    `Title: ${b.title}`,
    b.prompt ? `Idea: ${b.prompt}` : '',
    `Key: ${keyName(b.key)} · Tempo: ${b.tempo} BPM · Meter: ${b.meter.numerator}/${b.meter.denominator}`,
    b.styles.length ? `Styles: ${b.styles.join(', ')}` : '',
    b.genreBlend.length
      ? `Genre blend: ${b.genreBlend.map((g) => `${g.genreId} ${g.weight}`).join(', ')}`
      : '',
    b.moods.length ? `Moods: ${b.moods.join('; ')}` : '',
    b.instrumentation.length
      ? `Instrumentation: ${b.instrumentation.map((t) => `${t.name} (${t.role}${t.function ? `, ${t.function}` : ''})`).join(', ')}`
      : '',
    b.structure.length
      ? `Structure: ${b.structure
          .map(
            (s) =>
              `${s.name} [${s.kind}] ${s.bars} bars${s.energy !== undefined ? ` energy ${s.energy}${s.energyEnd !== undefined ? `→${s.energyEnd}` : ''}` : ''}${s.harmony?.length ? ` harmony ${s.harmony.join(' ')}` : ''}${s.purpose ? ` (${s.purpose})` : ''}`,
          )
          .join('; ')}`
      : '',
    b.vocal
      ? `Vocal: ${b.vocal.voiceType}, ${b.vocal.mode}${b.vocal.description ? `, ${b.vocal.description}` : ''}`
      : '',
    b.lyricsTheme ? `Lyrics theme: ${b.lyricsTheme}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function planSongPrompt(req: PlanSongRequest): PromptPair {
  const system = join(
    ASSISTANT_IDENTITY,
    'Task: write the abstract COMPOSITION PLAN (spec §15) before any MIDI exists — key, tempo, meter and the ordered sections with their length in bars, harmony, energy and purpose.',
    MUSIC_IR_CONVENTIONS,
    [
      'Planning guidance:',
      '- Harmony: realized chord symbols in the key, one per harmonic-rhythm slot (usually one chord per bar or two per bar); they repeat to fill the section.',
      '- Create contrast between sections (energy, harmonic rhythm, register) and a clear arc; choruses usually carry the highest energy, the final chorus the peak.',
      '- Respect everything the blueprint fixes (key, tempo, meter, sections, harmony). Fill in only what is missing.',
      '- Typical song length 2.5–4 minutes unless the user asks otherwise.',
    ].join('\n'),
  );
  const user = join(
    req.prompt ? `Idea: ${req.prompt}` : '',
    req.blueprint ? `Blueprint:\n${blueprintSummary(req.blueprint)}` : '',
    req.context ? `Current song:\n${musicContextToPrompt(req.context)}` : '',
    req.constraints?.length ? `Constraints:\n${req.constraints.map((c) => `- ${c}`).join('\n')}` : '',
    'Return the composition plan as JSON.',
  );
  return { system, user };
}

export function designBlueprintPrompt(req: DesignBlueprintRequest): PromptPair {
  const system = join(
    ASSISTANT_IDENTITY,
    "Task: turn the user's idea into a SONG BLUEPRINT (spec §10): title, tempo, meter, key, styles, genre blend, moods, instrumentation (tracks with roles), structure (sections with bars, energy, purpose, mood and optional harmony), vocal setup, lyrics theme and macro controls.",
    MUSIC_IR_CONVENTIONS,
    [
      'Guidance:',
      '- Choose values idiomatic for the requested style; keep the instrumentation realistic for a band/production of that style (typically 4–8 tracks).',
      '- Give every section a purpose ("Establish motif", "Rising tension", "Emotional release") and an energy 0..100.',
      '- If the user names a key, tempo, structure or instruments, use exactly those.',
      req.constraints?.length
        ? '- The user fixed some choices in the builder (listed below as "Fixed by the user"). They are hard constraints: keep every one exactly and only fill in what they leave open.'
        : '',
      req.genres?.length ? '- For genre_blend use ONLY these genre ids.' : '',
      req.instruments?.length ? '- For instrument_id use ONLY these instrument ids.' : '',
      req.tags?.length
        ? '- "tags" lists style, mood, era, production, vocal, region or rhythm tags that suit the idea; use ONLY the available tag ids.'
        : '',
      req.lyrics
        ? '- The user wrote the lyrics below. Never change, add or remove words. Choose genres, tags, moods, tempo and a structure whose sections follow the stanzas (one section per stanza, in order).'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const tagsByKind = new Map<string, string[]>();
  for (const t of req.tags ?? [])
    tagsByKind.set(t.kind ?? 'other', [...(tagsByKind.get(t.kind ?? 'other') ?? []), t.id]);
  const user = join(
    `Idea: ${req.prompt}`,
    req.constraints?.length
      ? `Fixed by the user (hard constraints):\n${req.constraints.map((c) => `- ${c}`).join('\n')}`
      : '',
    req.lyrics ? `The user's lyrics (keep the words exactly):\n"""\n${req.lyrics.trim()}\n"""` : '',
    req.genres?.length
      ? `Available genre ids: ${req.genres.map((g) => `${g.id} (${g.name})`).join(', ')}`
      : '',
    req.instruments?.length
      ? `Available instrument ids: ${req.instruments.map((i) => `${i.id} (${i.name}${i.family ? `, ${i.family}` : ''})`).join(', ')}`
      : '',
    tagsByKind.size
      ? `Available tag ids:\n${[...tagsByKind.entries()].map(([kind, ids]) => `- ${kind}: ${ids.join(', ')}`).join('\n')}`
      : '',
    req.defaults && Object.keys(req.defaults).length
      ? `Defaults chosen by the user (keep unless the idea contradicts them): ${JSON.stringify(req.defaults)}`
      : '',
    'Return the blueprint as JSON.',
  );
  return { system, user };
}

export function modifyCompositionPrompt(req: ModifyCompositionRequest): PromptPair {
  const instruction = req.instruction ?? req.context.instruction;
  const system = join(
    ASSISTANT_IDENTITY,
    "Task: implement the user's instruction as a minimal list of structured MUSIC OPERATIONS (spec §20, §46). Song Deck validates and previews them as a proposal; nothing is applied directly.",
    MUSIC_IR_CONVENTIONS,
    EDITING_RULES,
    OPERATION_REFERENCE,
    req.allowedOps?.length ? `Only these operations are allowed here: ${req.allowedOps.join(', ')}.` : '',
    [
      'Output guidance:',
      '- When rewriting a passage, use replace_notes for the exact region with the complete new content (every note of the region).',
      '- Keep the existing chords unless the instruction asks for harmonic changes; fit new notes to the chords in effect.',
      '- Use transform_notes for transposition, velocity, timing or articulation changes instead of rewriting notes.',
      '- "confidence" is your honest estimate (0..1) that the result does what was asked and sounds right.',
    ].join('\n'),
  );
  const ctx = instruction === req.context.instruction ? req.context : { ...req.context, instruction };
  const user = join(musicContextToPrompt(ctx), 'Return the operations as JSON.');
  return { system, user };
}

export function analyzeMusicPrompt(req: AnalyzeMusicRequest): PromptPair {
  const system = join(
    ASSISTANT_IDENTITY,
    'Task: ANALYZE the music (spec §58 analyze_music): key, tempo, harmony, form, energy curve, arrangement and anything notable. Be specific — reference sections, bars and chords.',
    req.audio
      ? 'An audio recording is attached: listen to it and describe what you actually hear (tempo, key, instrumentation, structure, production, mix balance). Say when you are unsure.'
      : '',
    MUSIC_IR_CONVENTIONS,
  );
  const user = join(
    req.context ? musicContextToPrompt(req.context) : '',
    req.question ? `Question: ${req.question}` : 'Give a concise analysis.',
    'Return the analysis as JSON.',
  );
  return { system, user };
}

export function explainMusicPrompt(req: ExplainMusicRequest): PromptPair {
  const section = req.sectionId ? req.context.sections.find((s) => s.id === req.sectionId)?.name : undefined;
  const system = join(
    ASSISTANT_IDENTITY,
    'Task: EXPLAIN the music for a musician who wants to learn (Theory View, spec §43). Name the chords with roman numerals in the key, explain harmonic function, tension and release, contrast between sections, and why it feels the way it does. Offer concrete controls such as "make darker", "increase tension", "try modal harmony".',
    'Example of the expected tone: "Chorus: G – D – Em – C is I – V – vi – IV in G major. The verse emphasizes E minor while the chorus places more weight on G major, producing an emotional lift without a full modulation."',
    MUSIC_IR_CONVENTIONS,
  );
  const user = join(
    musicContextToPrompt(req.context),
    section ? `Explain the section "${section}".` : '',
    req.question ? `Question: ${req.question}` : '',
    'Return the explanation as JSON.',
  );
  return { system, user };
}

export function generateLyricsPrompt(req: GenerateLyricsRequest): PromptPair {
  const system = join(
    ASSISTANT_IDENTITY,
    'Task: write LYRICS for the requested sections.',
    [
      'Lyric guidance:',
      '- Return exactly the requested number of lines per section; when syllable counts are given, match them closely (they come from the vocal melody).',
      '- Sections marked LOCKED must be returned unchanged.',
      '- Favor singable open vowels on long or high notes; keep verses specific and choruses memorable; avoid clichés unless the style calls for them.',
      req.rhymeScheme ? `- Rhyme scheme: ${req.rhymeScheme}.` : '',
      req.language ? `- Language: ${req.language}.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const sections = req.sections
    .map((s) => {
      const bits = [`- ${s.name}${s.kind ? ` [${s.kind}]` : ''}: ${s.lines} line(s)`];
      if (s.syllables?.length) bits.push(`syllables per line: ${s.syllables.join(', ')}`);
      if (s.locked) bits.push('LOCKED');
      if (s.existing?.length) bits.push(`current: ${s.existing.map((l) => `"${l}"`).join(' / ')}`);
      return bits.join('; ');
    })
    .join('\n');
  const user = join(
    req.context ? musicContextToPrompt(req.context) : '',
    req.theme ? `Theme: ${req.theme}` : '',
    req.style ? `Style: ${req.style}` : '',
    req.instruction ? `Instruction: ${req.instruction}` : '',
    `Sections:\n${sections}`,
    'Return the lyrics as JSON.',
  );
  return { system, user };
}

export function chatPrompt(req: ChatRequest): PromptPair {
  const system = join(
    ASSISTANT_IDENTITY,
    "Task: answer the user's question about THIS project (spec §44) in concrete terms — sections, bars, chords, tracks, notes. If the user asks for a change, also PROPOSE it as operations (the user reviews it); otherwise return an empty operations list.",
    MUSIC_IR_CONVENTIONS,
    EDITING_RULES,
    OPERATION_REFERENCE,
  );
  const ctx: MusicContext = { ...req.context, instruction: req.question };
  const user = join(musicContextToPrompt(ctx), 'Return your answer as JSON.');
  return { system, user };
}

export function mixAssistPrompt(req: MixAssistRequest): PromptPair {
  const system = join(
    ASSISTANT_IDENTITY,
    'Task: act as the MIX ASSISTANT (spec §41). Translate the request into ordinary mixer changes (set_mixer) or automation (set_automation). Never regenerate audio and never change notes.',
    MIX_REFERENCE,
    'Respect locked mixer strips. Make the smallest set of changes that achieves the request and explain them in mixing terms.',
  );
  const ctx: MusicContext = { ...req.context, instruction: req.instruction };
  const user = join(musicContextToPrompt(ctx), 'Return the mixer operations as JSON.');
  return { system, user };
}

/** Follow-up message for the automatic JSON repair retry. */
export function repairPrompt(problems: readonly string[]): string {
  return [
    'Your previous reply could not be used as-is:',
    ...problems.slice(0, 15).map((p) => `- ${p}`),
    problems.length > 15 ? `- … ${problems.length - 15} more` : '',
    'Reply again with ONLY the corrected JSON object (no prose, no code fences). Keep everything that was valid; fix only the problems listed.',
  ]
    .filter(Boolean)
    .join('\n');
}
