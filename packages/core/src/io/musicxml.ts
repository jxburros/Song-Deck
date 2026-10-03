import type { ChordEvent, ChordQuality, InstrumentProfile, Note, Song, Track } from '../ir/types';
import { GM_DRUM_NAMES } from '../ir/gm';
import { spellPitchClass } from '../theory/pitch';
import { isDrumTrack, lookupInstrument, type InstrumentLookupOptions } from '../edit/instruments';
import { assignChannels } from './midi';
import {
  AccidentalState,
  buildMeasures,
  chordsByMeasure,
  drumDisplay,
  keySignatureAlters,
  layoutVoices,
  notationGrid,
  notesEnd,
  spellPitch,
  type MeasureInfo,
  type NotatedEvent,
} from './notation-layout';
import { xmlEscape } from './util';

export interface MusicXmlOptions extends InstrumentLookupOptions {
  /** Export only these tracks (default: all MIDI tracks with notes, plus empty ones). */
  trackIds?: string[];
  /** Composer credit (default none). */
  composer?: string;
}

/** MusicXML <kind> values (and degree alterations) for each chord quality. */
const HARMONY_KIND: Record<ChordQuality, { kind: string; degrees?: [number, number, 'add' | 'alter' | 'subtract'][] }> = {
  maj: { kind: 'major' },
  min: { kind: 'minor' },
  dim: { kind: 'diminished' },
  aug: { kind: 'augmented' },
  sus2: { kind: 'suspended-second' },
  sus4: { kind: 'suspended-fourth' },
  '5': { kind: 'power' },
  '6': { kind: 'major-sixth' },
  min6: { kind: 'minor-sixth' },
  '7': { kind: 'dominant' },
  maj7: { kind: 'major-seventh' },
  min7: { kind: 'minor-seventh' },
  minmaj7: { kind: 'major-minor' },
  m7b5: { kind: 'half-diminished' },
  dim7: { kind: 'diminished-seventh' },
  '7sus4': { kind: 'suspended-fourth', degrees: [[7, -1, 'add']] },
  add9: { kind: 'major', degrees: [[9, 0, 'add']] },
  minadd9: { kind: 'minor', degrees: [[9, 0, 'add']] },
  '9': { kind: 'dominant-ninth' },
  maj9: { kind: 'major-ninth' },
  min9: { kind: 'minor-ninth' },
  '11': { kind: 'dominant-11th' },
  min11: { kind: 'minor-11th' },
  '13': { kind: 'dominant-13th' },
  maj13: { kind: 'major-13th' },
  aug7: { kind: 'augmented-seventh' },
  '7b9': { kind: 'dominant', degrees: [[9, -1, 'add']] },
  '7#9': { kind: 'dominant', degrees: [[9, 1, 'add']] },
};

const ARTICULATION_XML: Record<string, string> = {
  staccato: '<staccato/>',
  accent: '<accent/>',
  marcato: '<strong-accent/>',
  tenuto: '<tenuto/>',
};

type ClefSpec = { sign: 'G' | 'F' | 'percussion'; line: number; octaveChange?: number };

interface PartPlan {
  id: string;
  track: Track;
  profile: InstrumentProfile;
  channel: number;
  drums: boolean;
  /** One clef per staff. */
  clefs: ClefSpec[];
  /** Notes per staff. */
  staffNotes: Note[][];
}

function planClefs(track: Track, profile: InstrumentProfile, drums: boolean): { clefs: ClefSpec[]; staffNotes: Note[][] } {
  if (drums || profile.clef === 'percussion') return { clefs: [{ sign: 'percussion', line: 2 }], staffNotes: [track.notes] };
  const avg = track.notes.length ? track.notes.reduce((s, n) => s + n.pitch, 0) / track.notes.length : 60;
  if (profile.clef === 'grand') {
    const hasLow = track.notes.some((n) => n.pitch < 60);
    const hasHigh = track.notes.some((n) => n.pitch >= 60);
    if (hasLow && hasHigh) {
      return {
        clefs: [
          { sign: 'G', line: 2 },
          { sign: 'F', line: 4 },
        ],
        staffNotes: [track.notes.filter((n) => n.pitch >= 60), track.notes.filter((n) => n.pitch < 60)],
      };
    }
    return { clefs: [avg < 60 ? { sign: 'F', line: 4 } : { sign: 'G', line: 2 }], staffNotes: [track.notes] };
  }
  const octave = (profile.notationTranspose ?? 0) >= 12 ? -1 : undefined;
  if (profile.clef === 'treble-8vb') return { clefs: [{ sign: 'G', line: 2, octaveChange: -1 }], staffNotes: [track.notes] };
  if (profile.clef === 'bass') return { clefs: [{ sign: 'F', line: 4, octaveChange: octave }], staffNotes: [track.notes] };
  if (profile.clef === 'treble') return { clefs: [{ sign: 'G', line: 2, octaveChange: octave }], staffNotes: [track.notes] };
  return { clefs: [avg < 55 ? { sign: 'F', line: 4 } : { sign: 'G', line: 2 }], staffNotes: [track.notes] };
}

