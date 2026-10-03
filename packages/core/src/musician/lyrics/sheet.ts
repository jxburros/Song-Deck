/**
 * Lyric sheets: turn lyrics pasted up front (a lyric site, a notes app, a chord sheet) into
 * ordered sections for lyrics-first composition (`Blueprint.lyrics`).
 *
 * Section headers are recognised in the common forms — `[Verse 1]`, `[Chorus]`, `[Pre-Chorus]`,
 * `[Hook]`, `[Verse 1: Artist]`, `Verse:`, `(Chorus)`, `CHORUS`, `Chorus x2`, `Repeat chorus` — and
 * a header without lines repeats the last stanza of that kind. Without headers, stanzas are split
 * on blank lines: repeated / near-duplicate stanzas are the chorus, a stanza that always leads into
 * it is the pre-chorus, everything before the first chorus is a verse and a unique stanza late in
 * the song is the bridge. Chord-only lines, inline ChordPro chords and stage directions are
 * dropped; the words themselves are never changed.
 */
import type { BlueprintLyrics, SectionKind } from '../../ir/types';
import { countSyllables } from './syllables';

export type LyricSheetSection = BlueprintLyrics['sections'][number];

const KIND_LABEL: Record<SectionKind, string> = {
  intro: 'Intro',
  verse: 'Verse',
  'pre-chorus': 'Pre-Chorus',
  chorus: 'Chorus',
  'post-chorus': 'Post-Chorus',
  bridge: 'Bridge',
  breakdown: 'Breakdown',
  build: 'Build',
  drop: 'Drop',
  solo: 'Solo',
  interlude: 'Interlude',
  'final-chorus': 'Final Chorus',
  outro: 'Outro',
  custom: 'Section',
};

/** Header words → section kind, most specific first. */
const HEADER_WORDS: [RegExp, SectionKind][] = [
  [/^(?:final|last)\s*chorus$/, 'final-chorus'],
  [/^pre\s*-?\s*(?:chorus|hook)$/, 'pre-chorus'],
  [/^post\s*-?\s*(?:chorus|hook)$/, 'post-chorus'],
  [/^(?:chorus|refrain|hook)$/, 'chorus'],
  [/^(?:verse|rap\s+verse|rap|spoken\s+verse)$/, 'verse'],
  [/^(?:bridge|middle\s*(?:8|eight))$/, 'bridge'],
  [/^(?:intro|introduction|opening)$/, 'intro'],
  [/^(?:outro|coda|ending|tag|fade\s*out)$/, 'outro'],
  [/^(?:(?:guitar|piano|sax|synth|instrumental|keyboard|bass|drum|violin)\s+)?solo$/, 'solo'],
  [/^(?:interlude|instrumental(?:\s+break)?|break|music|instrumental\s+interlude)$/, 'interlude'],
  [/^breakdown$/, 'breakdown'],
  [/^(?:build|build\s*-?\s*up)$/, 'build'],
  [/^(?:beat\s+)?drop$/, 'drop'],
];

/** Sections that carry no lyrics of their own. */
const INSTRUMENTAL: SectionKind[] = ['solo', 'interlude', 'breakdown', 'build', 'drop'];

interface Header {
  kind: SectionKind;
  /** Display name from the header, e.g. "Verse 1", "Hook". */
  name: string;
  /** "Chorus x2" → 2. */
  repeat: number;
  /** "Chorus: first line" — text after the colon on an unbracketed header. */
  rest?: string;
}

function headerKind(word: string): SectionKind | null {
  const w = word.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, kind] of HEADER_WORDS) if (re.test(w)) return kind;
  return null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    .trim();
}

/**
 * Parse one line as a section header, or null. Bracketed/parenthesised headers may carry a
 * performer after a colon; bare headers must be just the section words (optionally numbered,
 * upper-case, followed by ":" or a repeat count) so lyric lines like "Chorus of angels" are kept.
 */
