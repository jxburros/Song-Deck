import { useEffect, useState } from 'react';
import {
  assetPathFor,
  STEM_COLORS,
  barToTick,
  defaultChannelStrip,
  randomId,
  songLengthBars,
  type AudioAssetMeta,
  type AudioClip,
  type ProvenanceRecord,
  type StemGroup,
  type Track,
  type TrackRole,
} from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import { useStudio } from '../../state/store';
import { decodeAudioBytes, guessMime } from '../../state/assets';
import { player } from '../../engine/player';
import { recordAttestation, requestAttestation, type PendingAttestation } from '../../engine/rights';
import { Button, Field, FileButton, Modal, NumberInput, Select, Spinner, TextInput } from '../../ui/kit';
import { formatDuration } from '../../hooks';
import { STEM_GROUPS } from '../shared/stemGroups';

/**
 * Stem mixing (spec Phase 5): bring an audio file (a produced stem, a recording, a bounce from
 * another DAW) into the song as an audio track. It is then mixed exactly like any other track.
 */

const GROUP_ROLE: Record<StemGroup, TrackRole> = {
  vocals: 'vocal',
  drums: 'drums',
  bass: 'bass',
  guitars: 'rhythm-guitar',
  keys: 'keys',
  strings: 'strings',
  others: 'custom',
};

export function guessStemGroup(name: string): StemGroup {
  const n = name.toLowerCase();
  if (/vox|vocal|voice|sing|acap|lead ?v|choir|bv|harmony/.test(n)) return 'vocals';
  if (/drum|kick|snare|perc|hat|cymbal|tom|overhead|beat|loop/.test(n)) return 'drums';
  if (/bass|808|sub/.test(n)) return 'bass';
  if (/guit|gtr|acoustic|electric/.test(n)) return 'guitars';
  if (/key|piano|organ|synth|rhodes|pad|wurli|arp|lead/.test(n)) return 'keys';
  if (/string|violin|viola|cello|orch|ensemble|fiddle/.test(n)) return 'strings';
  return 'others';
}

function baseName(file: string): string {
  return (
    file
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Audio'
  );
}

