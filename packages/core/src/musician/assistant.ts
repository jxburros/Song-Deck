import type { ChordSpec, EditSelection, KeySignature, MusicOperation, Section, SectionKind, Song, Track } from '../ir/types';
import { barToTick, bpmAtTick, keyAtBar, meterAtBar, sectionLayout, songDurationSeconds, tickToSeconds, type SectionSpan } from '../timing';
import { LockKeys, isChordSectionLocked, isLocked } from '../locks';
import { chordFunction } from '../theory/analysis';
import { isDominantQuality, triadQuality } from '../theory/chords';
import { keyName, relativeKey } from '../theory/scales';
import { midiToNoteNameInKey, mod12 } from '../theory/pitch';
import { deriveRng } from '../util/random';
import { voiceChord } from '../theory/voicing';
import { amountOf, findSectionMentions, listJoin, normalizeText, plural } from './nlp';
import {
  type ChordSlot,
  type WorkNote,
  avgPitch,
  chordOpsFromSlots,
  chordSlots,
  emitNoteOps,
  findMelodyTrack,
  isBassTrack,
  isDrumTrack,
  isMelodicTrack,
  isPitchedTrack,
  isVocalTrack,
  lockChecker,
  round2,
  selectionRanges,
  toOpNote,
  toWork,
  trackPitchRange,
} from './op-helpers';
import { refitNotes } from './transforms';
import { explainSection, explainSong, sectionAnalysisKey } from './theory-explain';
import { applyTheoryControl } from './theory-controls';
import { interpretEditInstruction } from './edit-interpreter';
import { interpretMixInstruction } from './mix-assistant';
import { romanOf, spellChord } from './harmony';
import type { AssistantAnswer } from './types';

/**
 * §44 AI conversation — an offline, project-aware assistant. Answers questions in terms of the
 * actual song (sections, chords, energy, instrumentation) and proposes structured operations for
 * fixes, "what if" experiments and arrangement changes.
 */

const Q = {
  key: /\bwhat(?: is)?(?: the)? key\b|\bwhich key\b|\bin what key\b|\bkey (?:is|of) (?:this|the song|it)\b|\bwhat key\b/,
  chords: /\b(?:what|which) (?:are )?(?:the )?chords\b|\bwhat chords\b|\bchords (?:in|of|for|does|are used)\b|\bshow (?:me )?the chords\b|\bwhat(?: is)? the (?:chord )?progression\b/,
  length: /\bhow long\b|\blength of the (?:song|track)\b|\bsong length\b|\bhow many bars\b|\bduration\b/,
  meter: /\btime signatures?\b|\bwhat(?: is| are)? (?:the )?met(?:er|re)s?\b|\bwhich met(?:er|re)\b|\bwhat time is (?:it|this|the song) in\b|\bin (?:what|which) time\b/,
  tempo: /\bwhat(?: is)? the tempo\b|\bhow fast\b|\bwhat bpm\b|\bwhat tempo\b/,
  structure: /\b(?:what is|show me|what's) the (?:structure|form|arrangement order)\b|\bwhat sections\b|\bsong structure\b|\bhow is (?:it|the song) structured\b/,
  instruments: /\b(?:which|what) instruments\b|\bwho (?:is )?play(?:s|ing)\b|\binstrumentation\b|\bwhat(?: is)? playing\b|\bwhich tracks\b|\bwhat tracks\b/,
  lyrics: /\bwhat are the lyrics\b|\bshow (?:me )?the lyrics\b|\bthe lyrics (?:of|in|for)\b|\bwhat (?:does|do) (?:the )?(?:singer|vocal)s? sing\b/,
  energy: /\benergy (?:curve|arc|levels?)\b|\bhow does the energy\b|\bwhere is the energy\b|\bwhich section is the (?:loudest|biggest|most energetic)\b/,
  range: /\bvocal range\b|\bmelody(?:'s)? range\b|\brange of the (?:melody|vocal)\b|\bhighest note\b|\blowest note\b/,
  melody: /\b(?:melody|melodies|melodic|topline|vocal line|tune|hook)\b/,
  melodyJudge:
    /\b(?:repetitive|repetition|repeat(?:s|ing|ed)?|boring|catchy|memorable|interesting|varied|variety|monoton(?:e|ous)|predictable|singable|good|strong|weak|work(?:s|ing)?|describe|analy[sz]e|tell me about|how is|how does)\b/,
  weak: /\b(?:feel|feels|sound|sounds|is|seems)\b[^,?]*\b(?:weak|boring|flat|dull|empty|underwhelming|lifeless|lame|static|predictable|anticlimactic)\b|\bwhy (?:does|is|do)\b[^,?]*\b(?:not work|lack|fall flat)\b|\b(?:does not|not) (?:work|hit|land|build)\b|\blacks? (?:energy|punch|lift|impact)\b/,
  whatIf: /\bwhat (?:would|will) happen if\b|\bwhat if\b|\bhow would (?:it|this|the [\w-]+) (?:sound|feel)\b|\bwould it (?:sound|feel)\b/,
  contrast: /\bcontrast\b|\bmore different from\b|\bstand out (?:more )?from\b|\bdistinguish\b|\bless similar to\b|\bdiffer more\b/,
  addInstrument:
    /\badd(?:ing)? (?:a |an |some )?(?:[\w-]+ )?(strings|string section|string pad|pads?|piano|keys|organ|choir|brass|horns|synths?|guitar|violins?|cellos?|flute|bells|glockenspiel|harp|marimba)\b/,
  explain: /\bexplain\b|\banaly[sz]e\b|\bwhy does (?:the )?[\w-]+(?: \d)? (?:work|sound good|feel good|sound so good)\b|\bmusic theory\b|\bwhat is happening harmonically\b|\bwhy is (?:the )?[\w-]+ (?:so )?(?:catchy|effective)\b/,
};

const MIX_HINT = /\b(?:mix|eq|reverb|delay|clearer|clarity|muddy|muddiness|punch(?:y|ier)?|hit harder|wider|narrower|pan|drier|wetter|compress(?:ion|or)?|louder in the mix|farther back|further back|bring [\w ]+ forward|harsh)\b/;

interface Stats {
  span: SectionSpan;
  activeParts: number;
  notesPerBar: number;
  melodyAvg?: number;
  drumHitsPerBar: number;
}

function stats(song: Song, span: SectionSpan): Stats {
  const bars = Math.max(1, span.endBar - span.startBar);
  const tracks = song.tracks.filter((t) => t.kind === 'midi' && t.notes.some((n) => n.tick >= span.startTick && n.tick < span.endTick));
  const notes = tracks.reduce((s, t) => s + t.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick).length, 0);
  const mel = findMelodyTrack(song);
  const mNotes = mel ? mel.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick) : [];
  const drumHits = tracks.filter(isDrumTrack).reduce((s, t) => s + t.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick).length, 0);
  return { span, activeParts: tracks.length, notesPerBar: round2(notes / bars), melodyAvg: mNotes.length ? avgPitch(mNotes) : undefined, drumHitsPerBar: round2(drumHits / bars) };
}