export function parseSectionHeader(line: string): Header | null {
  let t = line.trim();
  if (!t) return null;
  let bracketed = false;
  const br = /^[[({<]\s*(.*?)\s*[\])}>]\s*(?:[x×]\s*(\d+)|\(\s*[x×]?\s*(\d+)\s*[x×]?\s*\))?$/i.exec(t);
  let outerRepeat = 0;
  if (br) {
    t = br[1];
    bracketed = true;
    outerRepeat = parseInt(br[2] ?? br[3] ?? '0', 10) || 0;
  } else {
    // *Chorus* / **Chorus** (markdown emphasis).
    const em = /^\*{1,2}\s*([^*]+?)\s*\*{1,2}$/.exec(t);
    if (em) t = em[1];
  }
  // Performer credits: "Verse 1: Kendrick Lamar", "Chorus - Both".
  let rest: string | undefined;
  const colon = /^([^:]+?)\s*:\s*(.*)$/.exec(t);
  if (colon) {
    t = colon[1];
    if (!bracketed && colon[2]) rest = colon[2];
  } else if (bracketed) {
    const dash = /^(.+?)\s+[-–—]\s+.+$/.exec(t);
    if (dash) t = dash[1];
  }
  // Repeat counts: "Chorus x2", "Chorus (x2)", "Chorus 2x", "Chorus ×3", "Repeat Chorus".
  let repeat = outerRepeat;
  const rep = /\s*(?:\(\s*)?(?:[x×]\s*(\d+)|(\d+)\s*[x×])(?:\s*\))?\s*$/i.exec(t);
  if (rep) {
    repeat = parseInt(rep[1] ?? rep[2], 10) || 1;
    t = t.slice(0, rep.index).trim();
  }
  const repeatWord = /^(?:repeat|reprise|repeat\s+the)\s+/i.exec(t);
  if (repeatWord) t = t.slice(repeatWord[0].length);
  // Section number: "Verse 2", "Chorus 1", "Verse II".
  const numbered = /^(.*?)\s*(?:#\s*)?(\d+|[IVX]{1,4})$/.exec(t);
  let num = '';
  let words = t;
  if (numbered && numbered[1] && headerKind(numbered[1])) {
    words = numbered[1];
    num = numbered[2];
  }
  // Bare headers (no brackets) must be only the section word(s), any case: "CHORUS", "Verse 2", "Bridge".
  const kind = headerKind(words);
  if (!kind) return null;
  const label = titleCase(words.replace(/\s+/g, ' ').trim())
    .replace(/^Pre ?-? ?(Chorus|Hook)$/, 'Pre-$1')
    .replace(/^Post ?-? ?(Chorus|Hook)$/, 'Post-$1');
  return { kind, name: `${label}${num ? ` ${num}` : ''}`, repeat: Math.max(1, repeat || 1), ...(rest ? { rest } : {}) };
}

const CHORD_TOKEN = /^\(?[A-G](?:#|b|♯|♭)?(?:maj|min|mi|ma|m|M|dim|aug|sus|add|\+|°|ø|Δ)?\d{0,2}(?:(?:add|sus|maj|b|#|\+|-)\d{1,2})*(?:\([^)]*\))?(?:\/[A-G](?:#|b|♯|♭)?)?\)?$/;

/** A line made only of chord symbols / bar lines ("Am  F  C  G", "| G | D/F# |", "N.C."). */
export function isChordLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let chords = 0;
  for (const tok of tokens) {
    if (/^[|:/\\.\-–—]+$/.test(tok) || /^[x×]\d+$/i.test(tok) || /^\d+[x×]$/i.test(tok) || /^%$/.test(tok)) continue;
    if (/^N\.?C\.?$/i.test(tok)) {
      chords++;
      continue;
    }
    if (!CHORD_TOKEN.test(tok)) return false;
    chords++;
  }
  if (!chords) return false;
  // A single capital "A" or "Am" alone could be a word: only treat it as a chord line if it has a chord-only shape.
  if (tokens.length === 1 && /^(?:A|Am|Em|E|D|C|G|F|B)$/.test(tokens[0])) return false;
  return true;
}

const DIRECTION_WORDS =
  /\b(?:spoken|speaking|whisper(?:ed|ing)?|instrumental|solo|repeat|fade(?:s)?(?:\s+out)?|laugh(?:s|ing)?|applause|guitar|piano|drums?|bass|beat|music|break|pause|silence|end|x\d|\d+x|sample|skit|talking|ad[\s-]?libs?|crowd|cheering|humming|n\.?c\.?)\b/i;

/** Metadata / footer lines from lyric sites and chord sheets. */
const META_LINE =
  /^(?:(?:written|lyrics|music|words|produced|composed|transcribed|tabbed|submitted)\s+by\b|title\s*:|artist\s*:|album\s*:|key\s*:|capo\b|tuning\s*:|tempo\s*:|bpm\s*:|chords?\s*:|copyright\b|©|\(c\)\s|you might also like\b|see .* live\b|get tickets\b|\d*\s*embed$|\d+\s+contributors?\b|translations?\b)/i;

type LineClass = { type: 'blank' } | { type: 'header'; header: Header } | { type: 'lyric'; text: string } | { type: 'instrumental'; kind: SectionKind; name: string } | { type: 'skip' };

function classify(raw: string): LineClass {
  const line = raw.replace(/\t/g, ' ').replace(/\u00a0/g, ' ').trimEnd();
  const t = line.trim();
  if (!t) return { type: 'blank' };
  if (META_LINE.test(t)) return { type: 'skip' };
  const header = parseSectionHeader(t);
  if (header) {
    if (INSTRUMENTAL.includes(header.kind)) return { type: 'instrumental', kind: header.kind, name: header.name };
    return { type: 'header', header };
  }
  if (isChordLine(t)) return { type: 'skip' };
  // Whole-line stage directions: "(guitar solo)", "[Instrumental]", "*laughs*", "(Spoken)".
  if (/^\*[^*]+\*$/.test(t)) return { type: 'skip' };
  const wrapped = /^[[({]\s*(.*?)\s*[\]})]$/.exec(t);
  if (wrapped) {
    if (/^[[{]/.test(t)) return { type: 'skip' };
    if (DIRECTION_WORDS.test(wrapped[1])) return { type: 'skip' };
  }
  // Inline ChordPro chords: "[Am]I walked a[F]lone" → "I walked alone".
  const text = t
    .replace(/\[([A-G][^\]\s]{0,9})\]/g, (m, c: string) => (CHORD_TOKEN.test(c) ? '' : m))
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text || !/[A-Za-z\p{L}]/u.test(text)) return { type: 'skip' };
  return { type: 'lyric', text };
}

// ---------------------------------------------------------------------------------------------
// Stanza similarity
// ---------------------------------------------------------------------------------------------

function normLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lineSimilar(a: string, b: string): boolean {
  const x = normLine(a);
  const y = normLine(b);
  if (x === y) return true;
  const ta = new Set(x.split(' '));
  const tb = new Set(y.split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.75;
}

/** 0..1: how much two stanzas share (lines matched, relative to the shorter, penalising big size gaps). */
export function stanzaSimilarity(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length / long.length < 0.5) return 0;
  const used = new Set<number>();
  let matched = 0;
  for (const l of short) {
    const j = long.findIndex((m, k) => !used.has(k) && lineSimilar(l, m));
    if (j >= 0) {
      used.add(j);
      matched++;
    }
  }
  return matched / short.length;
}

const SIMILAR = 0.7;

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

interface Stanza {
  header?: Header;
  lines: string[];
  instrumental?: { kind: SectionKind; name: string };
}

function toStanzas(text: string): { stanzas: Stanza[]; labelled: boolean } {
  const stanzas: Stanza[] = [];
  let cur: Stanza | null = null;
  let labelled = false;
  let blankSince = false;
  const flush = () => {
    if (cur && (cur.lines.length || cur.header || cur.instrumental)) stanzas.push(cur);
    cur = null;
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const c = classify(raw);
    switch (c.type) {
      case 'blank':
        blankSince = true;
        break;
      case 'skip':
        break;
      case 'header':
        labelled = true;
        flush();
        cur = { header: c.header, lines: c.header.rest ? [c.header.rest] : [] };
        blankSince = false;
        break;
      case 'instrumental':
        labelled = true;
        flush();
        stanzas.push({ lines: [], instrumental: { kind: c.kind, name: c.name } });
        blankSince = false;
        break;
      case 'lyric':
        if (cur && blankSince && cur.lines.length) {
          // A blank line inside a labelled document: a new, unlabelled stanza.
          flush();
        }
        if (!cur) cur = { lines: [] };
        cur.lines.push(c.text);
        blankSince = false;
        break;
    }
  }
  flush();
  return { stanzas, labelled };
}

/** Kinds for unlabelled stanzas from repetition: chorus, pre-chorus, verse, bridge (and outro). */
function inferKinds(stanzas: readonly string[][], fixed: readonly (SectionKind | null)[]): SectionKind[] {
  const n = stanzas.length;
  const kinds: (SectionKind | null)[] = [...fixed];
  // Group near-duplicates.
  const group = new Array<number>(n).fill(-1);
  let groups = 0;
  for (let i = 0; i < n; i++) {
    if (group[i] >= 0) continue;
    group[i] = groups;
    for (let j = i + 1; j < n; j++) if (group[j] < 0 && stanzaSimilarity(stanzas[i], stanzas[j]) >= SIMILAR) group[j] = groups;
    groups++;
  }
  const members = (g: number) => group.map((x, i) => (x === g ? i : -1)).filter((i) => i >= 0);
  // A labelled chorus elsewhere marks its look-alikes as choruses too.
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== null) continue;
    const twin = members(group[i]).find((j) => fixed[j] !== null);
    if (twin !== undefined) kinds[i] = fixed[twin];
  }
  // The most repeated group is the chorus (ties: more lines, then earlier).
  let chorusGroup = -1;
  let bestCount = 1;
  for (let g = 0; g < groups; g++) {
    const m = members(g);
    if (m.some((i) => fixed[i] !== null)) continue;
    const count = m.length;
    const lines = stanzas[m[0]].length;
    if (count > bestCount || (count === bestCount && count > 1 && chorusGroup >= 0 && lines > stanzas[members(chorusGroup)[0]].length)) {
      chorusGroup = g;
      bestCount = count;
    }
  }
  const hasFixedChorus = fixed.some((k) => k === 'chorus' || k === 'final-chorus');
  if (chorusGroup >= 0) for (const i of members(chorusGroup)) if (kinds[i] === null) kinds[i] = 'chorus';
  const isChorus = (i: number) => kinds[i] === 'chorus' || kinds[i] === 'final-chorus';
  // Other repeated groups: pre-chorus if every occurrence leads into a chorus, post-chorus if it follows one.
  for (let g = 0; g < groups; g++) {
    if (g === chorusGroup) continue;
    const m = members(g).filter((i) => kinds[i] === null);
    if (m.length < 2) continue;
    if (m.every((i) => i + 1 < n && isChorus(i + 1))) for (const i of m) kinds[i] = 'pre-chorus';
    else if (m.every((i) => i > 0 && isChorus(i - 1))) for (const i of m) kinds[i] = 'post-chorus';
  }
  const chorusIdx = kinds.map((k, i) => (k === 'chorus' || k === 'final-chorus' ? i : -1)).filter((i) => i >= 0);
  const anyChorus = chorusIdx.length > 0 || hasFixedChorus;
  const avgSyl = (lines: readonly string[]) => lines.reduce((t, l) => t + countSyllables(l), 0) / Math.max(1, lines.length);
  // Shaped like an earlier verse (line count and syllables per line): a further verse, not a bridge.
  const verseLike = (i: number) =>
    kinds.some((k, j) => j < i && k === 'verse' && Math.abs(stanzas[j].length - stanzas[i].length) <= 1 && Math.abs(avgSyl(stanzas[j]) - avgSyl(stanzas[i])) <= 0.3 * Math.max(1, avgSyl(stanzas[j])));
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== null) continue;
    const unique = members(group[i]).length === 1;
    const before = chorusIdx.filter((c) => c < i).length;
    const after = chorusIdx.filter((c) => c > i).length;
    if (anyChorus && unique && before >= 2 && after === 0 && i === n - 1 && stanzas[i].length <= 2) kinds[i] = 'outro';
    // Late in the song (after two choruses, or past 60% after one) and not a full verse-shaped stanza: the bridge.
    else if (anyChorus && unique && !kinds.includes('bridge') && (before >= 2 || (before >= 1 && i >= Math.ceil(n * 0.6))) && !(verseLike(i) && stanzas[i].length >= 3)) kinds[i] = 'bridge';
    else kinds[i] = 'verse';
  }
  return kinds as SectionKind[];
}