function ImportModal({
  file,
  attestation,
  onClose,
}: {
  file: File;
  attestation: PendingAttestation;
  onClose: () => void;
}) {
  const song = useStudio((s) => s.project?.song);
  const st = useStudio.getState();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [audio, setAudio] = useState<AudioData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(() => baseName(file.name));
  const [group, setGroup] = useState<StemGroup>(() => guessStemGroup(file.name));
  const [kind, setKind] = useState<'stem' | 'import'>('stem');
  const [bar, setBar] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const b = new Uint8Array(await file.arrayBuffer());
        const a = await decodeAudioBytes(b);
        if (!alive) return;
        setBytes(b);
        setAudio(a);
      } catch (err) {
        if (alive)
          setError(`Could not decode “${file.name}”: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [file]);

  const duration = audio ? (audio.channels[0]?.length ?? 0) / audio.sampleRate : 0;
  const maxBar = Math.max(1, song ? songLengthBars(song) : 1);

  const doImport = async () => {
    const cur = useStudio.getState().project?.song;
    if (!cur || !bytes || !audio) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const assetId = randomId('asset');
      const provenanceId = randomId('prov');
      const meta: AudioAssetMeta = {
        id: assetId,
        name: file.name,
        kind,
        path: assetPathFor(kind, file.name),
        mimeType: guessMime(file.name, bytes),
        sampleRate: audio.sampleRate,
        channels: audio.channels.length,
        durationSeconds: duration,
        bytes: bytes.length,
        createdAt: now,
        provenanceId,
      };
      await st.addAsset(meta, bytes);
      const provenance: ProvenanceRecord = {
        id: provenanceId,
        artifactId: assetId,
        artifactName: file.name,
        artifactKind: 'audio',
        sources: [{ kind: 'file', ref: file.name }],
        providerId: 'user-import',
        providerName: 'Imported by the user',
        parameters: { stemGroup: group, startBar: bar, kind },
        generatedAt: now,
        cloud: false,
      };
      useStudio.getState().addProvenance(provenance);
      recordAttestation(attestation, { assetId, provenanceId });
      const trackId = randomId('trk');
      const clip: AudioClip = {
        id: randomId('clip'),
        assetId,
        tick: barToTick(cur, Math.max(0, bar - 1)),
        offsetSeconds: 0,
        durationSeconds: duration,
        gainDb: 0,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        name: file.name,
      };
      const track: Track = {
        id: trackId,
        name: name.trim() || baseName(file.name),
        kind: 'audio',
        role: GROUP_ROLE[group],
        instrumentId: 'audio',
        constraints: {},
        notes: [],
        clips: [clip],
        color: STEM_COLORS[group],
        stemGroup: group,
        generator: { id: kind === 'stem' ? 'stem-import' : 'audio-import' },
      };
      player.provideAsset(assetId, audio);
      const latest = useStudio.getState().project?.song ?? cur;
      useStudio.getState().commit(
        {
          ...latest,
          tracks: [...latest.tracks, track],
          // Imported stems are already balanced/processed: start at unity with no reverb send.
          mixer: {
            ...latest.mixer,
            channels: {
              ...latest.mixer.channels,
              [trackId]: defaultChannelStrip({ volumeDb: 0, reverbSend: 0 }),
            },
          },
        },
        `Imported ${kind === 'stem' ? 'stem' : 'audio'} “${file.name}” as track ${track.name}`,
        'import',
      );
      useStudio.getState().selectTrack(trackId);
      st.toast(
        'success',
        `Added audio track “${track.name}” (${formatDuration(duration)}) — mix it like any other track.`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import stem / audio"
      icon="upload"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="plus" onClick={() => void doImport()} disabled={!audio || busy}>
            {busy ? 'Importing…' : 'Add audio track'}
          </Button>
        </>
      }
    >
      <div className="col">
        <div className="card row between">
          <div className="ellipsis">
            <div style={{ fontWeight: 600 }} className="ellipsis">
              {file.name}
            </div>
            <div className="small dim">
              {audio
                ? `${formatDuration(duration)} · ${(audio.sampleRate / 1000).toFixed(1)} kHz · ${audio.channels.length === 1 ? 'mono' : 'stereo'} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`
                : error
                  ? 'Unreadable'
                  : 'Decoding…'}
            </div>
          </div>
          {!audio && !error && <Spinner />}
        </div>
        {error && <div className="callout danger small">{error}</div>}
        <div className="grid-2">
          <Field label="Track name">
            <TextInput value={name} onChange={setName} aria-label="Track name" />
          </Field>
          <Field label="Stem group" hint="Used for Stems.zip and Instrumental/Acapella exports">
            <Select value={group} onChange={setGroup} options={STEM_GROUPS} aria-label="Stem group" />
          </Field>
          <Field label="Asset type">
            <Select
              value={kind}
              onChange={setKind}
              options={[
                { value: 'stem', label: 'Stem (produced part of this song)' },
                { value: 'import', label: 'Imported audio' },
              ]}
              aria-label="Asset type"
            />
          </Field>
          <Field label="Starts at bar" hint={`1 – ${maxBar}`}>
            <NumberInput
              value={bar}
              min={1}
              max={maxBar}
              onChange={(v) => setBar(Math.round(v))}
              aria-label="Start bar"
            />
          </Field>
        </div>
        <div className="small dim">
          The file is stored inside the project (.songproject) and plays through its own channel strip, so EQ,
          compression, sends, automation and the AI mix assistant all apply.
        </div>
      </div>
    </Modal>
  );
}

export function ImportStemButton() {
  const [pending, setPending] = useState<{ file: File; attestation: PendingAttestation } | null>(null);
  // Rights attestation first (docs/RIGHTS.md); cancelling it abandons the import.
  const choose = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const attested = await requestAttestation([{ name: file.name, bytes }], {
        context: 'mix-stem',
        purpose: 'Import a stem or audio file into the mix',
      });
      if (attested) setPending({ file, attestation: attested[0] });
      else useStudio.getState().toast('info', `Import of “${file.name}” cancelled.`);
    } catch (err) {
      useStudio
        .getState()
        .toast('error', `Could not read “${file.name}”: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <>
      <FileButton
        accept="audio/*,.wav,.flac,.mp3,.m4a,.aac,.ogg,.oga,.webm"
        onFile={(files) => void choose(files[0])}
        icon="upload"
      >
        Import stem/audio
      </FileButton>
      {pending && (
        <ImportModal file={pending.file} attestation={pending.attestation} onClose={() => setPending(null)} />
      )}
    </>
  );
}
