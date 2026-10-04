import { useMemo, useState } from 'react';
import { getInstrument, keyName, sectionLayout, tickToMusical, type Song } from '@songdeck/core';
import type { RebuildReport } from '@songdeck/audio';
import { useSettings } from '../../state/settings';
import { formatDuration } from '../../hooks';
import { Badge, Kv } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ConfidenceLegend, NoteStrip } from '../shared/NoteStrip';
import { confidenceTone, pct } from '../transcribe/widgets';

export function ConfidenceBar({ value, width = 120 }: { value: number | undefined; width?: number }) {
  const tone = confidenceTone(value);
  const color =
    tone === 'success'
      ? 'var(--success)'
      : tone === 'warning'
        ? 'var(--warning)'
        : tone === 'danger'
          ? 'var(--danger)'
          : 'var(--text-dim)';
  return (
    <div className="row" style={{ gap: 6 }} title={`Confidence ${pct(value)}`}>
      <div
        style={{ width, height: 6, borderRadius: 3, background: 'var(--bg-elev-3)', overflow: 'hidden' }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((value ?? 0) * 100)}
      >
        <div style={{ width: `${Math.round((value ?? 0) * 100)}%`, height: '100%', background: color }} />
      </div>
      <span className="mono small" style={{ color }}>
        {pct(value)}
      </span>
    </div>
  );
}

