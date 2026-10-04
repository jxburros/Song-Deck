import { useEffect, useState } from 'react';
import { randomId } from '@songdeck/core';
import { fileToLibraryDraft, type LibraryItem } from '../../state/library';
import { useStudio } from '../../state/store';
import { Button, FileButton, NumberInput, Select } from '../../ui/kit';
import { LibraryBrowser } from '../library/LibraryMode';
import { RecordPanel } from '../transcribe/RecordPanel';
import { INTERPRETATIONS, playableItem, useComposeInputs } from './inputs';

export function InputsPanel({
  disabled,
  onLoadingChange,
}: {
  disabled: boolean;
  onLoadingChange: (loading: boolean) => void;
}) {
  const state = useComposeInputs();
  const [showLibrary, setShowLibrary] = useState(false);
  const [record, setRecord] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    onLoadingChange(loading);
    return () => onLoadingChange(false);
  }, [loading, onLoadingChange]);
  const add = async (item: LibraryItem) => {
    setLoading(true);
    try {
      state.add(await playableItem(item));
    } catch (e) {
      useStudio.getState().toast('error', `Could not add input: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="panel" style={{ marginBottom: 16 }} aria-label="Composition inputs">
      <div className="panel-header">
        <h3>Recordings, MIDI & library items</h3>
      </div>
      <div className="panel-body col">
        <p className="small muted">
          Combine any number of full songs, partial performances, rough ideas, MIDI files, or track
          collections with the prompt, lyrics and composer table below.
        </p>
        <div className="row wrap">
          <FileButton
            multiple
            accept="audio/*,.mid,.midi,.songproject,.wav,.flac,.mp3"
            disabled={disabled || loading}
            onFile={(files) => {
              void (async () => {
                setLoading(true);
                try {
                  for (const file of files) {
                    const draft = await fileToLibraryDraft(file, true);
                    state.add(
                      await playableItem({
                        ...draft,
                        id: randomId('input'),
                        createdAt: new Date().toISOString(),
                      }),
                    );
                  }
                } catch (e) {
                  if (!(e instanceof Error && e.name === 'AbortError'))
                    useStudio.getState().toast('error', String(e));
                } finally {
                  setLoading(false);
                }
              })();
            }}
            icon="upload"
          >
            Add audio / MIDI files
          </FileButton>
          <Button disabled={disabled || loading} onClick={() => setShowLibrary(!showLibrary)}>
            Choose from Library
          </Button>
          <Button disabled={disabled || loading} icon="mic" onClick={() => setRecord(!record)}>
            Record an idea
          </Button>
          {loading && <span role="status">Analyzing input…</span>}
        </div>
        {record && (
          <RecordPanel
            kind="record"
            bpm={120}
            beatsPerBar={4}
            onCaptured={(c) => {
              if (c.bytes)
                void add({
                  id: randomId('input'),
                  name: c.name,
                  kind: 'audio',
                  assets: [],
                  createdAt: c.createdAt,
                  file: { name: c.name, mime: c.mimeType ?? 'audio/webm', bytes: c.bytes },
                });
              setRecord(false);
            }}
          />
        )}
        {showLibrary && (
          <LibraryBrowser
            onPick={(item) => {
              void add(item);
              setShowLibrary(false);
            }}
          />
        )}
        {state.inputs.map((input) => (
          <div key={input.id} className="card col" data-testid="compose-input">
            <div className="row wrap compose-input-header">
              <strong className="grow">{input.item.name}</strong>
              <label className="compose-start-bar">
                Start bar{' '}
                <NumberInput
                  min={1}
                  step={1}
                  value={input.startBar}
                  disabled={disabled}
                  onChange={(v) => state.patch(input.id, { startBar: Math.max(1, Math.round(v)) })}
                />
              </label>
              <Select
                aria-label={`Interpretation for ${input.item.name}`}
                value={input.interpretation}
                disabled={disabled}
                options={INTERPRETATIONS}
                onChange={(interpretation) => state.patch(input.id, { interpretation })}
              />
              <Button
                disabled={disabled}
                icon="close"
                title={`Remove ${input.item.name}`}
                onClick={() => state.remove(input.id)}
              />
            </div>
            <span className="small muted">
              {INTERPRETATIONS.find((i) => i.value === input.interpretation)?.hint}
              {input.item.kind === 'audio' && input.interpretation !== 'preserve'
                ? ' Audio will be transcribed to MIDI first; the original file is retained.'
                : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