function chordsOf(song: Song, span: SectionSpan): ChordSlot[] {
  return chordSlots(song).filter((c) => c.tick >= span.startTick && c.tick < span.endTick);
}

function barsLabel(span: SectionSpan): string {
  return `bars ${span.startBar + 1}–${span.endBar}`;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Section the question is about: mention → selection → preferred kinds → first section. */
function pickSection(song: Song, text: string, selection: EditSelection | undefined, prefer: SectionKind[] = []): SectionSpan | undefined {
  const layout = sectionLayout(song);
  const mentions = findSectionMentions(song, text).filter((m) => m.sections.length);
  const selIds = selection?.sectionIds ?? [];
  const selR = selectionRanges(song, selection);
  const selSpan = layout.find((s) => selIds.includes(s.section.id)) ?? (selR ? layout.find((s) => selR[0].startTick >= s.startTick && selR[0].startTick < s.endTick) : undefined);
  if (mentions.length) {
    const cands = mentions[0].sections;
    if (/\bthis\b/.test(text) && selSpan && cands.some((c) => c.id === selSpan.section.id)) return selSpan;
    return layout.find((s) => s.section.id === cands[0].id);
  }
  if (selSpan) return selSpan;
  for (const k of prefer) {
    const s = layout.find((x) => x.section.kind === k);
    if (s) return s;
  }
  return layout[0];
}

function sectionKey(song: Song, span: SectionSpan): KeySignature {
  return sectionAnalysisKey(song, span.section.id);
}

// ---------------------------------------------------------------------------
// Simple facts
// ---------------------------------------------------------------------------

function answerKey(song: Song): AssistantAnswer {
  const key = keyAtBar(song, 0);
  const rel = relativeKey(key);
  const layout = sectionLayout(song);
  const local = layout
    .map((s) => ({ s, k: sectionKey(song, s) }))
    .filter((x) => x.k.tonic !== key.tonic || x.k.mode !== key.mode)
    .map((x) => `${x.s.section.name} centres on ${keyName(x.k)}`);
  const changes = [...song.keyMap].sort((a, b) => a.bar - b.bar).slice(1).map((k) => `a key change to ${keyName(k.key)} at bar ${k.bar + 1}`);
  const parts = [`The song is in ${keyName(key)}${rel.tonic !== key.tonic || rel.mode !== key.mode ? ` (relative ${key.mode === 'major' ? 'minor' : 'major'}: ${keyName(rel)})` : ''}.`];
  if (local.length) parts.push(`${listJoin(local)} — same key signature, different centre of gravity.`);
  if (changes.length) parts.push(`There is ${listJoin(changes)}.`);
  return { answer: parts.join(' '), intents: ['key'] };
}

function answerChords(song: Song, text: string, selection?: EditSelection): AssistantAnswer {
  const layout = sectionLayout(song);
  const mentioned = findSectionMentions(song, text).flatMap((m) => m.sections);
  const spans = mentioned.length ? layout.filter((s) => mentioned.some((m) => m.id === s.section.id)) : selection?.sectionIds?.length ? layout.filter((s) => selection.sectionIds!.includes(s.section.id)) : layout;
  const seen = new Map<string, string[]>();
  for (const s of spans) {
    const ex = explainSection(song, s.section.id);
    const line = ex.chords.length ? `${ex.chordSummary} — ${ex.romanSummary}` : 'no chords';
    seen.set(line, [...(seen.get(line) ?? []), `${s.section.name} (${barsLabel(s)})`]);
  }
  const lines = [...seen.entries()].map(([line, names]) => `${listJoin(names)}: ${line}`);
  if (!song.chords.length || !lines.length) return { answer: 'There are no chords yet — compose or enter a progression first.', intents: ['chords'] };
  return { answer: lines.join('\n'), intents: ['chords'] };
}

function answerLength(song: Song, text: string, selection?: EditSelection): AssistantAnswer {
  const layout = sectionLayout(song);
  if (!layout.length) return { answer: 'The song has no sections yet, so it has no length.', intents: ['length'] };
  const mentioned = findSectionMentions(song, text).flatMap((m) => m.sections);
  const ids = mentioned.length ? mentioned.map((m) => m.id) : /\bthis (?:section|part)\b/.test(text) ? (selection?.sectionIds ?? []) : [];
  if (ids.length) {
    const lines = layout
      .filter((s) => ids.includes(s.section.id))
      .map((s) => `${s.section.name}: ${plural(s.endBar - s.startBar, 'bar')} (${barsLabel(s)}), ${fmtTime(tickToSeconds(song, s.endTick) - tickToSeconds(song, s.startTick))} at ${Math.round(bpmAtTick(song, s.startTick))} BPM.`);
    return { answer: lines.join('\n'), intents: ['length'] };
  }
  const bars = layout.length ? layout[layout.length - 1].endBar : 0;
  const meter = meterAtBar(song, 0);
  return {
    answer: `${fmtTime(songDurationSeconds(song))} — ${bars} bars at ${Math.round(bpmAtTick(song, 0))} BPM in ${meter.numerator}/${meter.denominator}, across ${plural(layout.length, 'section')}.`,
    intents: ['length'],
  };
}

function answerMeter(song: Song): AssistantAnswer {
  const meters = [...song.meterMap].sort((a, b) => a.bar - b.bar);
  const first = meterAtBar(song, 0);
  const sig = (m: { numerator: number; denominator: number }) => `${m.numerator}/${m.denominator}`;
  const changes = meters.filter((m) => m.bar > 0).map((m) => `${sig(m)} from bar ${m.bar + 1}`);
  const feel =
    first.numerator === 6 || first.numerator === 9 || first.numerator === 12
      ? ' — a compound meter, felt in groups of three eighth notes'
      : first.numerator === 3
        ? ' — three beats per bar (waltz time)'
        : first.numerator === 4 && first.denominator === 4
          ? ' (common time)'
          : '';
  return {
    answer: changes.length ? `The song starts in ${sig(first)}${feel}, then changes to ${listJoin(changes)}.` : `${sig(first)} throughout${feel}, at ${Math.round(bpmAtTick(song, 0))} BPM.`,
    intents: ['meter'],
  };
}

function answerTempo(song: Song): AssistantAnswer {
  const changes = song.tempoMap.length > 1 ? ` with ${plural(song.tempoMap.length - 1, 'tempo change')}` : '';
  const feels = song.sections.filter((s) => s.feel && s.feel !== 'normal').map((s) => `${s.name} is ${s.feel}`);
  const meter = meterAtBar(song, 0);
  return { answer: `${Math.round(bpmAtTick(song, 0))} BPM in ${meter.numerator}/${meter.denominator}${changes}.${feels.length ? ` ${listJoin(feels)}.` : ''}`, intents: ['tempo'] };
}

function answerStructure(song: Song): AssistantAnswer {
  const layout = sectionLayout(song);
  return {
    answer: layout.map((s) => `${s.section.name}: ${barsLabel(s)}, energy ${s.section.energy}${s.section.energyEnd !== undefined ? `→${s.section.energyEnd}` : ''}${s.section.purpose ? ` — ${s.section.purpose}` : ''}`).join('\n'),
    intents: ['structure'],
  };
}

function answerInstruments(song: Song, text: string, selection?: EditSelection): AssistantAnswer {
  const mentions = findSectionMentions(song, text).flatMap((m) => m.sections);
  const layout = sectionLayout(song);
  if (!mentions.length && !selection?.sectionIds?.length) {
    const list = song.tracks.map((t) => `${t.name} (${t.role}${t.constraints.function ? `, ${t.constraints.function}` : ''})`);
    return { answer: `${plural(song.tracks.length, 'track')}: ${list.join(', ')}.`, intents: ['instruments'] };
  }
  const ids = mentions.length ? mentions.map((m) => m.id) : selection!.sectionIds!;
  const lines = layout
    .filter((s) => ids.includes(s.section.id))
    .map((s) => {
      const playing = song.tracks.filter((t) => t.notes.some((n) => n.tick >= s.startTick && n.tick < s.endTick) || t.clips.some((c) => c.tick >= s.startTick && c.tick < s.endTick));
      const silent = song.tracks.filter((t) => !playing.includes(t));
      return `In ${s.section.name} (${barsLabel(s)}): ${playing.length ? listJoin(playing.map((t) => t.name)) : 'nothing'}${silent.length ? `; silent: ${listJoin(silent.map((t) => t.name))}` : ''}.`;
    });
  return { answer: lines.join('\n'), intents: ['instruments'] };
}

function answerLyrics(song: Song, text: string): AssistantAnswer {
  const mentions = findSectionMentions(song, text).flatMap((m) => m.sections);
  const secs = mentions.length ? mentions : song.sections;
  const lines = secs
    .map((s) => ({ s, lines: song.lyrics.filter((l) => l.sectionId === s.id) }))
    .filter((x) => x.lines.length)
    .map((x) => `${x.s.name}:\n${x.lines.map((l) => `  ${l.text}`).join('\n')}`);
  return { answer: lines.length ? lines.join('\n') : 'There are no lyrics yet. I can generate placeholder lyrics for any section.', intents: ['lyrics'] };
}

function answerEnergy(song: Song): AssistantAnswer {
  const layout = sectionLayout(song);
  const peak = layout.reduce((a, b) => (b.section.energy > a.section.energy ? b : a), layout[0]);
  return {
    answer: `${layout.map((s) => `${s.section.name} ${s.section.energy}${s.section.energyEnd !== undefined ? `→${s.section.energyEnd}` : ''}`).join(' · ')}. The peak is ${peak?.section.name} (${peak?.section.energy}).`,
    intents: ['energy'],
  };
}

function answerRange(song: Song): AssistantAnswer {
  const mel = findMelodyTrack(song);
  if (!mel || !mel.notes.length) return { answer: 'There is no melody yet.', intents: ['range'] };
  const key = keyAtBar(song, 0);
  const lo = Math.min(...mel.notes.map((n) => n.pitch));
  const hi = Math.max(...mel.notes.map((n) => n.pitch));
  const { low, high } = trackPitchRange(mel);
  const out = mel.notes.filter((n) => n.pitch < low || n.pitch > high).length;
  return {
    answer: `${mel.name} spans ${midiToNoteNameInKey(lo, key)}–${midiToNoteNameInKey(hi, key)} (${hi - lo} semitones). ${out ? `${plural(out, 'note')} fall outside the comfortable range ${midiToNoteNameInKey(low, key)}–${midiToNoteNameInKey(high, key)}.` : `Everything sits inside ${midiToNoteNameInKey(low, key)}–${midiToNoteNameInKey(high, key)}.`}`,
    intents: ['range'],
  };
}

// ---------------------------------------------------------------------------
// Melody: variety, repetition, contour
// ---------------------------------------------------------------------------

/** A question (not a command): "is the melody too repetitive?", "how does the hook work". */
function isQuestion(question: string, text: string): boolean {
  return /\?\s*$/.test(question.trim()) || /^(?:is|are|does|do|did|why|how|what|which|where|can you (?:tell|describe|explain|analy[sz]e)|could you (?:tell|describe|explain)|describe|tell me|analy[sz]e)\b/.test(text);
}

/** Phrases of a melody: lyric lines when present, otherwise notes separated by rests of a beat or more. */
function melodyPhrases(notes: Track['notes'], ppq: number): Track['notes'][] {
  const out: Track['notes'][] = [];
  let cur: Track['notes'] = [];
  for (const n of notes) {
    const prev = cur[cur.length - 1];
    const newLine = prev && n.lyricLineId !== undefined && prev.lyricLineId !== undefined && n.lyricLineId !== prev.lyricLineId;
    const rest = prev && n.tick - (prev.tick + prev.duration) >= ppq;
    if (prev && (newLine || rest)) {
      out.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) out.push(cur);
  return out;
}

function answerMelody(song: Song, text: string, selection?: EditSelection): AssistantAnswer {
  const mel = findMelodyTrack(song);
  if (!mel || !mel.notes.length) return { answer: 'There is no melody yet.', intents: ['melody'] };
  const layout = sectionLayout(song);
  const mentioned = findSectionMentions(song, text).flatMap((m) => m.sections);
  const wanted = mentioned.length ? mentioned.map((m) => m.id) : (selection?.sectionIds ?? []);
  const inSpan = (sp: SectionSpan) => mel.notes.filter((n) => n.tick >= sp.startTick && n.tick < sp.endTick).sort((a, b) => a.tick - b.tick);
  let spans = layout.filter((sp) => (!wanted.length || wanted.includes(sp.section.id)) && inSpan(sp).length >= 2);
  // A repeated section (Chorus 2 = Chorus 1) is described once.
  spans = spans.filter((sp) => !sp.section.repeatOf || !spans.some((x) => x.section.id === sp.section.repeatOf));
  if (!spans.length) return { answer: `${mel.name} has no melody in ${wanted.length ? 'that section' : 'the song'} yet.`, intents: ['melody'] };
  const asksRepetition = /\brepetit|\brepeat|\bboring|\bmonoton|\bpredictable|\bvariety|\bvaried\b/.test(text);
  const lines: string[] = [];
  const suggestions: string[] = [];
  const verdicts: { name: string; kind: SectionKind; repetitive: boolean; why: string }[] = [];
  for (const sp of spans) {
    const notes = inSpan(sp);
    const phrases = melodyPhrases(notes, song.ppq);
    const rhythmSig = (p: Track['notes']) => p.map((n) => `${n.tick - p[0].tick}:${Math.round(n.duration / (song.ppq / 4))}`).join(',');
    const pitchSig = (p: Track['notes']) => p.map((n) => n.pitch).join(',');
    const rhythms = new Set(phrases.map(rhythmSig));
    let exact = 0;
    let sharedOpenings = 0;
    phrases.forEach((p, i) => {
      const earlier = phrases.slice(0, i);
      if (earlier.some((q) => pitchSig(q) === pitchSig(p) && rhythmSig(q) === rhythmSig(p))) exact++;
      else if (p.length >= 4 && earlier.some((q) => q.length >= 4 && pitchSig(q.slice(0, 4)) === pitchSig(p.slice(0, 4)))) sharedOpenings++;
    });
    const distinct = new Set(notes.map((n) => n.pitch)).size;
    const lo = Math.min(...notes.map((n) => n.pitch));
    const hi = Math.max(...notes.map((n) => n.pitch));
    const sx = explainSection(song, sp.section.id);
    const ex = sx.melody;
    const facts: string[] = [];
    facts.push(
      `${plural(phrases.length, 'phrase')}${phrases.length > 1 ? ` using ${rhythms.size === 1 ? 'one rhythm throughout' : `${rhythms.size} different rhythms`}` : ''}`,
    );
    if (exact) facts.push(`${plural(exact, 'phrase')} ${exact === 1 ? 'repeats' : 'repeat'} an earlier one exactly`);
    if (sharedOpenings) facts.push(`${sharedOpenings === 1 ? 'one phrase starts' : `${sharedOpenings} phrases start`} like an earlier one and then goes somewhere new`);
    facts.push(`${distinct} different pitches over ${ex?.lowest ?? lo}–${ex?.highest ?? hi} (${hi - lo} semitones)`);
    if (ex) facts.push(`${Math.round(ex.stepwiseRatio * 100)}% stepwise motion${sx.chords.length ? `, ${Math.round(ex.chordToneRatio * 100)}% chord tones` : ''}, ${ex.contour} contour`);
    const share = phrases.length > 1 ? (exact + 0.5 * sharedOpenings) / (phrases.length - 1) : 0;
    const sameRhythm = phrases.length >= 3 && rhythms.size === 1;
    const narrow = hi - lo <= 7 || distinct <= 4;
    const repetitive = share >= 0.5 || (sameRhythm && (share > 0 || narrow));
    const why = [sameRhythm ? 'every phrase uses the same rhythm' : '', exact ? 'phrases repeat exactly' : '', narrow ? 'the range is narrow' : ''].filter(Boolean);
    verdicts.push({ name: sp.section.name, kind: sp.section.kind, repetitive, why: listJoin(why.length ? why : ['phrases echo each other']) });
    lines.push(`${sp.section.name} (${barsLabel(sp)}): ${facts.join('; ')}.`);
  }
  const rep = verdicts.filter((v) => v.repetitive);
  if (asksRepetition || rep.length) {
    for (const v of rep) {
      const chorusLike = v.kind === 'chorus' || v.kind === 'final-chorus' || v.kind === 'post-chorus';
      if (chorusLike) {
        lines.push(`${v.name} is repetitive (${v.why}) — which suits a chorus: repetition is what makes a hook stick. If it feels too static, vary the last phrase so the section has a payoff.`);
        suggestions.push(`Keep the rhythm but change the pitches in the last 2 bars of ${v.name}`);
      } else {
        lines.push(`${v.name} is the more repetitive part (${v.why}). Varying the rhythm of the second half or letting one phrase climb higher would keep it moving.`);
        suggestions.push(`Change the rhythm of the melody in ${v.name}`);
        suggestions.push(`Keep the rhythm but change the pitches in the last 2 bars of ${v.name}`);
      }
    }
    if (!rep.length) lines.push('It is not especially repetitive: the phrases vary in rhythm and pitch while still echoing each other enough to feel connected.');
  }
  return { answer: lines.join('\n'), intents: ['melody'], suggestions: suggestions.length ? [...new Set(suggestions)].slice(0, 3) : undefined };
}

// ---------------------------------------------------------------------------
// Diagnosis: why does a section feel weak?
// ---------------------------------------------------------------------------

function dominantFixOps(song: Song, span: SectionSpan, key: KeySignature, reason: string): { ops: MusicOperation[]; desc: string } | null {
  if (isLocked(song.locks, LockKeys.chords) || isChordSectionLocked(song, span.section.id)) return null;
  const slots = chordSlots(song);
  const inSec = slots.filter((c) => c.tick >= span.startTick && c.tick < span.endTick);
  const last = inSec[inSec.length - 1];
  if (!last) return null;
  const V: ChordSpec = { root: mod12(key.tonic + 7), quality: 'maj' };
  const finalSlots: ChordSlot[] = [];
  const twoBeats = 2 * song.ppq;
  for (const s of slots) {
    if (s !== last) {
      finalSlots.push(s);
      continue;
    }
    if (s.duration >= 2 * twoBeats) {
      const half = Math.round(s.duration / 2);
      finalSlots.push({ ...s, duration: half });
      finalSlots.push({ tick: s.tick + half, duration: s.duration - half, spec: { root: V.root, quality: '7sus4' }, sourceId: s.sourceId });
    } else finalSlots.push({ ...s, spec: { root: V.root, quality: '7' } });
  }
  const changed = finalSlots.find((s) => s.sourceId === last.sourceId && s.spec.quality === '7sus4');
  const desc = changed
    ? `keep ${spellChord(last.spec, key)} for the first half of the last chord and move to ${spellChord({ root: V.root, quality: '7sus4' }, key)} (V7sus4) — a dominant that points straight at the next section`
    : `change the last chord to ${spellChord({ root: V.root, quality: '7' }, key)} (V7)`;
  const res = chordOpsFromSlots(song, finalSlots, reason);
  if (!res.ops.length) return null;
  const ops = [...res.ops];
  // Fit the accompaniment (not the melody) to the new last chord.
  for (const track of song.tracks) {
    if (!isPitchedTrack(track) || isMelodicTrack(track)) continue;
    const isL = lockChecker(song, track);
    const work: WorkNote[] = track.notes.map(toWork);
    const editable = work.filter((n, i) => n.tick >= last.tick && n.tick < last.tick + last.duration && !isL(track.notes[i]));
    if (!editable.length) continue;
    const { low, high } = trackPitchRange(track);
    const fit = refitNotes(
      { song, track, rng: deriveRng(song.generation?.seed ?? 1, 'assistant-dominant-fix', track.id), ranges: [{ startTick: last.tick, endTick: last.tick + last.duration }], context: work, chords: finalSlots, isDrums: false, isBass: isBassTrack(track), isVocal: isVocalTrack(track), isMelodic: false, low, high, amount: 1 },
      editable,
      slots,
      finalSlots,
    );
    if (!fit.summary) continue;
    const set = new Set(editable);
    ops.push(...emitNoteOps(song, track, track.notes, [...work.filter((n) => !set.has(n)), ...fit.notes], { reason }).ops);
  }
  return { ops, desc };
}

function whyWeak(song: Song, span: SectionSpan, question: string): AssistantAnswer {
  const layout = sectionLayout(song);
  const idx = layout.findIndex((x) => x.section.id === span.section.id);
  const prev = layout[idx - 1];
  const next = layout[idx + 1];
  const sec = span.section;
  const reason = question.trim();
  const findings: string[] = [];
  const fixes: string[] = [];
  const ops: MusicOperation[] = [];
  const suggestions: string[] = [];
  const e0 = sec.energy;
  const e1 = sec.energyEnd ?? sec.energy;
  // Energy shape.
  if (next && next.section.energy - e1 >= 25) {
    findings.push(`Energy: it ${sec.energyEnd !== undefined ? `goes ${e0}→${e1}` : `sits flat at ${e0}`} and then jumps to ${next.section.energy} in ${next.section.name} — there's no ramp, so the arrival feels abrupt rather than earned.`);
    if (!isLocked(song.locks, LockKeys.structure)) {
      ops.push({ op: 'update_section', section: sec.id, changes: { energyEnd: Math.max(e0, next.section.energy - 8) }, reason });
      fixes.push(`ramp the section's energy from ${e0} to ${Math.max(e0, next.section.energy - 8)}`);
    }
  }
  if (prev && e0 - prev.section.energy <= 5) findings.push(`It starts at almost the same energy as ${prev.section.name} (${prev.section.energy} → ${e0}), so it doesn't register as a new stage.`);
  // Harmony.
  const key = sectionKey(song, span);
  const chords = chordsOf(song, span);
  if (chords.length) {
    const last = chords[chords.length - 1];
    const lastIsV = mod12(last.spec.root - key.tonic) === 7 && (triadQuality(last.spec.quality) === 'maj' || isDominantQuality(last.spec.quality) || last.spec.quality === '7sus4');
    const fn = chordFunction(last.spec, key);
    const nextChords = next ? chordsOf(song, next) : [];
    if (!lastIsV && next && (next.section.kind === 'chorus' || next.section.kind === 'final-chorus' || next.section.kind === 'drop')) {
      findings.push(
        `Harmony: it ends on ${spellChord(last.spec, key)} (${romanOf(last.spec, key)}, ${fn} function)${fn === 'tonic' ? ', which releases tension before the chorus instead of pointing at it' : ''} — there's no dominant to set up ${next.section.name}${nextChords[0] ? `'s ${spellChord(nextChords[0].spec, key)}` : ''}.`,
      );
      const fix = dominantFixOps(song, span, key, reason);
      if (fix) {
        ops.push(...fix.ops);
        fixes.push(fix.desc);
      } else suggestions.push(`End ${sec.name} on V (${spellChord({ root: mod12(key.tonic + 7), quality: '7' }, key)}) — its chords are locked, so I didn't change them.`);
    }
    const fns = chords.map((c) => chordFunction(c.spec, key));
    if (!fns.includes('predominant') && !fns.includes('dominant')) findings.push('The harmony never leaves tonic-function chords, so nothing pulls forward.');
    if (prev) {
      const a = chordsOf(song, prev).map((c) => spellChord(c.spec, key)).join(' ');
      const b = chords.map((c) => spellChord(c.spec, key)).join(' ');
      if (a && a === b) findings.push(`It reuses ${prev.section.name}'s progression exactly, so nothing new happens harmonically.`);
    }
  }
  // Arrangement density.
  const s = stats(song, span);
  const p = prev ? stats(song, prev) : undefined;
  if (p && s.activeParts <= p.activeParts && s.notesPerBar <= p.notesPerBar * 1.1) {
    findings.push(`Arrangement: ${plural(s.activeParts, 'part')} and ${s.notesPerBar} notes per bar — no fuller than ${prev!.section.name} (${p.activeParts} parts, ${p.notesPerBar} notes per bar), so nothing builds.`);
    const drums = song.tracks.find((t) => isDrumTrack(t) && t.notes.some((n) => n.tick >= span.startTick && n.tick < span.endTick));
    if (drums) {
      const startBar = Math.max(span.startBar, span.endBar - 2);
      const sub = interpretEditInstruction(song, 'add tension', { trackIds: [drums.id], startTick: barToTick(song, startBar), endTick: span.endTick }, { seed: song.generation?.seed });
      if (sub.operations.length) {
        ops.push(...sub.operations);
        fixes.push(`a crescendo and snare build on the ${drums.name} over the last two bars`);
      }
    }
  }
  // Melody register.
  if (p && s.melodyAvg !== undefined && p.melodyAvg !== undefined && s.melodyAvg - p.melodyAvg < 2) {
    const k = keyAtBar(song, span.startBar);
    findings.push(`The melody stays in ${prev!.section.name}'s register (average ${midiToNoteNameInKey(Math.round(s.melodyAvg), k)} vs ${midiToNoteNameInKey(Math.round(p.melodyAvg), k)}); rising a third or so would add urgency.`);
    suggestions.push(`Raise the last phrase of the ${sec.name} melody (e.g. select it and say "move it up a third").`);
  }
  if (!findings.length) findings.push(`Structurally it's sound: energy ${e0}${next ? ` leading into ${next.section.name} at ${next.section.energy}` : ''}, ${plural(s.activeParts, 'active part')}, and a clear harmonic direction. If it still feels weak, try a rhythmic change (pushes or a drum fill into the next section).`);
  suggestions.push(`Try "Increase tension" for ${sec.name} in the Theory View.`, `Drop the bass for the first two bars of ${sec.name} and bring it back for the last two.`);
  const answer = [`${sec.name} (${barsLabel(span)}) may feel weak because:`, ...findings.map((f) => `• ${f}`), ops.length ? `Proposed fix: ${listJoin(fixes)}. Review it as a proposal — nothing changes until you accept.` : ''].filter(Boolean).join('\n');
  return { answer, operations: ops.length ? ops : undefined, suggestions, intents: ['why-weak'] };
}

// ---------------------------------------------------------------------------
// What if…
// ---------------------------------------------------------------------------

function whatIf(song: Song, text: string, question: string, selection?: EditSelection): AssistantAnswer | null {
  const span = pickSection(song, text, selection, ['chorus']);
  if (!span) return null;
  const layout = sectionLayout(song);
  const idx = layout.findIndex((x) => x.section.id === span.section.id);
  const prev = layout[idx - 1];
  const sec = span.section;
  const bpm = Math.round(bpmAtTick(song, span.startTick));
  if (/\bhalf[\s-]?time\b|\bdouble[\s-]?time\b/.test(text)) {
    const half = /\bhalf/.test(text);
    const st = stats(song, span);
    const sub = interpretEditInstruction(song, half ? 'change the drums to half-time' : 'change the drums to double-time', { sectionIds: [sec.id] }, { seed: song.generation?.seed });
    const answer = half
      ? `${sec.name} runs at ${bpm} BPM with the backbeat on 2 and 4. In half-time the snare moves to beat 3 and the groove spreads out (about ${Math.round(st.drumHitsPerBar / 2)} drum hits per bar instead of ${Math.round(st.drumHitsPerBar)}), so it would feel like ~${Math.round(bpm / 2)} BPM even though the tempo, chords and melody stay the same. Expect it to sound heavier, wider and more anthemic, but with less forward drive${prev ? ` — and coming straight after ${prev.section.name} (energy ${prev.section.energy}) it could read as a drop rather than a lift unless the arrangement gets bigger at the same time` : ''}. Half-time is a classic move for a final chorus, a breakdown or a bridge.`
      : `In double-time the groove doubles its subdivision (backbeat on every off-beat), so ${sec.name} would feel like ~${bpm * 2} BPM: more frantic and urgent, a punk/pop-punk lift. The melody and chords stay the same, but sustained vocal lines can feel slower against the busier drums.`;
    return {
      answer: `${answer} I've prepared the drum change${sub.operations.some((o) => o.op === 'update_section') ? ' (and the section feel)' : ''} as a proposal if you want to hear it.`,
      operations: sub.operations.length ? sub.operations : undefined,
      suggestions: half ? ['Keep 8th-note hi-hats over the half-time backbeat to retain some drive.', 'Use half-time only for the first half of the chorus, then switch back.'] : ['Keep the kick on the quarter notes so the low end stays grounded.'],
      intents: ['what-if', half ? 'half-time' : 'double-time'],
    };
  }
  if (/\b(?:minor|darker|sadder|major|brighter|happier)\b/.test(text)) {
    const control = /\b(?:minor|darker|sadder)\b/.test(text) ? 'darker' : 'brighter';
    const r = applyTheoryControl(song, sec.id, control, { seed: song.generation?.seed ?? 1 });
    return { answer: `If ${sec.name} were ${control === 'darker' ? 'in the parallel minor' : 'brighter'}: ${r.explanation}`, operations: r.operations.length ? r.operations : undefined, intents: ['what-if', control] };
  }
  const tempoM = /\b(\d{2,3})\s*bpm\b/.exec(text);
  if (tempoM || /\b(?:faster|slower)\b/.test(text)) {
    const target = tempoM ? parseInt(tempoM[1], 10) : Math.round(bpm * (/\bfaster\b/.test(text) ? 1.1 : 0.9) * (amountOf(text) > 1 ? 1.1 : 1));
    const pct = Math.round(((target - bpm) / bpm) * 100);
    return {
      answer: `At ${target} BPM (${pct > 0 ? '+' : ''}${pct}%) everything keeps its notes and structure; the song gets ${pct > 0 ? 'more urgent and energetic, and busy parts (16th hats, fast vocal syllables) get harder to play and sing' : 'heavier and more spacious, and sustained notes and pads become more prominent'}. Section lengths in seconds change accordingly.`,
      operations: isLocked(song.locks, LockKeys.tempo) ? undefined : [{ op: 'set_tempo', bpm: target, reason: question.trim() }],
      intents: ['what-if', 'tempo'],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

function contrast(song: Song, text: string, question: string, selection?: EditSelection): AssistantAnswer | null {
  const layout = sectionLayout(song);
  const mentions = findSectionMentions(song, text).filter((m) => m.sections.length);
  const a = mentions[0] ? layout.find((s) => s.section.id === mentions[0].sections[0].id) : pickSection(song, text, selection, ['bridge']);
  if (!a) return null;
  const isChorus = (k: SectionKind) => k === 'chorus' || k === 'final-chorus';
  const bSec: Section | undefined = mentions[1]?.sections.find((x) => x.id !== a.section.id) ?? song.sections.find((x) => isChorus(x.kind) && x.id !== a.section.id);
  const b = bSec ? layout.find((s) => s.section.id === bSec.id) : undefined;
  if (!b) return null;
  const reason = question.trim();
  const keyA = sectionKey(song, a);
  const chA = chordsOf(song, a).map((c) => spellChord(c.spec, keyA));
  const chB = new Set(chordsOf(song, b).map((c) => spellChord(c.spec, keyA)));
  const sharedChords = [...new Set(chA.filter((c) => chB.has(c)))];
  const shared = chA.length ? chA.filter((c) => chB.has(c)).length / chA.length : 0;
  const sa = stats(song, a);
  const sb = stats(song, b);
  const findings: string[] = [];
  const fixes: string[] = [];
  const ops: MusicOperation[] = [];
  if (shared >= 0.5) {
    findings.push(
      `${chA.filter((c) => chB.has(c)).length} of ${a.section.name}'s ${chA.length} chords (${sharedChords.join(', ')}) also appear in ${b.section.name}, so the two sections sound alike harmonically.`,
    );
    const chorusKey = sectionKey(song, b);
    const control = chorusKey.mode === 'major' ? 'darker' : 'brighter';
    const r = applyTheoryControl(song, a.section.id, control, { seed: song.generation?.seed ?? 1 });
    if (r.operations.length) {
      ops.push(...r.operations);
      fixes.push(`re-colour ${a.section.name}'s harmony (${control === 'darker' ? 'borrowing from the parallel minor' : 'brightening toward the parallel major'})`);
    }
  }
  const de = sb.span.section.energy - a.section.energy;
  if (Math.abs(de) < 20) {
    findings.push(`Energy is close: ${a.section.name} ${a.section.energy} vs ${b.section.name} ${b.section.energy}.`);
    if (!isLocked(song.locks, LockKeys.structure)) {
      const lowE = Math.max(20, b.section.energy - 30);
      ops.push({ op: 'update_section', section: a.section.id, changes: { energy: lowE, energyEnd: Math.max(lowE, b.section.energy - 5) }, reason });
      fixes.push(`drop ${a.section.name} to energy ${lowE} and let it build back to ${Math.max(lowE, b.section.energy - 5)}`);
    }
  }
  if ((a.section.feel ?? 'normal') === (b.section.feel ?? 'normal')) {
    findings.push(`Both sections use the same ${a.section.feel ?? 'normal'} rhythmic feel${Math.abs(sa.activeParts - sb.activeParts) <= 1 ? ` and similar density (${sa.activeParts} vs ${sb.activeParts} parts)` : ''}.`);
    const sub = interpretEditInstruction(song, 'change the drums to half-time', { sectionIds: [a.section.id] }, { seed: song.generation?.seed });
    if (sub.operations.length) {
      ops.push(...sub.operations);
      fixes.push(`put ${a.section.name}'s drums in half-time`);
    }
  }
  if (sa.melodyAvg !== undefined && sb.melodyAvg !== undefined && Math.abs(sa.melodyAvg - sb.melodyAvg) < 3) findings.push(`The melody sits in the same register in both (try a lower, more conversational line in ${a.section.name}).`);
  if (!findings.length) findings.push(`${a.section.name} already differs from ${b.section.name} in harmony, energy and feel.`);
  return {
    answer: [`To make ${a.section.name} contrast more with ${b.section.name}:`, ...findings.map((f) => `• ${f}`), fixes.length ? `Proposed: ${listJoin(fixes)}.` : ''].filter(Boolean).join('\n'),
    operations: ops.length ? ops : undefined,
    suggestions: [`Thin out ${a.section.name}: let the bass or guitars drop out for the first half.`, `Start ${a.section.name} on a different chord than ${b.section.name} (e.g. IV or vi).`],
    intents: ['contrast'],
  };
}

// ---------------------------------------------------------------------------
// Add an instrument without crowding
// ---------------------------------------------------------------------------

const ADD_INSTRUMENTS: { re: RegExp; id: string; name: string; role: Track['role']; fn: NonNullable<Track['constraints']['function']>; range: [number, number] }[] = [
  { re: /\bstring(?:s| section| pad)\b/, id: 'string-ensemble', name: 'String Pad', role: 'strings', fn: 'pad', range: [48, 79] },
  { re: /\bviolins?\b/, id: 'violin', name: 'Violin Pad', role: 'strings', fn: 'pad', range: [55, 88] },
  { re: /\bcellos?\b/, id: 'cello', name: 'Cello Pad', role: 'strings', fn: 'pad', range: [36, 64] },
  { re: /\bpads?\b|\bsynths?\b/, id: 'synth-pad', name: 'Synth Pad', role: 'synth-pad', fn: 'pad', range: [48, 84] },
  { re: /\borgan\b/, id: 'organ', name: 'Organ Pad', role: 'keys', fn: 'pad', range: [48, 79] },
  { re: /\bpiano\b|\bkeys\b/, id: 'piano', name: 'Piano Comp', role: 'keys', fn: 'accompaniment', range: [48, 84] },
  { re: /\bchoir\b/, id: 'choir', name: 'Choir Pad', role: 'vocal', fn: 'pad', range: [52, 76] },
  { re: /\bbrass\b|\bhorns\b/, id: 'brass-section', name: 'Brass Pad', role: 'custom', fn: 'pad', range: [48, 76] },
  { re: /\bflute\b/, id: 'flute', name: 'Flute Pad', role: 'custom', fn: 'pad', range: [60, 88] },
  { re: /\bguitar\b/, id: 'electric-guitar-clean', name: 'Clean Guitar', role: 'rhythm-guitar', fn: 'accompaniment', range: [45, 76] },
  { re: /\bbells\b|\bglockenspiel\b/, id: 'glockenspiel', name: 'Bell Layer', role: 'keys', fn: 'texture', range: [79, 100] },
  { re: /\bharp\b/, id: 'harp', name: 'Harp Layer', role: 'keys', fn: 'accompaniment', range: [48, 88] },
  { re: /\bmarimba\b/, id: 'marimba', name: 'Marimba Layer', role: 'keys', fn: 'accompaniment', range: [48, 84] },
];

function addInstrument(song: Song, text: string, question: string): AssistantAnswer | null {
  const inst = ADD_INSTRUMENTS.find((x) => x.re.test(text));
  if (!inst) return null;
  const layout = sectionLayout(song);
  if (!layout.length) return { answer: 'The song has no sections yet, so there is nowhere to add a part.', intents: ['add-instrument'] };
  let name = inst.name;
  for (let i = 2; song.tracks.some((t) => t.name.toLowerCase() === name.toLowerCase()); i++) name = `${inst.name} ${i}`;
  const st = layout.map((s) => stats(song, s));
  const sortedParts = [...st].sort((a, b) => a.activeParts - b.activeParts || a.notesPerBar - b.notesPerBar);
  const median = sortedParts[Math.floor((sortedParts.length - 1) / 2)];
  const maxParts = Math.max(...st.map((s) => s.activeParts));
  let chosen = st.filter((s) => s.activeParts < maxParts && (s.activeParts < median.activeParts || (s.activeParts === median.activeParts && s.notesPerBar <= median.notesPerBar)));
  if (!chosen.length) chosen = [sortedParts[0]];
  const melody = findMelodyTrack(song);
  const bass = song.tracks.find(isBassTrack);
  const notes: WorkNote[] = [];
  let prevVoicing: number[] | undefined;
  let lowUsed = 127;
  let highUsed = 0;
  for (const c of chosen) {
    const span = c.span;
    const slots = chordSlots(song).filter((s) => s.tick < span.endTick && s.tick + s.duration > span.startTick);
    for (const slot of slots) {
      const s = Math.max(slot.tick, span.startTick);
      const e = Math.min(slot.tick + slot.duration, span.endTick);
      const melNotes = melody ? melody.notes.filter((n) => n.tick < e && n.tick + n.duration > s) : [];
      const bassNotes = bass ? bass.notes.filter((n) => n.tick < e && n.tick + n.duration > s) : [];
      let low = Math.max(inst.range[0], bassNotes.length ? Math.max(...bassNotes.map((n) => n.pitch)) + 3 : inst.range[0]);
      let high = Math.min(inst.range[1], melNotes.length ? Math.min(...melNotes.map((n) => n.pitch)) - 2 : inst.range[1]);
      if (high - low < 9) {
        // Not enough room under the melody: sit above it instead (a high, thin string line).
        low = melNotes.length ? Math.max(...melNotes.map((n) => n.pitch)) + 3 : low;
        high = Math.min(inst.range[1], low + 14);
      }
      if (high - low < 7) continue;
      const voicing = voiceChord({ root: slot.spec.root, quality: slot.spec.quality }, { low, high, voices: 3, previous: prevVoicing, spread: 'close' });
      prevVoicing = voicing;
      const vel = Math.round(48 + span.section.energy / 5);
      for (const p of voicing) {
        notes.push({ pitch: p, tick: s, duration: Math.max(60, e - s - 30), velocity: vel, articulation: 'legato' });
        lowUsed = Math.min(lowUsed, p);
        highUsed = Math.max(highUsed, p);
      }
    }
  }
  if (!notes.length) return { answer: `I couldn't find room for ${inst.name.toLowerCase()} without crowding the melody and bass.`, intents: ['add-instrument'] };
  const reason = question.trim();
  const ops: MusicOperation[] = [
    { op: 'add_track', name, instrument_id: inst.id, role: inst.role, function: inst.fn, reason },
    { op: 'add_notes', track: name, notes: notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch).map((n) => toOpNote(song, n)), reason },
  ];
  const k = keyAtBar(song, 0);
  const skipped = layout.filter((s) => !chosen.some((c) => c.span === s)).map((s) => s.section.name);
  return {
    answer: `I'd add "${name}" (${inst.id}, ${inst.fn}) playing sustained, voice-led chords only in ${listJoin(chosen.map((c) => `${c.span.section.name} (${c.activeParts} parts)`))} — the sections with the fewest active parts — and keep the voicings between ${midiToNoteNameInKey(lowUsed, k)} and ${midiToNoteNameInKey(highUsed, k)}, clear of the bass and ${melody ? `the ${melody.name}` : 'the melody'}, so they fill space without masking anything.${skipped.length ? ` ${listJoin(skipped)} keep their current arrangement.` : ''}`,
    operations: ops,
    suggestions: [`Regenerate "${name}" with the composer for a more idiomatic part (same sections).`, `Add a crescendo on "${name}" into the next chorus.`],
    intents: ['add-instrument'],
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function summary(song: Song): AssistantAnswer {
  const ex = explainSong(song);
  return {
    answer: `${ex.overview.join(' ')}\nI can answer questions about the key, chords, tempo and meter, structure, instruments, lyrics, melody and energy; explain the theory of any section; diagnose why a section feels weak; try "what if" ideas (half-time, darker, faster); make sections contrast; add instruments without crowding the arrangement; and apply edits ("make the bass busier") or mix changes ("make the vocal clearer").`,
    intents: ['summary'],
    suggestions: ['Why does the pre-chorus feel weak?', 'What are the chords in the chorus?', 'Make the bridge contrast more strongly with the chorus.', 'Add strings without making the arrangement crowded.'],
  };
}

export function answerQuestion(song: Song, question: string, selection?: EditSelection): AssistantAnswer {
  const text = normalizeText(question);
  if (!text) return summary(song);
  if (Q.key.test(text)) return answerKey(song);
  if (Q.chords.test(text)) return answerChords(song, text, selection);
  if (Q.length.test(text)) return answerLength(song, text, selection);
  if (Q.meter.test(text)) return answerMeter(song);
  if (Q.tempo.test(text)) return answerTempo(song);
  if (Q.structure.test(text)) return answerStructure(song);
  if (Q.instruments.test(text)) return answerInstruments(song, text, selection);
  if (Q.lyrics.test(text)) return answerLyrics(song, text);
  if (Q.energy.test(text)) return answerEnergy(song);
  if (Q.range.test(text)) return answerRange(song);
  if (Q.melody.test(text) && Q.melodyJudge.test(text) && isQuestion(question, text)) return answerMelody(song, text, selection);
  if (Q.weak.test(text)) {
    const span = pickSection(song, text, selection, ['pre-chorus', 'verse']);
    if (span) return whyWeak(song, span, question);
  }
  if (Q.whatIf.test(text)) {
    const r = whatIf(song, text, question, selection);
    if (r) return r;
  }
  if (Q.contrast.test(text)) {
    const r = contrast(song, text, question, selection);
    if (r) return r;
  }
  if (Q.addInstrument.test(text)) {
    const r = addInstrument(song, text, question);
    if (r) return r;
  }
  if (Q.explain.test(text)) {
    const span = pickSection(song, text, selection, ['chorus']);
    const mentioned = findSectionMentions(song, text).some((m) => m.sections.length);
    if (span && (mentioned || selection?.sectionIds?.length)) {
      const ex = explainSection(song, span.section.id);
      return { answer: [`${ex.sectionName}: ${ex.chordSummary} — ${ex.romanSummary}`, ...ex.narrative, ...ex.comparisons.slice(0, 3)].join('\n'), intents: ['explain'] };
    }
    const ex = explainSong(song);
    return { answer: [...ex.overview, ...ex.sections.map((s) => `${s.sectionName}: ${s.chordSummary} — ${s.romanSummary}`)].join('\n'), intents: ['explain'] };
  }
  if (MIX_HINT.test(text)) {
    const mix = interpretMixInstruction(song, question, { selection });
    if (mix.understood && mix.operations.length) return { answer: mix.explanation, operations: mix.operations, intents: ['mix', ...mix.intents] };
  }
  const edit = interpretEditInstruction(song, question, selection ?? {}, { seed: song.generation?.seed });
  if (edit.understood) {
    const keptChords = /\b(?:do not|not|without|never|no) (?:change|changing|touch|alter)\b[^,]*\b(?:chords|harmony)\b|\bkeep (?:the )?chords\b/.test(text);
    return {
      answer: `${edit.explanation}${keptChords && !edit.operations.some((o) => o.op === 'set_chords') ? ' The chords are unchanged.' : ''}`,
      operations: edit.operations.length ? edit.operations : undefined,
      intents: ['edit', ...edit.intents],
    };
  }
  const mix = interpretMixInstruction(song, question, { selection });
  if (mix.understood && mix.operations.length) return { answer: mix.explanation, operations: mix.operations, intents: ['mix', ...mix.intents] };
  return summary(song);
}