function clefXml(c: ClefSpec, number?: number): string {
  const n = number !== undefined ? ` number="${number}"` : '';
  if (c.sign === 'percussion') return `<clef${n}><sign>percussion</sign><line>2</line></clef>`;
  return `<clef${n}><sign>${c.sign}</sign><line>${c.line}</line>${c.octaveChange ? `<clef-octave-change>${c.octaveChange}</clef-octave-change>` : ''}</clef>`;
}

const MODE_XML: Record<string, string> = {
  major: 'major',
  minor: 'minor',
  dorian: 'dorian',
  phrygian: 'phrygian',
  lydian: 'lydian',
  mixolydian: 'mixolydian',
  locrian: 'locrian',
  'harmonic-minor': 'minor',
  'melodic-minor': 'minor',
};

function stepAlter(name: string): { step: string; alter: number } {
  const step = name[0];
  const acc = name.slice(1);
  const alter = acc === '#' ? 1 : acc === 'b' ? -1 : acc === '##' ? 2 : acc === 'bb' ? -2 : 0;
  return { step, alter };
}

function harmonyXml(chord: ChordEvent, measure: MeasureInfo, offset: number): string {
  const root = stepAlter(spellPitchClass(chord.root, measure.key));
  const kind = HARMONY_KIND[chord.quality] ?? { kind: 'major' };
  const parts = [`<harmony print-frame="no">`];
  parts.push(`<root><root-step>${root.step}</root-step>${root.alter ? `<root-alter>${root.alter}</root-alter>` : ''}</root>`);
  const text = chord.symbol.replace(/^[A-G](#|b)?/, '').replace(/\/.*$/, '');
  parts.push(`<kind text="${xmlEscape(text)}">${kind.kind}</kind>`);
  if (chord.bass !== undefined && chord.bass !== chord.root) {
    const b = stepAlter(spellPitchClass(chord.bass, measure.key));
    parts.push(`<bass><bass-step>${b.step}</bass-step>${b.alter ? `<bass-alter>${b.alter}</bass-alter>` : ''}</bass>`);
  }
  for (const [value, alter, type] of kind.degrees ?? []) {
    parts.push(`<degree><degree-value>${value}</degree-value><degree-alter>${alter}</degree-alter><degree-type>${type}</degree-type></degree>`);
  }
  if (offset > 0) parts.push(`<offset>${offset}</offset>`);
  parts.push('</harmony>');
  return parts.join('');
}

function tempoXml(bpm: number, offset: number): string {
  const rounded = Math.round(bpm * 100) / 100;
  return (
    `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${rounded}</per-minute></metronome></direction-type>` +
    `${offset > 0 ? `<offset>${offset}</offset>` : ''}<sound tempo="${rounded}"/></direction>`
  );
}

interface Ctx {
  divisionsPerTick: number;
}

function noteXml(
  ev: NotatedEvent,
  plan: PartPlan,
  voice: number,
  staff: number | undefined,
  measure: MeasureInfo,
  acc: AccidentalState,
  ctx: Ctx,
): string {
  const dur = Math.max(1, Math.round(ev.duration * ctx.divisionsPerTick));
  const staffXml = staff !== undefined ? `<staff>${staff}</staff>` : '';
  if (ev.rest) {
    if (ev.hidden) return `<forward><duration>${dur}</duration><voice>${voice}</voice>${staffXml}</forward>`;
    if (ev.measureRest) return `<note><rest measure="yes"/><duration>${dur}</duration><voice>${voice}</voice>${staffXml}</note>`;
    return `<note><rest/><duration>${dur}</duration><voice>${voice}</voice><type>${ev.type}</type>${'<dot/>'.repeat(ev.dots)}${staffXml}</note>`;
  }
  const out: string[] = [];
  const pitches = plan.drums ? [...ev.pitches].sort((a, b) => a - b) : ev.pitches;
  pitches.forEach((pitch, i) => {
    const parts: string[] = ['<note>'];
    if (i > 0) parts.push('<chord/>');
    let notehead: string | undefined;
    if (plan.drums) {
      const d = drumDisplay(pitch);
      notehead = d.notehead;
      parts.push(`<unpitched><display-step>${d.step}</display-step><display-octave>${d.octave}</display-octave></unpitched>`);
    } else {
      const sp = spellPitch(pitch, measure.key);
      parts.push(`<pitch><step>${sp.step}</step>${sp.alter ? `<alter>${sp.alter}</alter>` : ''}<octave>${sp.octave}</octave></pitch>`);
    }
    parts.push(`<duration>${dur}</duration>`);
    if (ev.tieStop) parts.push('<tie type="stop"/>');
    if (ev.tieStart) parts.push('<tie type="start"/>');
    if (plan.drums) parts.push(`<instrument id="${plan.id}-I${pitch + 1}"/>`);
    parts.push(`<voice>${voice}</voice><type>${ev.type}</type>${'<dot/>'.repeat(ev.dots)}`);
    if (!plan.drums) {
      const a = acc.accidentalFor(spellPitch(pitch, measure.key), ev.tieStop);
      if (a) parts.push(`<accidental>${a}</accidental>`);
    }
    if (plan.drums) parts.push(`<stem>${voice === 2 ? 'down' : 'up'}</stem>`);
    if (notehead) parts.push(`<notehead>${notehead}</notehead>`);
    parts.push(staffXml);
    const notations: string[] = [];
    if (ev.tieStop) notations.push('<tied type="stop"/>');
    if (ev.tieStart) notations.push('<tied type="start"/>');
    const art = !ev.tieStop && i === 0 ? ARTICULATION_XML[ev.notes[0]?.articulation ?? ''] : undefined;
    if (art) notations.push(`<articulations>${art}</articulations>`);
    if (notations.length) parts.push(`<notations>${notations.join('')}</notations>`);
    if (i === 0 && ev.lyric) {
      parts.push(
        `<lyric number="1"><syllabic>${ev.lyric.syllabic}</syllabic><text>${xmlEscape(ev.lyric.text)}</text>${ev.lyric.extend ? '<extend/>' : ''}</lyric>`,
      );
    }
    parts.push('</note>');
    out.push(parts.join(''));
  });
  return out.join('');
}

/**
 * MusicXML 4.0 (score-partwise): one part per track, notes quantized to a 16th grid and split
 * across beats/barlines with ties, rests filling every measure, chords as <chord/>, multiple
 * voices for overlapping material, grand staff for keyboards, drum kits as unpitched notes,
 * chord symbols (<harmony>), tempo, rehearsal marks and lyrics on the first part / vocal parts.
 */
export function songToMusicXML(song: Song, opts: MusicXmlOptions = {}): string {
  const lookup: InstrumentLookupOptions = { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument };
  const tracks = song.tracks.filter((t) => t.kind === 'midi' && (!opts.trackIds || opts.trackIds.includes(t.id)));
  const grid = notationGrid(song);
  const ctx: Ctx = { divisionsPerTick: 1 / grid };
  const divisions = Math.round(song.ppq / grid);
  const end = Math.max(0, ...tracks.map((t) => notesEnd(t.notes)));
  const measures = buildMeasures(song, end);
  const harmonies = chordsByMeasure(song, measures, grid);
  const channels = assignChannels(tracks, lookup);

  const plans: PartPlan[] = tracks.map((track, i) => {
    const profile = lookupInstrument(track.instrumentId, lookup);
    const drums = isDrumTrack(track, lookup);
    const { clefs, staffNotes } = planClefs(track, profile, drums);
    return { id: `P${i + 1}`, track, profile, channel: channels.get(track.id) ?? 0, drums, clefs, staffNotes };
  });

  const xml: string[] = [];
  xml.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  xml.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  xml.push('<score-partwise version="4.0">');
  xml.push(`<work><work-title>${xmlEscape(song.title || 'Untitled')}</work-title></work>`);
  xml.push('<identification>');
  if (opts.composer) xml.push(`<creator type="composer">${xmlEscape(opts.composer)}</creator>`);
  xml.push('<encoding><software>Song Deck</software><supports element="accidental" type="yes"/><supports element="beam" type="no"/><supports element="stem" type="no"/></encoding>');
  xml.push('</identification>');
  xml.push('<part-list>');
  for (const p of plans) {
    xml.push(`<score-part id="${p.id}"><part-name>${xmlEscape(p.track.name)}</part-name>`);
    if (p.drums) {
      const used = [...new Set(p.track.notes.map((n) => n.pitch))].sort((a, b) => a - b);
      for (const pitch of used) {
        xml.push(`<score-instrument id="${p.id}-I${pitch + 1}"><instrument-name>${xmlEscape(GM_DRUM_NAMES[pitch] ?? `Drum ${pitch}`)}</instrument-name></score-instrument>`);
      }
      for (const pitch of used) {
        xml.push(`<midi-instrument id="${p.id}-I${pitch + 1}"><midi-channel>10</midi-channel><midi-unpitched>${pitch + 1}</midi-unpitched></midi-instrument>`);
      }
    } else {
      xml.push(`<score-instrument id="${p.id}-I1"><instrument-name>${xmlEscape(p.profile.name)}</instrument-name></score-instrument>`);
      xml.push(`<midi-instrument id="${p.id}-I1"><midi-channel>${p.channel + 1}</midi-channel><midi-program>${Math.max(0, Math.min(127, p.profile.gmProgram)) + 1}</midi-program></midi-instrument>`);
    }
    xml.push('</score-part>');
  }
  xml.push('</part-list>');

  plans.forEach((plan, partIndex) => {
    xml.push(`<part id="${plan.id}">`);
    const first = partIndex === 0;
    // Layout per staff; drums split hands (voice 1, stems up) and feet (voice 2, stems down).
    let staffLayouts: ReturnType<typeof layoutVoices>[];
    if (plan.drums) {
      const groups = [plan.track.notes.filter((n) => !drumDisplay(n.pitch).feet), plan.track.notes.filter((n) => drumDisplay(n.pitch).feet)].filter((g) => g.length);
      if (!groups.length) groups.push([]);
      staffLayouts = [groups.map((g) => layoutVoices(g, measures, { ppq: song.ppq, grid, maxVoices: 1 })[0])];
    } else staffLayouts = plan.staffNotes.map((notes) => layoutVoices(notes, measures, { ppq: song.ppq, grid, maxVoices: 4 }));
    const multiStaff = plan.clefs.length > 1;
    measures.forEach((m, mi) => {
      xml.push(`<measure number="${mi + 1}">`);
      const needAttrs = mi === 0 || m.meterChange || m.keyChange;
      if (needAttrs) {
        const a: string[] = ['<attributes>'];
        if (mi === 0) a.push(`<divisions>${divisions}</divisions>`);
        if (mi === 0 || m.keyChange) a.push(`<key><fifths>${m.fifths}</fifths><mode>${MODE_XML[m.key.mode] ?? 'none'}</mode></key>`);
        if (mi === 0 || m.meterChange) a.push(`<time><beats>${m.numerator}</beats><beat-type>${m.denominator}</beat-type></time>`);
        if (mi === 0) {
          if (multiStaff) a.push(`<staves>${plan.clefs.length}</staves>`);
          plan.clefs.forEach((c, ci) => a.push(clefXml(c, multiStaff ? ci + 1 : undefined)));
        }
        a.push('</attributes>');
        xml.push(a.join(''));
      }
      if (first && m.section) {
        xml.push(`<direction placement="above"><direction-type><rehearsal>${xmlEscape(m.section.name)}</rehearsal></direction-type></direction>`);
      }
      const measureLen = Math.round((m.endTick - m.startTick) * ctx.divisionsPerTick);
      let voiceNumber = 0;
      staffLayouts.forEach((voices, si) => {
        const staff = multiStaff ? si + 1 : undefined;
        const acc = new AccidentalState(keySignatureAlters(m.fifths));
        voices.forEach((voiceMeasures, vi) => {
          voiceNumber++;
          if (voiceNumber > 1) xml.push(`<backup><duration>${measureLen}</duration></backup>`);
          const events = voiceMeasures[mi] ?? [];
          // Directions & harmonies ride on the first voice of the first part.
          const carrier = first && voiceNumber === 1;
          const pendingHarm = carrier ? harmonies[mi].slice() : [];
          const pendingTempo = carrier ? m.tempos.map((t) => ({ offset: t.tick - m.startTick, bpm: t.bpm })) : [];
          for (const ev of events) {
            const evEnd = ev.start + ev.duration;
            while (pendingTempo.length && pendingTempo[0].offset < evEnd) {
              const t = pendingTempo.shift()!;
              xml.push(tempoXml(t.bpm, Math.round(Math.max(0, t.offset - ev.start) * ctx.divisionsPerTick)));
            }
            while (pendingHarm.length && pendingHarm[0].offset < evEnd) {
              const h = pendingHarm.shift()!;
              xml.push(harmonyXml(h.chord, m, Math.round(Math.max(0, h.offset - ev.start) * ctx.divisionsPerTick)));
            }
            const voiceId = plan.drums ? vi + 1 : multiStaff ? si * 4 + vi + 1 : vi + 1;
            xml.push(noteXml(ev, plan, voiceId, staff, m, acc, ctx));
          }
        });
      });
      const last = mi === measures.length - 1;
      if (last) xml.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
      else if (m.sectionEnd) xml.push('<barline location="right"><bar-style>light-light</bar-style></barline>');
      xml.push('</measure>');
    });
    xml.push('</part>');
  });
  xml.push('</score-partwise>');
  return xml.join('\n') + '\n';
}