/** Result of a rebuild: tempo / key / meter with confidence, sections, chords, tracks, uncertain regions. */
export function RebuildSummary({ song, report }: { song: Song; report: RebuildReport }) {
  const customInstruments = useSettings((s) => s.customInstruments);
  const midiTracks = song.tracks.filter((t) => t.kind === 'midi');
  const [selected, setSelected] = useState<string | null>(midiTracks[0]?.id ?? null);
  const stage = (id: string) => report.stages.find((s) => s.id === id);
  const layout = useMemo(() => sectionLayout(song), [song]);
  const meter = report.meter ?? song.meterMap[0] ?? { numerator: 4, denominator: 4 };
  const barTicks = (meter.numerator * 4 * song.ppq) / meter.denominator;
  const totalBars = song.sections.reduce((a, s) => a + s.bars, 0);
  const track = song.tracks.find((t) => t.id === selected) ?? midiTracks[0];
  const chords = song.chords.slice(0, 48);
  const regions = report.lowConfidenceRegions
    .map((r) => {
      const t = song.tracks.find((x) => x.id === r.trackId);
      const from = tickToMusical(song, r.startTick).bar;
      const to = Math.max(from, tickToMusical(song, Math.max(r.startTick, r.endTick - 1)).bar);
      return { ...r, name: t?.name ?? r.trackId, from, to };
    })
    .sort((a, b) => a.confidence - b.confidence);

  return (
    <div className="col" style={{ gap: 14 }} data-testid="rebuild-summary">
      <div className="grid-2">
        <div className="card">
          <h4>Musical frame</h4>
          <Kv
            items={[
              [
                'Tempo',
                <span key="t" className="row">
                  <strong>{Math.round(report.bpm * 10) / 10} BPM</strong>
                  <Badge tone={confidenceTone(stage('tempo')?.confidence)}>
                    {pct(stage('tempo')?.confidence)}
                  </Badge>
                </span>,
              ],
              [
                'Key',
                <span key="k" className="row">
                  <strong>{keyName(report.key)}</strong>
                  <Badge tone={confidenceTone(stage('key')?.confidence)}>
                    {pct(stage('key')?.confidence)}
                  </Badge>
                </span>,
              ],
              [
                'Meter',
                <span key="m" className="row">
                  <strong>
                    {meter.numerator}/{meter.denominator}
                  </strong>
                  <Badge
                    tone={confidenceTone(stage('tempo')?.confidence)}
                    title="Meter is estimated from beat accents (tempo stage)"
                  >
                    {pct(stage('tempo')?.confidence)}
                  </Badge>
                </span>,
              ],
              ['Length', `${formatDuration(report.durationSeconds)} · ${totalBars} bars`],
              ['Grid offset', `${report.offsetSeconds.toFixed(2)} s = bar 1`],
            ]}
          />
        </div>
        <div className="card">
          <h4>Overall</h4>
          <div className="row" style={{ marginBottom: 8 }}>
            <ConfidenceBar value={report.overallConfidence} width={180} />
          </div>
          <div className="small muted">Separation: {report.separationMethod}</div>
          <div className="small muted">
            {midiTracks.length} MIDI tracks · {song.sections.length} sections · {song.chords.length} chords
          </div>
        </div>
      </div>

      <div>
        <div className="section-title">
          <h3>Sections</h3>
          <Badge tone={confidenceTone(stage('structure')?.confidence)}>
            structure {pct(stage('structure')?.confidence)}
          </Badge>
        </div>
        <div className="chip-list" data-testid="rebuild-sections">
          {layout.map((s) => (
            <span
              key={s.section.id}
              className="chip"
              style={{ cursor: 'default' }}
              title={`Bars ${s.startBar + 1}–${s.endBar}`}
            >
              <strong>{s.section.name}</strong>
              <span className="muted">
                {s.endBar - s.startBar} bars · {s.startBar + 1}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div>
        <div className="section-title">
          <h3>Chords</h3>
          <Badge tone={confidenceTone(stage('chords')?.confidence)}>
            chords {pct(stage('chords')?.confidence)}
          </Badge>
          {song.chords.length > chords.length && (
            <span className="small dim">
              first {chords.length} of {song.chords.length}
            </span>
          )}
        </div>
        {chords.length ? (
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(74px, 1fr))', gap: 4 }}
            data-testid="rebuild-chords"
          >
            {chords.map((c) => {
              const pos = tickToMusical(song, c.tick);
              return (
                <div key={c.id} className="card" style={{ padding: '4px 6px' }}>
                  <div className="mono" style={{ fontWeight: 700 }}>
                    {c.symbol}
                  </div>
                  <div className="small dim">
                    {pos.bar}.{Math.floor(pos.beat)}
                    {c.roman ? ` · ${c.roman}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="small muted">No chords were detected.</div>
        )}
      </div>

      <div>
        <div className="section-title">
          <h3>Tracks</h3>
          <Badge tone={confidenceTone(stage('pitch')?.confidence)}>
            pitch {pct(stage('pitch')?.confidence)}
          </Badge>
          <Badge tone={confidenceTone(stage('instruments')?.confidence)}>
            instruments {pct(stage('instruments')?.confidence)}
          </Badge>
        </div>
        <table className="table" data-testid="rebuild-tracks">
          <thead>
            <tr>
              <th>Track</th>
              <th>Instrument</th>
              <th className="num">Notes</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {midiTracks.map((t) => (
              <tr
                key={t.id}
                onClick={() => setSelected(t.id)}
                style={{ cursor: 'pointer', background: t.id === track?.id ? 'var(--bg-elev-3)' : undefined }}
              >
                <td>
                  <span className="row">
                    <span style={{ width: 4, height: 16, borderRadius: 2, background: t.color }} />
                    <strong>{t.name}</strong>
                  </span>
                </td>
                <td className="muted">{getInstrument(t.instrumentId, customInstruments).name}</td>
                <td className="num">{t.notes.length}</td>
                <td>
                  <ConfidenceBar value={report.trackConfidence[t.id]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {track && (
          <div className="col" style={{ gap: 6, marginTop: 8 }}>
            <div className="row between wrap">
              <span className="small muted">
                Preview: <strong>{track.name}</strong> (click a row to switch)
              </span>
              <ConfidenceLegend notes={track.notes} />
            </div>
            <NoteStrip
              notes={track.notes}
              ppq={song.ppq}
              meter={meter}
              totalTicks={Math.max(1, totalBars) * barTicks}
              height={track.role === 'drums' ? 110 : 140}
              drums={track.role === 'drums' || track.role === 'percussion'}
              testId="rebuild-track-strip"
            />
          </div>
        )}
      </div>

      <div>
        <div className="section-title">
          <h3>Low-confidence regions</h3>
          <span className="small muted">
            Listen to these first — they are outlined in the piano roll after opening.
          </span>
        </div>
        {regions.length ? (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }} data-testid="rebuild-low-confidence">
            {regions.slice(0, 12).map((r, i) => (
              <li key={i}>
                <strong>{r.name}</strong> · bar{r.to > r.from ? 's' : ''} {r.from}
                {r.to > r.from ? `–${r.to}` : ''} ·{' '}
                <span style={{ color: r.confidence < 0.4 ? 'var(--danger)' : 'var(--warning)' }}>
                  {pct(r.confidence)}
                </span>
              </li>
            ))}
            {regions.length > 12 && <li className="muted">…and {regions.length - 12} more</li>}
          </ul>
        ) : (
          <div className="small muted">No regions were flagged.</div>
        )}
      </div>

      {report.warnings.length > 0 && (
        <div className="callout warning small" data-testid="rebuild-warnings">
          <div className="row" style={{ fontWeight: 600, marginBottom: 4 }}>
            <Icon name="alert" size={13} /> Warnings
          </div>
          {report.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}
    </div>
  );
}
