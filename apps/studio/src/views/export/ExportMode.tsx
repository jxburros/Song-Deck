import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  audacityLabels,
  markersCsv,
  songToChordSheet,
  songToLyricSheet,
  songToMidi,
  songToMusicXML,
  songToNotationPdf,
  tempoMapCsv,
  trackToMidi,
  type TaskRecord,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { taskQueue, useRuntime } from '../../engine/runtime';
import { allCustomInstruments, useExtensions } from '../../engine/plugins';
import { isTaskActive, startTask, useTaskRecord } from '../../engine/mix-tasks';
import { currentMaster, targetInfo } from '../../engine/mix-mastering';
import { vocalTrackIds, instrumentalTrackIds } from '../../engine/mix-render';
import { aacSupport, describeEncoding, zipEntries, type AudioFormat, type CodecSupport, type FlacBits, type WavBits } from '../../engine/export-audio';
import { deliverFile, downloadFile, formatBytes, MIME, removeExportedFile, sanitizeFileName, songFileBase, useExportFiles, clearExportedFiles } from '../../engine/export-files';
import type { AudioExportInput, AudioWhich, DawExportInput, EverythingInput, StemsExportInput } from '../../engine/handlers/exporting';
import { Badge, Button, EmptyState, Progress, Select, Spinner, Toggle } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/icons';
import './export.css';

/**
 * Export mode (spec §55 Export, §56 DAW interoperability, §73 example export list):
 * users can always take their work with them — project package, MIDI, audio in four formats,
 * stems, composition documents, DAW projects, plugin exporters, or everything at once.
 */

type SampleRate = 44100 | 48000;
const KBPS = [128, 160, 192, 224, 256, 320] as const;

interface Settings {
  sampleRate: SampleRate;
  wavBits: WavBits;
  flacBits: FlacBits;
  mp3Kbps: number;
  aacKbps: number;
  format: AudioFormat;
}

const ACTIVE = (t?: TaskRecord) => isTaskActive(t);

function Card({ icon, title, subtitle, children, badge }: { icon: IconName; title: string; subtitle: ReactNode; children: ReactNode; badge?: ReactNode }) {
  return (
    <section className="panel ex-card" aria-label={title}>
      <div className="panel-header">
        <Icon name={icon} />
        <h3 className="grow">{title}</h3>
        {badge}
      </div>
      <div className="panel-body">
        <div className="small muted ex-card-sub">{subtitle}</div>
        <div className="ex-rows">{children}</div>
      </div>
    </section>
  );
}

function Row({ name, detail, children }: { name: ReactNode; detail?: ReactNode; children: ReactNode }) {
  return (
    <div className="ex-row">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ex-row-name">{name}</div>
        {detail && <div className="small dim">{detail}</div>}
      </div>
      <div className="ex-row-actions">{children}</div>
    </div>
  );
}