/** Name sections "Verse 1", "Verse 2", "Chorus"… (numbers only for verses that recur, choruses keep one name). */
function nameUnlabelled(kinds: readonly SectionKind[]): string[] {
  const total = new Map<SectionKind, number>();
  for (const k of kinds) total.set(k, (total.get(k) ?? 0) + 1);
  const seen = new Map<SectionKind, number>();
  return kinds.map((k) => {
    const i = (seen.get(k) ?? 0) + 1;
    seen.set(k, i);
    const label = KIND_LABEL[k];
    return k === 'verse' && (total.get(k) ?? 0) > 1 ? `${label} ${i}` : label;
  });
}

/**
 * Parse pasted lyrics into ordered sections. Headers win; unlabelled stanzas are classified by
 * repetition. Header-only references ("[Chorus]", "(Chorus x2)", "Repeat chorus") repeat the last
 * stanza of that kind. `text` is kept exactly as entered.
 */
export function parseLyricSheet(text: string): BlueprintLyrics {
  const { stanzas, labelled } = toStanzas(text ?? '');
  // Labelled documents: an unlabelled stanza after a labelled one continues it unless it repeats a known stanza.
  const merged: Stanza[] = [];
  for (const s of stanzas) {
    const prev = merged[merged.length - 1];
    if (labelled && !s.header && !s.instrumental && prev?.header) {
      const repeatsKnown = merged.some((m) => m !== prev && m.lines.length && stanzaSimilarity(m.lines, s.lines) >= SIMILAR);
      const repeatsPrev = prev.lines.length > 0 && stanzaSimilarity(prev.lines, s.lines) >= SIMILAR;
      if (!repeatsKnown && !repeatsPrev) {
        prev.lines.push(...s.lines);
        continue;
      }
    }
    merged.push({ ...s, lines: [...s.lines] });
  }
  // Header references without lines repeat the last stanza of the same kind (or name).
  const resolved: Stanza[] = [];
  for (const s of merged) {
    if (s.header && !s.lines.length) {
      const src = [...resolved].reverse().find((r) => r.header && r.lines.length && (r.header.name === s.header!.name || r.header.kind === s.header!.kind || (s.header!.kind === 'final-chorus' && r.header.kind === 'chorus')));
      if (src) {
        resolved.push({ header: s.header, lines: [...src.lines] });
        continue;
      }
      if (s.header.kind === 'intro' || s.header.kind === 'outro') {
        // "[Intro]" with nothing under it: an instrumental intro/outro.
        resolved.push({ lines: [], instrumental: { kind: s.header.kind, name: s.header.name } });
      }
      continue;
    }
    resolved.push(s);
  }
  const lyricStanzas = resolved.filter((s) => !s.instrumental);
  const fixed = lyricStanzas.map((s) => s.header?.kind ?? null);
  const kinds = inferKinds(
    lyricStanzas.map((s) => s.lines),
    fixed,
  );
  const autoNames = nameUnlabelled(kinds);
  const sections: LyricSheetSection[] = [];
  let li = 0;
  for (const s of resolved) {
    if (s.instrumental) {
      sections.push({ name: s.instrumental.name, kind: s.instrumental.kind, lines: [] });
      continue;
    }
    const kind = kinds[li];
    const name = s.header ? s.header.name : autoNames[li];
    li++;
    const repeat = s.header?.repeat ?? 1;
    const lines: string[] = [];
    for (let r = 0; r < repeat; r++) lines.push(...s.lines);
    if (lines.length) sections.push({ name, kind, lines });
  }
  // Unlabelled verses get numbers in song order once the kinds are known.
  if (!labelled) {
    const names = nameUnlabelled(sections.map((s) => s.kind));
    sections.forEach((s, i) => (s.name = names[i]));
  }
  return { text: text ?? '', sections };
}

/** Lines of the lyrics that are sung (for counts and previews). */
export function lyricLineCount(lyrics: Pick<BlueprintLyrics, 'sections'>): number {
  return lyrics.sections.reduce((n, s) => n + s.lines.length, 0);
}
