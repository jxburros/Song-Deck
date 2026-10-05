import { useState } from 'react';
import {
  getInstrument,
  keyName,
  randomId,
  secondsToTick,
  songToMidi,
  type AssetRequest,
  type Song,
} from '@songdeck/core';
import { encodeWav, type AudioData } from '@songdeck/audio';
import { SaveLibraryButton } from '../library/SaveLibraryButton';
import { useComposeInputs } from '../compose/inputs';
import { useComposeSession } from '../compose/session';
import { jobs } from '../../engine/jobs';
import { previewPlayer, usePreviewId, usePreviewPosition } from '../../engine/capture-playback';
import { downloadBytes, slugify } from '../../engine/capture-files';
import { useCustomInstruments } from '../../hooks';
import { useStudio } from '../../state/store';
import { Badge, Button, Spinner } from '../../ui/kit';
import { SongTrackNotation } from '../shared/NotationPreview';
import { NoteStrip } from '../shared/NoteStrip';

export interface Alternative {
  id: string;
  label: string;
  seed: number;
  song: Song;
  trackId: string;
  request: AssetRequest;
}

const renders = new WeakMap<Song, Promise<AudioData>>();

/** Render (once) the alternative's mini song with the guide renderer in the job worker. */
export function renderAlternative(song: Song): Promise<AudioData> {
  let p = renders.get(song);
  if (!p) {
    p = jobs.call<AudioData>('renderMix', { song, sampleRate: 44100 });
    p.catch(() => renders.delete(song));
    renders.set(song, p);
  }
  return p;
}

export function AlternativeCard({
  alt,
  standalone = false,
  output = 'midi',
  hasProject,
  onInsert,
  onOpen,
}: {
  alt: Alternative;
  standalone?: boolean;
  output?: 'midi' | 'audio';
  hasProject: boolean;
  onInsert: (alt: Alternative) => void;
  onOpen: (alt: Alternative) => void;
}) {
  const customInstruments = useCustomInstruments();
  const [rendering, setRendering] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const playingId = usePreviewId();
  const playing = playingId === alt.id;
  const pos = usePreviewPosition(alt.id);
  const track = alt.song.tracks.find((t) => t.id === alt.trackId) ?? alt.song.tracks[0];
  const inst = getInstrument(track?.instrumentId ?? alt.request.instrumentId, customInstruments);
  const drums = !!inst.isDrumKit;
  const bars = alt.song.sections.reduce((a, s) => a + s.bars, 0) || alt.request.bars;
  const meter = alt.song.meterMap[0] ?? alt.request.meter;
  const barTicks = (meter.numerator * 4 * alt.song.ppq) / meter.denominator;

  const togglePlay = async () => {
    if (playing) {
      previewPlayer.stop();
      return;
    }
    setRendering(true);
    try {
      const audio = await renderAlternative(alt.song);
      await previewPlayer.play(alt.id, audio);
    } catch (err) {
      useStudio
        .getState()
        .toast('error', `Audio preview failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRendering(false);
    }
  };

  const audioFile = async () => ({
    name: alt.song.title || inst.name,
    kind: 'audio' as const,
    assets: [],
    file: {
      name: `${slugify(alt.song.title || inst.name)}.wav`,
      mime: 'audio/wav',
      bytes: encodeWav(await renderAlternative(alt.song)),
    },
  });
  const exportAudio = async () => {
    setRendering(true);
    try {
      const item = await audioFile();
      downloadBytes(item.file.bytes, item.file.name, item.file.mime);
    } catch (e) {
      useStudio.getState().toast('error', String(e));
    } finally {
      setRendering(false);
    }
  };
  const exportMidi = () => {
    try {
      const bytes = songToMidi(alt.song);
      downloadBytes(
        bytes,
        `${slugify(alt.song.title || inst.name)}-${alt.label.toLowerCase()}-seed${alt.seed}.mid`,
        'audio/midi',
      );
    } catch (err) {
      useStudio
        .getState()
        .toast('error', `MIDI export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div
      className="card"
      data-testid="alternative-card"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
    >
      <div className="row between wrap">
        <div className="row" style={{ minWidth: 0 }}>
          <span className="badge accent" style={{ fontSize: 13, height: 24, padding: '0 9px' }}>
            {alt.label}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }} className="ellipsis">
              {track?.name ?? inst.name}
            </div>
            <div className="small muted">
              {bars} bars · {track?.notes.length ?? 0} notes ·{' '}
              {keyName(alt.song.keyMap[0]?.key ?? alt.request.key)} ·{' '}
              {Math.round(alt.song.tempoMap[0]?.bpm ?? alt.request.tempo)} BPM · {meter.numerator}/
              {meter.denominator}
            </div>
          </div>
        </div>
        <Badge title="Same request + seed + engine version ⇒ same MIDI (spec §23)">seed {alt.seed}</Badge>
      </div>

      <div
        className="notation-host"
        style={{
          background: 'var(--bg-elev-1)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          padding: '8px 6px',
        }}
      >
        {track && (
          <SongTrackNotation
            song={alt.song}
            trackId={track.id}
            maxBars={expanded ? undefined : 8}
            customInstruments={customInstruments}
          />
        )}
        {bars > 8 && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show first 8 bars' : `Show all ${bars} bars`}
            </Button>
          </div>
        )}
      </div>

      {track && (
        <NoteStrip
          notes={track.notes}
          ppq={alt.song.ppq}
          meter={meter}
          totalTicks={bars * barTicks}
          height={drums ? 74 : 64}
          colorBy="velocity"
          color={track.color}
          drums={drums}
          playheadTick={pos !== null ? secondsToTick(alt.song, pos) : null}
          testId="alternative-strip"
        />
      )}

      <div className="row wrap">
        <Button
          size="sm"
          variant={playing ? 'primary' : 'default'}
          icon={playing ? 'stop' : 'play'}
          onClick={() => void togglePlay()}
          disabled={rendering}
          aria-label={playing ? `Stop ${alt.label}` : `Play ${alt.label}`}
        >
          {rendering ? <Spinner /> : null}
          {playing ? 'Stop' : rendering ? 'Rendering…' : 'Play'}
        </Button>
        <Button size="sm" icon="download" onClick={exportMidi} aria-label={`Export ${alt.label} as MIDI`}>
          Export .mid
        </Button>
        <Button size="sm" disabled={rendering} onClick={() => void exportAudio()}>
          Export .wav
        </Button>
        {output === 'audio' ? <SaveLibraryButton file={audioFile} /> : <SaveLibraryButton song={alt.song} />}
        <div className="spacer" />
        {standalone && output !== 'audio' && (
          <Button
            size="sm"
            variant="primary"
            icon="sparkles"
            aria-label={`Start a song with ${alt.label}`}
            onClick={() => {
              useComposeInputs.getState().add({
                id: randomId('part'),
                name: alt.song.title || inst.name,
                kind: 'midi',
                createdAt: new Date().toISOString(),
                song: structuredClone(alt.song),
                assets: [],
              });
              useComposeSession.getState().start('midi');
              useStudio.getState().setMode('compose');
            }}
          >
            Start a song with it
          </Button>
        )}
        {!standalone && (
          <>
            <Button
              size="sm"
              variant="ai"
              icon="plus"
              onClick={() => onInsert(alt)}
              aria-label={`Insert ${alt.label}`}
            >
              {hasProject ? 'Insert into project…' : 'Insert into new project'}
            </Button>
            <Button
              size="sm"
              icon="folder"
              onClick={() => onOpen(alt)}
              aria-label={`Open ${alt.label} as new project`}
            >
              Open as new project
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
