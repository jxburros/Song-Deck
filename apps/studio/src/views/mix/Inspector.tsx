import {
  defaultChannelStrip,
  defaultMasterBus,
  type CompressorSettings,
  type EqSettings,
  type MixerState,
  type ReverbSettings,
  type Song,
} from '@songdeck/core';
import { Badge, Button, Select, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { CompressorEditor } from './CompressorEditor';
import { EqEditor } from './EqEditor';
import { Knob } from './controls';
import { applyMixer, commitMixer, commitMixerSoon, previewMixer } from './mixDraft';
import {
  DELAY_NOTES,
  FIELD_META,
  MASTER,
  fmtBeats,
  fmtDb,
  fmtPan,
  isStripLocked,
  setStripField,
  stripOf,
  withChannel,
  withMaster,
} from './mixModel';

/** Detailed editor for the selected strip: EQ curve, dynamics, character & sends (or master processing). */
export function Inspector({ song, mixer, target }: { song: Song; mixer: MixerState; target: string }) {
  const isMaster = target === MASTER;
  const track = isMaster ? null : song.tracks.find((t) => t.id === target);
  if (!isMaster && !track) return null;
  const locked = isStripLocked(song, target);
  const name = isMaster ? 'Master' : track!.name;
  const eq: EqSettings = isMaster ? mixer.master.eq : stripOf(mixer, target).eq;
  const comp: CompressorSettings = isMaster ? mixer.master.compressor : stripOf(mixer, target).compressor;
  const previewEq = (next: EqSettings) => previewMixer((m) => setStripField(m, target, 'eq', next));
  const previewComp = (next: CompressorSettings) =>
    previewMixer((m) => setStripField(m, target, 'compressor', next));
  const commit = () => commitMixer();
  const commitSoon = () => commitMixerSoon();

  const knob = (
    path: string,
    label: string,
    def: number,
    extra: {
      bipolar?: boolean;
      tone?: 'accent' | 'secondary' | 'muted';
      step?: number;
      format?: (v: number) => string;
      disabled?: boolean;
    } = {},
  ) => {
    const meta = FIELD_META[path];
    const strip = isMaster ? mixer.master : stripOf(mixer, target);
    const value = path
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], strip) as number;
    return (
      <Knob
        value={value ?? def}
        min={meta.min}
        max={meta.max}
        log={meta.log}
        step={extra.step}
        defaultValue={def}
        bipolar={extra.bipolar}
        tone={extra.tone}
        onPreview={(v) => previewMixer((m) => setStripField(m, target, path, v))}
        onCommit={commit}
        onKeyCommit={commitSoon}
        label={label}
        ariaLabel={`${name} ${meta.label.toLowerCase()}`}
        format={extra.format ?? meta.fmt}
        disabled={locked || extra.disabled}
        size={34}
      />
    );
  };

  return (
    <div className="panel mx-inspector" aria-label={`${name} inspector`}>
      <div className="panel-header">
        <span className="mx-color-dot" style={{ background: isMaster ? 'var(--accent)' : track!.color }} />
        <h3 className="grow">
          {name}{' '}
          <span className="small dim">
            · {isMaster ? 'master bus' : track!.kind === 'audio' ? 'audio track' : 'MIDI track'}
          </span>
        </h3>
        {locked && (
          <Badge tone="warning">
            <Icon name="lock" size={11} /> locked
          </Badge>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon="undo"
          disabled={locked}
          title="Reset this strip to default settings (one revision; undo restores it)"
          onClick={() =>
            applyMixer(
              (m) =>
                isMaster
                  ? withMaster(m, () => defaultMasterBus())
                  : withChannel(m, target, (ch) => ({
                      ...defaultChannelStrip(),
                      mute: ch.mute,
                      solo: ch.solo,
                    })),
              `${name}: strip reset to defaults`,
            )
          }
        >
          Reset strip
        </Button>
      </div>
      <div className="panel-body mx-inspector-grid">
        <section className="mx-section mx-section-eq" aria-label={`${name} EQ`}>
          <div className="row between mx-section-head">
            <h4>EQ</h4>
            <Toggle
              on={eq.enabled}
              onChange={(v) => {
                if (locked) return;
                previewEq({ ...eq, enabled: v });
                commit();
              }}
              label={eq.enabled ? 'On' : 'Bypassed'}
            />
          </div>
          <EqEditor
            eq={eq}
            onPreview={previewEq}
            onCommit={commit}
            onCommitSoon={commitSoon}
            disabled={locked}
            title={name}
          />
        </section>
        <section className="mx-section" aria-label={`${name} dynamics`}>
          <div className="mx-section-head">
            <h4>{isMaster ? 'Glue compressor' : 'Dynamics'}</h4>
          </div>
          <CompressorEditor
            comp={comp}
            glue={isMaster}
            onPreview={previewComp}
            onCommit={commit}
            onCommitSoon={commitSoon}
            disabled={locked}
            title={name}
          />
          {isMaster && (
            <div className="mx-limiter">
              <div className="row between" style={{ marginTop: 12 }}>
                <Toggle
                  on={mixer.master.limiter.enabled}
                  onChange={(v) =>
                    !locked && applyMixer((m) => setStripField(m, MASTER, 'limiter.enabled', v))
                  }
                  label="True-peak limiter"
                />
              </div>
              <div className="mx-knob-line">
                {knob('limiter.ceilingDb', 'Ceiling', -1, {
                  step: 0.1,
                  tone: 'secondary',
                  disabled: !mixer.master.limiter.enabled,
                })}
                {knob('limiter.releaseMs', 'Release', 80, {
                  tone: 'muted',
                  disabled: !mixer.master.limiter.enabled,
                })}
              </div>
            </div>
          )}
        </section>
        <section className="mx-section" aria-label={`${name} character and sends`}>
          <div className="mx-section-head">
            <h4>{isMaster ? 'Stereo & level' : 'Character & sends'}</h4>
          </div>
          {isMaster ? (
            <>
              <div className="mx-knob-line">
                {knob('width', 'Width', 1, { bipolar: true, tone: 'muted' })}
              </div>
              <div className="small dim" style={{ marginTop: 10 }}>
                Master level {fmtDb(mixer.master.volumeDb)} dB — use the master fader. Mastering (loudness
                targets, true-peak ceiling) lives in the Mastering tab.
              </div>
            </>
          ) : (
            <>
              <div className="mx-knob-line">
                {knob('pan', 'Pan', 0, { bipolar: true, format: fmtPan })}
                {knob('width', 'Width', 1, { bipolar: true, tone: 'muted' })}
                {knob('drive', 'Drive', 0, { tone: 'muted' })}
              </div>
              <div className="mx-knob-line">
                {knob('reverbSend', 'Reverb', 0.15, { tone: 'secondary' })}
                {knob('delaySend', 'Delay', 0, { tone: 'secondary' })}
              </div>
              <div style={{ marginTop: 10 }}>
                <Toggle
                  on={!!stripOf(mixer, target).phaseInvert}
                  onChange={(v) => !locked && applyMixer((m) => setStripField(m, target, 'phaseInvert', v))}
                  label="Phase invert (Ø)"
                />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const REVERB_TYPES: { value: ReverbSettings['type']; label: string }[] = [
  { value: 'room', label: 'Room' },
  { value: 'chamber', label: 'Chamber' },
  { value: 'plate', label: 'Plate' },
  { value: 'hall', label: 'Hall' },
];

/** Shared Reverb and Delay return buses. */
export function BusesPanel({ song, mixer }: { song: Song; mixer: MixerState }) {
  const locked = isStripLocked(song, MASTER);
  const rv = mixer.reverb;
  const dl = mixer.delay;
  const setBus = (bus: 'reverb' | 'delay', key: string, v: unknown) =>
    previewMixer((m) => ({ ...m, [bus]: { ...m[bus], [key]: v } }));
  const applyBus = (bus: 'reverb' | 'delay', key: string, v: unknown) =>
    applyMixer((m) => ({ ...m, [bus]: { ...m[bus], [key]: v } }));
  const knob = (
    bus: 'reverb' | 'delay',
    key: string,
    label: string,
    def: number,
    extra: { step?: number; tone?: 'accent' | 'secondary' | 'muted' } = {},
  ) => {
    const meta = FIELD_META[`${bus}.${key}`];
    const value = (mixer[bus] as unknown as Record<string, number>)[key];
    return (
      <Knob
        value={value}
        min={meta.min}
        max={meta.max}
        log={meta.log}
        step={extra.step}
        defaultValue={def}
        tone={extra.tone ?? 'secondary'}
        onPreview={(v) => setBus(bus, key, v)}
        onCommit={() => commitMixer()}
        onKeyCommit={() => commitMixerSoon()}
        label={label}
        ariaLabel={`${bus === 'reverb' ? 'Reverb bus' : 'Delay bus'} ${meta.label.replace(/^(Reverb|Delay) /, '').toLowerCase()}`}
        format={meta.fmt}
        disabled={locked}
        size={32}
      />
    );
  };
  const noteMatch = DELAY_NOTES.find((d) => Math.abs(d.beats - dl.timeBeats) < 0.004);
  return (
    <div className="panel mx-buses">
      <div className="panel-header">
        <Icon name="layers" />
        <h3 className="grow">Effect buses</h3>
        <span className="small dim">Shared returns fed by each strip’s Rev / Dly sends</span>
      </div>
      <div className="panel-body mx-buses-grid">
        <section className="mx-section" aria-label="Reverb bus">
          <div className="row between mx-section-head">
            <h4>Reverb</h4>
            <Select
              size="sm"
              value={rv.type}
              onChange={(v) => !locked && applyBus('reverb', 'type', v)}
              options={REVERB_TYPES}
              aria-label="Reverb type"
              disabled={locked}
              style={{ width: 110 }}
            />
          </div>
          <div className="mx-knob-line">
            {knob('reverb', 'size', 'Size', 0.6)}
            {knob('reverb', 'decaySeconds', 'Decay', 2.2)}
            {knob('reverb', 'damping', 'Damping', 0.45, { tone: 'muted' })}
            {knob('reverb', 'preDelayMs', 'Pre-delay', 20, { step: 1, tone: 'muted' })}
            {knob('reverb', 'returnDb', 'Return', -4, { step: 0.1, tone: 'accent' })}
          </div>
        </section>
        <section className="mx-section" aria-label="Delay bus">
          <div className="row between mx-section-head">
            <h4>Delay</h4>
            <div className="row">
              <Select
                size="sm"
                value={noteMatch ? String(noteMatch.beats) : 'custom'}
                onChange={(v) => !locked && v !== 'custom' && applyBus('delay', 'timeBeats', Number(v))}
                options={[
                  ...DELAY_NOTES.map((d) => ({ value: String(d.beats), label: d.label })),
                  ...(noteMatch ? [] : [{ value: 'custom', label: fmtBeats(dl.timeBeats) }]),
                ]}
                aria-label="Delay time (note value)"
                disabled={locked}
                style={{ width: 120 }}
              />
              <Toggle
                on={dl.pingPong}
                onChange={(v) => !locked && applyBus('delay', 'pingPong', v)}
                label="Ping-pong"
              />
            </div>
          </div>
          <div className="mx-knob-line">
            {knob('delay', 'timeBeats', 'Time', 0.75)}
            {knob('delay', 'feedback', 'Feedback', 0.3)}
            {knob('delay', 'lowCutHz', 'Low cut', 200, { tone: 'muted' })}
            {knob('delay', 'highCutHz', 'High cut', 6000, { tone: 'muted' })}
            {knob('delay', 'returnDb', 'Return', -8, { step: 0.1, tone: 'accent' })}
          </div>
        </section>
      </div>
    </div>
  );
}
