import type { Song } from '../ir/types';
import { barToTick, createTimeMap, meterAtBar, sectionLayout, tickToBar } from '../timing';
import { fixed } from './util';

/** CSV field quoting (RFC 4180). */
function csv(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Tempo map as CSV (spec §56 "tempo map"): one row per tempo or meter change.
 *   bar,beat,tick,seconds,bpm,numerator,denominator
 */
export function tempoMapCsv(song: Song): string {
  const tm = createTimeMap(song);
  const ticks = new Set<number>([0]);
  for (const t of song.tempoMap) ticks.add(Math.round(t.tick));
  for (const m of song.meterMap) ticks.add(barToTick(song, m.bar));
  const rows = ['bar,beat,tick,seconds,bpm,numerator,denominator'];
  for (const tick of [...ticks].sort((a, b) => a - b)) {
    const pos = tickToBar(song, tick);
    const meter = meterAtBar(song, pos.bar);
    rows.push(
      [pos.bar + 1, Math.round((pos.beat + 1) * 1000) / 1000, tick, fixed(tm.tickToSeconds(tick), 6), Math.round(tm.bpmAt(tick) * 1000) / 1000, meter.numerator, meter.denominator].join(','),
    );
  }
  return rows.join('\n') + '\n';
}

/**
 * Section markers as CSV (spec §56 "marker file"), compatible with DAW region-manager imports.
 *   #,Name,Kind,Start Bar,End Bar,Start (s),End (s),Length (s)
 */
export function markersCsv(song: Song): string {
  const tm = createTimeMap(song);
  const rows = ['#,Name,Kind,Start Bar,End Bar,Start (s),End (s),Length (s)'];
  sectionLayout(song).forEach((span, i) => {
    if (span.endBar <= span.startBar) return;
    const a = tm.tickToSeconds(span.startTick);
    const b = tm.tickToSeconds(span.endTick);
    rows.push([i + 1, csv(span.section.name), span.section.kind, span.startBar + 1, span.endBar, fixed(a), fixed(b), fixed(b - a)].join(','));
  });
  return rows.join('\n') + '\n';
}

/** Audacity label track (start\tend\tlabel, seconds) — one region label per section. */
export function audacityLabels(song: Song): string {
  const tm = createTimeMap(song);
  return sectionLayout(song)
    .filter((s) => s.endBar > s.startBar)
    .map((s) => `${fixed(tm.tickToSeconds(s.startTick), 6)}\t${fixed(tm.tickToSeconds(s.endTick), 6)}\t${s.section.name.replace(/[\t\r\n]+/g, ' ')}`)
    .join('\n')
    .concat(song.sections.length ? '\n' : '');
}
