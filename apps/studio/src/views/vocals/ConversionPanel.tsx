import { useState } from 'react';
import { randomSeed, type Project, type Track } from '@songdeck/core';
import { ConsentRequiredError } from '@songdeck/ai';
import { useStudio } from '../../state/store';
import { getRegistry, useAiRuntime } from '../../engine/ai';
import { VOICE_KIND_LABEL, consentSummary, projectVoiceChoices, resolveVoice } from '../../engine/vocal-model';
import { assertVoiceAuthorized, hasConversionProvider } from '../../engine/vocal-render';
import { enqueueConvert } from '../../engine/vocal-sync';
import { Badge, Button, Field, NumberInput, Select } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ProviderPicker } from '../shared/ProviderPicker';
import { useVocalSession } from './session';
import { TaskLine } from './shared';
import { VoiceModelModal, chooseConversionVoice, providerName, type VoiceModalRequest } from './VoicesPanel';

/**
 * User voice conversion (spec §33, §36): render a neutral performance with the built-in singer,
 * then convert it to an authorized target voice with a VOICE_CONVERSION provider. Consent is
 * checked before anything is rendered or sent; conversion never runs without a provider.
 */
export function ConversionPanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const st = useStudio.getState();
  const session = useVocalSession();
  useAiRuntime((s) => s.version);
  const [modal, setModal] = useState<VoiceModalRequest | null>(null);
  const targets = projectVoiceChoices(project).filter((v) => v.kind !== 'stock');
  const targetKey = song.vocals.conversionVoiceId ?? session.conversionTarget ?? targets[0]?.key ?? '';
  const target = targets.find((t) => t.key === targetKey);
  const providerReady = hasConversionProvider();
  const vcProviders = getRegistry().findCompatible(['VOICE_CONVERSION'], { interface: 'voiceConversion', includeUnavailable: true });
  const neutral = resolveVoice(project, undefined, track);

  const convert = async () => {
    session.set({ conversionBlocked: null, conversionError: null });
    if (!target) {
      session.set({ conversionError: 'Choose a target voice first — add the voice model in the Voices tab.' });
      return;
    }
    // 1. Consent (spec §36) — before anything is rendered or sent.
    try {
      assertVoiceAuthorized(target);
    } catch (err) {
      if (err instanceof ConsentRequiredError || (err instanceof Error && err.name === 'ConsentRequiredError')) {
        session.set({ conversionBlocked: `Blocked: ${(err as Error).message} Nothing was rendered or sent.` });
        return;
      }
      throw err;
    }
    // 2. A provider must exist (there is no on-device voice conversion).
    if (!providerReady) {
      session.set({
        conversionError:
          'No voice-conversion provider is configured. Conversion needs a VOICE_CONVERSION provider — for example the RVC bridge (local) — added in Settings → AI providers. Song Deck has no on-device voice conversion, so nothing was converted.',
      });
      return;
    }
    // 3. Per-use confirmation of the attestation.
    const ok = await st.requestConfirm({
      kind: 'consent',
      title: `Convert the vocal to “${target.name}”?`,
      body: {
        message: `A neutral performance is rendered with the built-in singer (${neutral.name}) and converted to ${target.name} (${VOICE_KIND_LABEL[target.kind].toLowerCase()}). The attestation is recorded in the converted render's provenance.`,
        warning: consentSummary(target.consent),
        confirmLabel: 'Convert',
      },
    });
    if (!ok) return;
    if (song.vocals.conversionVoiceId !== target.key) chooseConversionVoice(target.key, target.name);
    const t = enqueueConvert(
      { projectId: project.meta.id, trackId: track.id, targetKey: target.key, providerChoice: session.conversionProvider, pitchShift: session.pitchShift, seed: randomSeed() },
      `Convert ${track.name} to ${target.name}`,
    );
    session.set({ tasks: { ...session.tasks, convert: t.id } });
  };

  return (
    <div className="col" style={{ gap: 12 }} data-testid="conversion-panel">
      <div className="panel">
        <div className="panel-header">
          <Icon name="users" />
          <h3 className="grow">User voice conversion</h3>
          <Badge tone={providerReady ? 'success' : 'warning'}>{providerReady ? `${vcProviders.length} conversion provider${vcProviders.length === 1 ? '' : 's'}` : 'no conversion provider'}</Badge>
        </div>
        <div className="panel-body col">
          <ol className="vx-steps small">
            <li>
              <strong>Neutral performance</strong> — the built-in singer sings {track.name} ({neutral.name}) from the vocal MIDI, lyrics and expression.
            </li>
            <li>
              <strong>Conversion</strong> — a VOICE_CONVERSION provider turns it into the authorized target voice; the result becomes the vocal render.
            </li>
          </ol>
          {!providerReady && (
            <div className="callout warning small" data-testid="no-vc-provider">
              <strong>No voice-conversion provider is configured.</strong> Add one (e.g. the RVC bridge running locally) in Settings → AI providers. Without it Song Deck can still
              sing with stock voices, but it will not convert to another voice.
              <div style={{ marginTop: 6 }}>
                <Button size="sm" icon="settings" onClick={() => st.setMode('settings')}>
                  Open Settings
                </Button>
              </div>
            </div>
          )}
          <div className="vx-write-grid">
            <Field label="Target voice">
              <Select
                value={target?.key ?? ''}
                onChange={(key) => {
                  const v = targets.find((x) => x.key === key);
                  session.set({ conversionTarget: key, conversionBlocked: null, conversionError: null });
                  if (v) chooseConversionVoice(v.key, v.name);
                }}
                options={targets.length ? targets.map((v) => ({ value: v.key, label: `${v.name} — ${v.authorized ? 'authorized' : 'consent required'}` })) : [{ value: '', label: 'No voice models yet' }]}
                aria-label="Target voice"
              />
            </Field>
            <Field label="Conversion provider">
              <ProviderPicker role="voice-conversion" value={session.conversionProvider} onChange={(v) => session.set({ conversionProvider: v })} />
            </Field>
            <Field label="Pitch shift (semitones)">
              <NumberInput value={session.pitchShift} onChange={(v) => session.set({ pitchShift: Math.round(v) })} min={-24} max={24} aria-label="Pitch shift" />
            </Field>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" icon="users" onClick={() => void convert()} disabled={!track.notes.length}>
                Render &amp; convert
              </Button>
            </div>
          </div>
          <div className="small dim">Targets are the user-trained, imported and third-party voices of the Voices tab. Pitch shift: e.g. +12 for a male → female conversion.</div>
          {target && (
            <div className={`card small row wrap`} data-testid="conversion-target">
              <Icon name="shield" size={13} />
              <strong>{target.name}</strong>
              <Badge>{VOICE_KIND_LABEL[target.kind]}</Badge>
              <span className="muted">{providerName(target.providerId)}</span>
              <span className="grow" />
              {target.authorized ? <Badge tone="success">Authorized</Badge> : <Badge tone="danger">Consent required</Badge>}
              {!target.authorized && (
                <Button size="sm" variant="primary" icon="shield" onClick={() => target.record && setModal({ mode: 'attest', initial: target.record, useFor: 'conversion' })}>
                  Attest authorization
                </Button>
              )}
              {target.authorized && <div className="small dim" style={{ width: '100%' }}>{consentSummary(target.consent)}</div>}
            </div>
          )}
          {session.conversionBlocked && (
            <div className="callout danger small" role="alert" data-testid="conversion-blocked">
              <strong>Consent required.</strong> {session.conversionBlocked}
              {target?.record && (
                <div style={{ marginTop: 6 }}>
                  <Button size="sm" variant="primary" icon="shield" onClick={() => setModal({ mode: 'attest', initial: target.record, useFor: 'conversion' })}>
                    Attest authorization
                  </Button>
                </div>
              )}
            </div>
          )}
          {session.conversionError && (
            <div className="callout warning small" role="alert" data-testid="conversion-error">
              {session.conversionError}
            </div>
          )}
          <TaskLine taskId={session.tasks.convert} />
          <div className="small dim">
            Song Deck never converts to a non-stock voice without an attestation; providers also refuse (ConsentRequiredError). The converted render records the target voice,
            its attestation, the neutral source render and the provider.
          </div>
        </div>
      </div>
      {modal && <VoiceModelModal project={project} track={track} request={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