/** A button bound to a queue task: shows live progress and a cancel control while it runs. */
function TaskButton({ taskId, label, icon = 'download', onStart, disabled, title, variant }: { taskId?: string; label: string; icon?: IconName; onStart: () => void; disabled?: boolean; title?: string; variant?: 'primary' }) {
  const t = useTaskRecord(taskId);
  if (ACTIVE(t)) {
    return (
      <div className="ex-task" role="status" aria-live="polite" title={t!.message}>
        <div className="row between small">
          <span className="row" style={{ gap: 6 }}>
            <Spinner />
            <span className="ellipsis" style={{ maxWidth: 150 }}>
              {t!.message ?? 'Queued'}
            </span>
          </span>
          <span className="mono dim">{Math.round((t!.progress ?? 0) * 100)}%</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <div className="grow">
            <Progress value={t!.progress} ai />
          </div>
          <Button size="sm" variant="ghost" onClick={() => taskQueue.cancel(t!.id)} aria-label={`Cancel ${label}`}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <span className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
      <Button size="sm" variant={variant} icon={icon} onClick={onStart} disabled={disabled} title={title}>
        {label}
      </Button>
      {t?.status === 'failed' && (
        <span className="small" style={{ color: 'var(--danger)', maxWidth: 220, textAlign: 'right' }} role="alert">
          {t.error}
        </span>
      )}
    </span>
  );
}

export default function ExportMode() {
  const song = useStudio((s) => s.project?.song ?? null);
  const project = useStudio((s) => s.project);
  const prefs = useSettings((s) => s.exportPrefs);
  const exporters = useExtensions((s) => s.exporters);
  const files = useExportFiles((s) => s.files);
  const activeExportCount = useRuntime((s) => s.tasks.filter((t) => t.type.startsWith('export.') && isTaskActive(t)).length);
  const st = useStudio.getState();
  const [settings, setSettings] = useState<Settings>(() => ({
    sampleRate: prefs.sampleRate,
    wavBits: prefs.bitDepth,
    flacBits: prefs.bitDepth === 16 ? 16 : 24,
    mp3Kbps: prefs.mp3Kbps,
    aacKbps: 256,
    format: 'wav',
  }));
  const [running, setRunning] = useState<Record<string, string>>({});
  const [aac, setAac] = useState<CodecSupport | null>(null);
  const [stemsBy, setStemsBy] = useState<'stemGroup' | 'track'>('stemGroup');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [renderMidiAudio, setRenderMidiAudio] = useState(true);
  const [singleTrack, setSingleTrack] = useState<string>('');
  const [pdfTrack, setPdfTrack] = useState<string>('auto');
  const [pdfPage, setPdfPage] = useState<'letter' | 'a4'>('letter');

  useEffect(() => {
    let alive = true;
    void aacSupport(settings.sampleRate, settings.aacKbps).then((r) => alive && setAac(r));
    return () => {
      alive = false;
    };
  }, [settings.sampleRate, settings.aacKbps]);

  const base = songFileBase(song);
  const midiTracks = useMemo(() => song?.tracks.filter((t) => t.kind === 'midi') ?? [], [song]);
  const custom = useMemo(() => ({ customInstruments: allCustomInstruments(project?.meta.customInstruments ?? []) }), [project?.meta.customInstruments]);

  if (!song || !project) return null;
  if (!song.tracks.length && !song.sections.length) {
    return (
      <EmptyState icon="export" title="Nothing to export yet">
        Compose or import a song first. You can always export the project package from the project menu.
      </EmptyState>
    );
  }

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const saveDefaults = () => {
    useSettings.getState().update({ exportPrefs: { sampleRate: settings.sampleRate, bitDepth: settings.wavBits === 16 ? 16 : 24, mp3Kbps: (KBPS.includes(settings.mp3Kbps as (typeof KBPS)[number]) ? settings.mp3Kbps : 256) as 128 | 192 | 256 | 320 } });
    st.toast('success', 'Saved as default export settings');
  };
  const differsFromPrefs = settings.sampleRate !== prefs.sampleRate || (settings.wavBits !== 32 && settings.wavBits !== prefs.bitDepth) || settings.mp3Kbps !== prefs.mp3Kbps;

  const begin = <I,>(key: string, type: string, title: string, input: I) => {
    const t = startTask<I, { fileName: string }>(type, title, input);
    setRunning((r) => ({ ...r, [key]: t.id }));
    t.done.then(
      (res) => st.toast('success', `Exported ${res.fileName}`),
      (err: Error) => err.name !== 'AbortError' && st.toast('error', `${title} failed: ${err.message}`),
    );
  };

  const safe = (label: string, fn: () => void | Promise<void>) => async () => {
    try {
      await fn();
    } catch (err) {
      st.toast('error', `${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const enc = (format: AudioFormat) => ({
    format,
    wavBits: settings.wavBits,
    flacBits: settings.flacBits,
    kbps: format === 'aac' ? settings.aacKbps : settings.mp3Kbps,
    sampleRate: settings.sampleRate,
  });
  const audioFormatDisabled = settings.format === 'aac' && aac !== null && !aac.supported;
  const exportAudio = (which: AudioWhich, label: string) =>
    begin<AudioExportInput>(`audio-${which}`, 'export.audio', `Export ${label} (${describeEncoding(enc(settings.format))})`, { projectId: project.meta.id, which, fileBase: base, ...enc(settings.format) });

  const master = currentMaster(project, song);
  const target = targetInfo(song.mastering.target);
  const hasVocals = vocalTrackIds(song).length > 0;
  const hasInstrumental = instrumentalTrackIds(song).length > 0;
  const masterNote =
    song.mastering.method === 'none'
      ? 'Mastering is off (“user export”) — exports the unmastered mix.'
      : master && !master.stale
        ? `Uses the saved master (${target.label}).`
        : master?.stale
          ? 'Saved master is out of date — the current mix is mastered on the fly.'
          : `No master yet — mastered on the fly for ${target.label}.`;

  const everythingTask = running.everything;

  return (
    <div className="mode-page ex-page">
      <div className="page-header">
        <div className="grow">
          <h1>Export</h1>
          <div className="lede">
            Your work always leaves with you: the project, every MIDI part, the mix in any format, stems, sheets and notation, and DAW-ready sessions. Renders run
            in the generation queue — keep working while they finish.
          </div>
        </div>
        <Button icon="tasks" variant="ghost" onClick={() => st.setTaskDrawer(true)}>
          Queue{activeExportCount ? ` (${activeExportCount})` : ''}
        </Button>
      </div>

      <div className="panel ex-settings" aria-label="Export settings">
        <div className="ex-settings-row">
          <label className="ex-setting">
            <span className="field-label">Sample rate</span>
            <Select
              size="sm"
              value={String(settings.sampleRate)}
              onChange={(v) => set({ sampleRate: Number(v) as SampleRate })}
              options={[
                { value: '44100', label: '44.1 kHz' },
                { value: '48000', label: '48 kHz' },
              ]}
              aria-label="Sample rate"
            />
          </label>
          <label className="ex-setting">
            <span className="field-label">WAV</span>
            <Select
              size="sm"
              value={String(settings.wavBits)}
              onChange={(v) => set({ wavBits: Number(v) as WavBits })}
              options={[
                { value: '16', label: '16-bit' },
                { value: '24', label: '24-bit' },
                { value: '32', label: '32-bit float' },
              ]}
              aria-label="WAV bit depth"
            />
          </label>
          <label className="ex-setting">
            <span className="field-label">FLAC</span>
            <Select
              size="sm"
              value={String(settings.flacBits)}
              onChange={(v) => set({ flacBits: Number(v) as FlacBits })}
              options={[
                { value: '16', label: '16-bit' },
                { value: '24', label: '24-bit' },
              ]}
              aria-label="FLAC bit depth"
            />
          </label>
          <label className="ex-setting">
            <span className="field-label">MP3</span>
            <Select size="sm" value={String(settings.mp3Kbps)} onChange={(v) => set({ mp3Kbps: Number(v) })} options={KBPS.map((k) => ({ value: String(k), label: `${k} kbps` }))} aria-label="MP3 bitrate" />
          </label>
          <label className="ex-setting">
            <span className="field-label">AAC</span>
            <Select size="sm" value={String(settings.aacKbps)} onChange={(v) => set({ aacKbps: Number(v) })} options={KBPS.map((k) => ({ value: String(k), label: `${k} kbps` }))} aria-label="AAC bitrate" />
          </label>
          <div className="spacer" />
          <span className="small dim" title="Solo is a monitoring control; mutes are part of the mix">
            Solo ignored · mutes honored
          </span>
          <Button size="sm" variant="ghost" onClick={saveDefaults} disabled={!differsFromPrefs} title="Store these as the default export settings">
            Save as default
          </Button>
        </div>
      </div>

      <section className="panel ex-hero" aria-label="Export everything">
        <div className="ex-hero-body">
          <div className="grow">
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <Icon name="layers" />
              <h2 style={{ margin: 0 }}>Export everything</h2>
            </div>
            <div className="muted small" style={{ marginBottom: 8 }}>
              One archive with every deliverable — exactly the set from the spec’s complete workflow. {masterNote}
            </div>
            <div className="ex-filelist">
              {[
                song.mastering.method === 'none' ? 'Mix.wav' : 'Master.wav',
                hasInstrumental ? 'Instrumental.wav' : null,
                hasVocals ? 'Acapella.wav' : null,
                'Stems.zip',
                'Song.mid',
                'Song.musicxml',
                `${base}.songproject`,
              ]
                .filter(Boolean)
                .map((f) => (
                  <span key={f} className="ex-file">
                    {f}
                  </span>
                ))}
            </div>
          </div>
          <div className="ex-hero-action">
            <TaskButton
              taskId={everythingTask}
              label="Export everything (.zip)"
              icon="export"
              variant="primary"
              onStart={() => begin<EverythingInput>('everything', 'export.everything', 'Export everything', { projectId: project.meta.id, wavBits: settings.wavBits, sampleRate: settings.sampleRate, fileBase: base })}
            />
            <span className="small dim">
              WAV {settings.wavBits === 32 ? '32-bit float' : `${settings.wavBits}-bit`} · {settings.sampleRate / 1000} kHz
            </span>
          </div>
        </div>
      </section>

      <div className="ex-grid">
        <Card icon="folder" title="Project" subtitle="The native package: song, full version history & branches, audio assets, provenance and rights metadata. Re-opens anywhere.">
          <Row name={`${base}.songproject`} detail={`${project.history.revisions.length} revisions · ${project.meta.assets.length} audio assets`}>
            <Button
              size="sm"
              icon="download"
              onClick={safe('Project export', async () => {
                const bytes = await st.exportProjectBytes();
                deliverFile(`${base}.songproject`, bytes, MIME.songproject, { detail: 'Song Deck project package' });
              })}
            >
              .songproject
            </Button>
          </Row>
        </Card>

        <Card icon="midi" title="MIDI" subtitle="Standard MIDI files with tempo map, meter, key, markers, lyrics and program changes.">
          <Row name="Multi-track MIDI" detail={`${midiTracks.length} tracks in one Type 1 file`}>
            <Button size="sm" icon="download" disabled={!midiTracks.length} onClick={safe('MIDI export', () => void deliverFile(`${base}.mid`, songToMidi(song, custom), MIME.midi, { detail: 'Multi-track MIDI' }))}>
              Song.mid
            </Button>
          </Row>
          <Row name="Individual tracks" detail="One .mid per track, zipped">
            <Button
              size="sm"
              icon="download"
              disabled={!midiTracks.length}
              onClick={safe('MIDI tracks export', async () => {
                const entries = midiTracks.map((t) => ({ name: `${String(song.tracks.indexOf(t) + 1).padStart(2, '0')} ${sanitizeFileName(t.name, 'Track')}.mid`, data: trackToMidi(song, t.id, custom) }));
                const zip = await zipEntries(entries);
                deliverFile(`${base} - MIDI tracks.zip`, zip, MIME.zip, { detail: `${entries.length} MIDI files` });
              })}
            >
              Tracks .zip
            </Button>
          </Row>
          <Row name="Single track" detail="Export one part">
            <Select
              size="sm"
              value={singleTrack || midiTracks[0]?.id || ''}
              onChange={setSingleTrack}
              options={midiTracks.map((t) => ({ value: t.id, label: t.name }))}
              aria-label="Track to export"
              style={{ width: 140 }}
              disabled={!midiTracks.length}
            />
            <Button
              size="sm"
              icon="download"
              disabled={!midiTracks.length}
              onClick={safe('Track export', () => {
                const id = singleTrack || midiTracks[0]?.id;
                const t = song.tracks.find((x) => x.id === id);
                if (!t) return;
                deliverFile(`${base} - ${sanitizeFileName(t.name, 'Track')}.mid`, trackToMidi(song, t.id, custom), MIME.midi, { detail: `MIDI · ${t.name}` });
              })}
            >
              .mid
            </Button>
          </Row>
        </Card>

        <Card
          icon="wave"
          title="Audio"
          subtitle="Rendered with the same engine you hear in playback: mixer, automation and master bus included."
          badge={
            <Select
              size="sm"
              value={settings.format}
              onChange={(v) => set({ format: v })}
              options={[
                { value: 'wav', label: `WAV · ${settings.wavBits === 32 ? '32f' : settings.wavBits}` },
                { value: 'flac', label: `FLAC · ${settings.flacBits}` },
                { value: 'mp3', label: `MP3 · ${settings.mp3Kbps}k` },
                { value: 'aac', label: `AAC · ${settings.aacKbps}k${aac && !aac.supported ? ' (unavailable)' : ''}` },
              ]}
              aria-label="Audio format"
              style={{ width: 130 }}
            />
          }
        >
          {settings.format === 'aac' && aac && !aac.supported && <div className="callout warning small">{aac.reason}</div>}
          <Row name="Mix" detail="Full mix through the master bus (unmastered)">
            <TaskButton taskId={running['audio-mix']} label={`Mix.${settings.format}`} onStart={() => exportAudio('mix', 'mix')} disabled={audioFormatDisabled} title={audioFormatDisabled ? aac?.reason : undefined} />
          </Row>
          <Row name="Master" detail={masterNote}>
            <TaskButton taskId={running['audio-master']} label={`Master.${settings.format}`} onStart={() => exportAudio('master', 'master')} disabled={audioFormatDisabled} title={audioFormatDisabled ? aac?.reason : undefined} />
          </Row>
          <Row name="Instrumental" detail="Every track except vocals">
            <TaskButton taskId={running['audio-instrumental']} label={`Instrumental.${settings.format}`} onStart={() => exportAudio('instrumental', 'instrumental')} disabled={audioFormatDisabled || !hasInstrumental} title={!hasInstrumental ? 'No instrumental tracks' : undefined} />
          </Row>
          <Row name="Acapella" detail={hasVocals ? 'Vocal tracks only' : 'No vocal tracks in this song'}>
            <TaskButton taskId={running['audio-acapella']} label={`Acapella.${settings.format}`} onStart={() => exportAudio('acapella', 'acapella')} disabled={audioFormatDisabled || !hasVocals} title={!hasVocals ? 'No vocal tracks' : undefined} />
          </Row>
        </Card>

        <Card icon="layers" title="Stems" subtitle="Time-aligned WAV stems from bar 1 — channel processing and sends included, master bus excluded.">
          <div className="row wrap" style={{ gap: 14 }}>
            <Toggle on={stemsBy === 'track'} onChange={(v) => setStemsBy(v ? 'track' : 'stemGroup')} label="One stem per track" />
            <Toggle on={includeAudio} onChange={setIncludeAudio} label="Include audio tracks individually" />
          </div>
          <Row
            name="Stems.zip"
            detail={stemsBy === 'stemGroup' ? 'Vocals · Drums · Bass · Guitars · Keys · Strings · Others' : `${song.tracks.length} track stems`}
          >
            <TaskButton
              taskId={running.stems}
              label="Stems.zip"
              onStart={() =>
                begin<StemsExportInput>('stems', 'export.stems', `Export stems (${stemsBy === 'stemGroup' ? 'by group' : 'per track'})`, {
                  projectId: project.meta.id,
                  by: stemsBy,
                  wavBits: settings.wavBits,
                  sampleRate: settings.sampleRate,
                  includeAudioTracks: includeAudio,
                  fileBase: base,
                })
              }
            />
          </Row>
        </Card>

        <Card icon="book" title="Composition" subtitle="Readable documents of the music itself: chords, lyrics, notation.">
          <Row name="Chord sheet" detail="Sections with chord symbols per bar (.txt)">
            <Button size="sm" icon="download" onClick={safe('Chord sheet', () => void deliverFile(`${base} - Chords.txt`, songToChordSheet(song), MIME.text, { detail: 'Chord sheet' }))}>
              Chords.txt
            </Button>
          </Row>
          <Row name="Lyric sheet" detail={song.lyrics.length ? `${song.lyrics.length} lyric lines` : 'No lyrics yet — exports section headings'}>
            <Button size="sm" icon="download" onClick={safe('Lyric sheet', () => void deliverFile(`${base} - Lyrics.txt`, songToLyricSheet(song), MIME.text, { detail: 'Lyric sheet' }))}>
              Lyrics.txt
            </Button>
          </Row>
          <Row name="MusicXML" detail="All parts for MuseScore, Sibelius, Finale, Dorico">
            <Button size="sm" icon="download" onClick={safe('MusicXML', () => void deliverFile(`${base}.musicxml`, songToMusicXML(song, custom), MIME.musicxml, { detail: 'MusicXML score' }))}>
              .musicxml
            </Button>
          </Row>
          <Row name="Notation PDF" detail="Lead sheet: melody, chords and lyrics">
            <Select
              size="sm"
              value={pdfTrack}
              onChange={setPdfTrack}
              options={[{ value: 'auto', label: 'Lead (auto)' }, ...midiTracks.map((t) => ({ value: t.id, label: t.name }))]}
              aria-label="Notation track"
              style={{ width: 120 }}
            />
            <Select
              size="sm"
              value={pdfPage}
              onChange={setPdfPage}
              options={[
                { value: 'letter', label: 'Letter' },
                { value: 'a4', label: 'A4' },
              ]}
              aria-label="Page size"
              style={{ width: 76 }}
            />
            <Button
              size="sm"
              icon="download"
              onClick={safe('Notation PDF', () => {
                const pdf = songToNotationPdf(song, { ...custom, trackId: pdfTrack === 'auto' ? undefined : pdfTrack, pageSize: pdfPage, title: song.title, composer: useSettings.getState().userName || 'Song Deck' });
                deliverFile(`${base} - Lead Sheet.pdf`, pdf, MIME.pdf, { detail: 'Notation PDF' });
              })}
            >
              .pdf
            </Button>
          </Row>
        </Card>

        <Card icon="plug" title="DAW interoperability" subtitle="Ableton Live, Logic Pro, FL Studio, Reaper, Studio One, Cubase, Pro Tools — via projects, multitrack MIDI, stems, tempo map and markers.">
          <Toggle on={renderMidiAudio} onChange={setRenderMidiAudio} label="Render MIDI tracks to audio too (playable without instruments)" />
          <Row name="DAWproject" detail="Open format for Bitwig, Studio One, Cubase">
            <TaskButton
              taskId={running.dawproject}
              label=".dawproject"
              onStart={() =>
                begin<DawExportInput>('dawproject', 'export.daw', 'Export DAWproject', { projectId: project.meta.id, target: 'dawproject', wavBits: settings.wavBits, sampleRate: settings.sampleRate, renderMidi: renderMidiAudio, fileBase: base })
              }
            />
          </Row>
          <Row name="Reaper project" detail=".rpp with embedded MIDI, markers & tempo, plus referenced audio and per-track .mid">
            <TaskButton
              taskId={running.reaper}
              label="Reaper .zip"
              onStart={() =>
                begin<DawExportInput>('reaper', 'export.daw', 'Export Reaper project', { projectId: project.meta.id, target: 'reaper', wavBits: settings.wavBits, sampleRate: settings.sampleRate, renderMidi: renderMidiAudio, fileBase: base })
              }
            />
          </Row>
          <Row name="Tempo map" detail="Bar, beat, time and BPM (.csv)">
            <Button size="sm" icon="download" onClick={safe('Tempo map', () => void deliverFile(`${base} - Tempo map.csv`, tempoMapCsv(song), MIME.csv, { detail: 'Tempo map' }))}>
              .csv
            </Button>
          </Row>
          <Row name="Markers" detail="Section markers for any DAW (.csv)">
            <Button size="sm" icon="download" onClick={safe('Markers', () => void deliverFile(`${base} - Markers.csv`, markersCsv(song), MIME.csv, { detail: 'Section markers' }))}>
              .csv
            </Button>
          </Row>
          <Row name="Audacity labels" detail="Section label track (.txt)">
            <Button size="sm" icon="download" onClick={safe('Audacity labels', () => void deliverFile(`${base} - Labels.txt`, audacityLabels(song), MIME.text, { detail: 'Audacity labels' }))}>
              .txt
            </Button>
          </Row>
        </Card>

        <Card icon="plug" title="Plugin exporters" subtitle="Formats contributed by enabled plugins (Settings → Plugins).">
          {exporters.length === 0 ? (
            <div className="small dim">
              No exporter plugins are loaded. Enable one (e.g. “ABC notation exporter”) in Settings → Plugins and it appears here.
              <div style={{ marginTop: 6 }}>
                <Button size="sm" variant="ghost" icon="settings" onClick={() => st.setMode('settings')}>
                  Open Settings
                </Button>
              </div>
            </div>
          ) : (
            exporters.map((x) => (
              <Row key={x.id} name={x.name} detail={x.description ?? `.${x.extension}`}>
                <Button
                  size="sm"
                  icon="download"
                  onClick={safe(x.name, async () => {
                    const out = await x.export(song);
                    deliverFile(`${base}.${x.extension}`, out, x.mimeType || 'application/octet-stream', { detail: `Plugin · ${x.name}` });
                  })}
                >
                  .{x.extension}
                </Button>
              </Row>
            ))
          )}
        </Card>
      </div>

      <RecentExports files={files} />
    </div>
  );
}

function RecentExports({ files }: { files: ReturnType<typeof useExportFiles.getState>['files'] }) {
  if (!files.length) return null;
  return (
    <section className="panel ex-recent" aria-label="Recent exports">
      <div className="panel-header">
        <Icon name="history" />
        <h3 className="grow">Recent exports</h3>
        <span className="small dim">Kept in memory for this session — download again without re-rendering</span>
        <Button size="sm" variant="ghost" onClick={() => clearExportedFiles()}>
          Clear
        </Button>
      </div>
      <table className="table">
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td>
                <div style={{ fontWeight: 600 }}>{f.name}</div>
                {f.detail && <div className="small dim ellipsis" style={{ maxWidth: 640 }}>{f.detail}</div>}
              </td>
              <td className="num" style={{ width: 100 }}>
                {formatBytes(f.size)}
              </td>
              <td style={{ width: 110 }} className="small dim">
                {new Date(f.createdAt).toLocaleTimeString()}
              </td>
              <td style={{ width: 170, textAlign: 'right' }}>
                <Button size="sm" icon="download" onClick={() => downloadFile(f)}>
                  Download
                </Button>
                <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${f.name}`} onClick={() => removeExportedFile(f.id)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small dim" style={{ padding: '6px 12px 10px' }}>
        <Badge>{files.length}</Badge> file{files.length === 1 ? '' : 's'} · {formatBytes(files.reduce((n, f) => n + f.size, 0))}
      </div>
    </section>
  );
}
