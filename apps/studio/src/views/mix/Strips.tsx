import { memo, useState, type KeyboardEvent } from 'react';
import { LockKeys, type ChannelStrip, type MixerState, type Song, type Track } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { LockButton } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { Fader, Knob } from './controls';
import { EqThumb } from './EqEditor';
import { MASTER_METER, MeterBar } from './meters';
import { applyMixer, commitMixer, commitMixerSoon, previewMixer } from './mixDraft';
import { FIELD_META, MASTER, fmtDb, fmtPan, fmtPct, isStripLocked, setStripField } from './mixModel';

/**
 * Channel strips (spec §40): every track — MIDI or audio/stem — exposes volume, pan, mute,
 * solo, EQ, compression, reverb & delay sends, stereo width, drive and phase. Locked strips
 * (`mixer:<trackId>`) are read-only.
 */

export type InspectTab = 'eq' | 'dynamics' | 'character';

const FADER_H = 172;
/** The master strip has one knob row instead of two plus the pan row: its fader takes that height. */
const MASTER_FADER_H = FADER_H + 91;

/** Editable dB value under a fader (accepts "-6", "−6.5", "-inf"). */
function DbInput({ value, onCommitValue, disabled, label }: { value: number; onCommitValue: (db: number) => void; disabled?: boolean; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? fmtDb(value);
  const commit = () => {
    if (draft === null) return;
    const t = draft.trim().replace('−', '-').replace(/db$/i, '').trim();
    setDraft(null);
    if (/^-?inf/i.test(t) || t === '-∞') return onCommitValue(-96);
    const v = parseFloat(t);
    if (Number.isFinite(v)) onCommitValue(Math.max(-96, Math.min(12, Math.round(v * 10) / 10)));
  };
  return (
    <input
      className="mx-db-input mono"
      value={shown}
      disabled={disabled}
      aria-label={`${label} volume (dB)`}
      onFocus={(e) => {
        setDraft(fmtDb(value));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

interface ChannelStripProps {
  track: Track;
  /** The strip's own settings (defaults when the mixer has none yet). */
  strip: ChannelStrip;
  locked: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: (tab: InspectTab) => void;
}

/**
 * One channel strip. Memoized on its own data, so dragging one fader re-renders only that strip
 * (callbacks are stable in meaning: they always target `track.id`).
 */
export const ChannelStripView = memo(
  ChannelStripImpl,
  (a, b) => a.strip === b.strip && a.track === b.track && a.locked === b.locked && a.selected === b.selected,
);

function ChannelStripImpl({ track, strip: ch, locked, selected, onSelect, onOpen }: ChannelStripProps) {
  const id = track.id;
  const name = track.name;
  const set = (path: string, v: unknown) => previewMixer((m) => setStripField(m, id, path, v));
  const toggle = (path: string, v: boolean) => applyMixer((m) => setStripField(m, id, path, v));
  const knob = (path: string, label: string, def: number, extra: { bipolar?: boolean; tone?: 'accent' | 'ai' | 'muted' } = {}) => {
    const meta = FIELD_META[path];
    return (
      <Knob
        value={(ch as unknown as Record<string, number>)[path] ?? def}
        min={meta.min}
        max={meta.max}
        defaultValue={def}
        bipolar={extra.bipolar}
        tone={extra.tone}
        onPreview={(v) => set(path, v)}
        onCommit={() => commitMixer()}
        onKeyCommit={() => commitMixerSoon()}
        label={label}
        ariaLabel={`${name} ${meta.label.toLowerCase()}`}
        format={meta.fmt}
        disabled={locked}
        size={26}
      />
    );
  };
  return (
    <div
      className={`mx-strip ${selected ? 'selected' : ''} ${locked ? 'locked' : ''} ${ch.mute ? 'muted' : ''}`}
      style={{ ['--strip-color' as string]: track.color || '#9aa3b2' }}
      role="group"
      aria-label={`${name} channel strip`}
      onPointerDownCapture={onSelect}
      onFocusCapture={onSelect}
    >
      <div className="mx-strip-head">
        <span className="mx-strip-name" title={name}>
          {name}
        </span>
      </div>
      <div className="mx-strip-kind">
        <span className="ellipsis mx-kind" title={track.kind === 'audio' ? `Audio track (stem / recording / produced audio) · ${track.stemGroup}` : `MIDI track rendered by the guide engine · ${track.stemGroup}`}>
          <Icon name={track.kind === 'audio' ? 'wave' : 'midi'} size={10} />
          {track.stemGroup}
        </span>
        <LockButton
          locked={locked}
          onToggle={() => useStudio.getState().toggleLock(LockKeys.mixer(id), `${locked ? 'Unlocked' : 'Locked'} mixer strip ${name}`)}
          title={locked ? `${name} strip locked — click to unlock` : `Lock ${name} strip (AI and edits leave it untouched)`}
        />
      </div>
      <div className="mx-inserts">
        <button type="button" className={`mx-insert ${ch.eq.enabled ? 'on' : ''}`} aria-pressed={ch.eq.enabled} disabled={locked} onClick={() => toggle('eq.enabled', !ch.eq.enabled)} title="EQ on/off">
          EQ
        </button>
        <button
          type="button"
          className={`mx-insert comp ${ch.compressor.enabled ? 'on' : ''}`}
          aria-pressed={ch.compressor.enabled}
          disabled={locked}
          onClick={() => toggle('compressor.enabled', !ch.compressor.enabled)}
          title="Compressor on/off"
        >
          CMP
        </button>
        <button
          type="button"
          className={`mx-insert phase ${ch.phaseInvert ? 'on' : ''}`}
          aria-pressed={!!ch.phaseInvert}
          aria-label={`${name} phase invert`}
          disabled={locked}
          onClick={() => toggle('phaseInvert', !ch.phaseInvert)}
          title="Phase invert (polarity)"
        >
          Ø
        </button>
      </div>
      <EqThumb eq={ch.eq} label={name} onClick={() => onOpen('eq')} />
      <div className="mx-knob-grid">
        {knob('reverbSend', 'Rev', 0.15, { tone: 'ai' })}
        {knob('delaySend', 'Dly', 0, { tone: 'ai' })}
        {knob('width', 'Width', 1, { bipolar: true, tone: 'muted' })}
        {knob('drive', 'Drive', 0, { tone: 'muted' })}
      </div>
      <div className="mx-pan-row">
        <button
          type="button"
          className={`ms-btn mute ${ch.mute ? 'on' : ''}`}
          aria-pressed={ch.mute}
          aria-label={`Mute ${name}`}
          title="Mute"
          disabled={locked}
          onClick={() => toggle('mute', !ch.mute)}
        >
          M
        </button>
        <Knob
          value={ch.pan}
          min={-1}
          max={1}
          defaultValue={0}
          bipolar
          onPreview={(v) => set('pan', Math.abs(v) < 0.015 ? 0 : v)}
          onCommit={() => commitMixer()}
          onKeyCommit={() => commitMixerSoon()}
          label={fmtPan(ch.pan)}
          ariaLabel={`${name} pan`}
          format={fmtPan}
          disabled={locked}
          size={28}
        />
        <button
          type="button"
          className={`ms-btn solo ${ch.solo ? 'on' : ''}`}
          aria-pressed={ch.solo}
          aria-label={`Solo ${name}`}
          title="Solo (monitoring only — ignored by exports)"
          onClick={() => toggle('solo', !ch.solo)}
          disabled={locked}
        >
          S
        </button>
      </div>
      <div className="mx-fader-row">
        <Fader
          value={ch.volumeDb}
          label={`${name} volume`}
          disabled={locked}
          onPreview={(v) => set('volumeDb', v)}
          onCommit={() => commitMixer()}
          onKeyCommit={() => commitMixerSoon()}
          height={FADER_H}
        />
        <MeterBar id={id} height={FADER_H} label={name} readoutId={`mx-peak-${id}`} />
      </div>
      <div className="mx-strip-foot">
        <DbInput value={ch.volumeDb} label={name} disabled={locked} onCommitValue={(db) => applyMixer((m) => setStripField(m, id, 'volumeDb', db))} />
        <span className="mx-peak mono" id={`mx-peak-${id}`} title="Peak hold (dBFS)">
          −∞
        </span>
      </div>
    </div>
  );
}

export function MasterStripView({ song, mixer, selected, onSelect, onOpen }: { song: Song; mixer: MixerState; selected: boolean; onSelect: () => void; onOpen: (tab: InspectTab) => void }) {
  const m = mixer.master;
  const locked = isStripLocked(song, MASTER);
  const set = (path: string, v: unknown) => previewMixer((mx) => setStripField(mx, MASTER, path, v));
  const toggle = (path: string, v: boolean) => applyMixer((mx) => setStripField(mx, MASTER, path, v));
  return (
    <div
      className={`mx-strip master ${selected ? 'selected' : ''} ${locked ? 'locked' : ''}`}
      role="group"
      aria-label="Master bus strip"
      onPointerDownCapture={onSelect}
      onFocusCapture={onSelect}
    >
      <div className="mx-strip-head">
        <span className="mx-strip-name">Master</span>
      </div>
      <div className="mx-strip-kind">
        <span className="ellipsis">Stereo bus</span>
        <LockButton
          locked={locked}
          onToggle={() => useStudio.getState().toggleLock(LockKeys.mixer(MASTER), `${locked ? 'Unlocked' : 'Locked'} master bus`)}
          title={locked ? 'Master bus locked — click to unlock' : 'Lock master bus'}
        />
      </div>
      <div className="mx-inserts">
        <button type="button" className={`mx-insert ${m.eq.enabled ? 'on' : ''}`} aria-pressed={m.eq.enabled} disabled={locked} onClick={() => toggle('eq.enabled', !m.eq.enabled)} title="Master EQ on/off">
          EQ
        </button>
        <button
          type="button"
          className={`mx-insert comp ${m.compressor.enabled ? 'on' : ''}`}
          aria-pressed={m.compressor.enabled}
          disabled={locked}
          onClick={() => toggle('compressor.enabled', !m.compressor.enabled)}
          title="Glue compressor on/off"
        >
          GLUE
        </button>
        <button
          type="button"
          className={`mx-insert lim ${m.limiter.enabled ? 'on' : ''}`}
          aria-pressed={m.limiter.enabled}
          disabled={locked}
          onClick={() => toggle('limiter.enabled', !m.limiter.enabled)}
          title="Limiter on/off"
        >
          LIM
        </button>
      </div>
      <EqThumb eq={m.eq} label="Master" width={88} onClick={() => onOpen('eq')} />
      <div className="mx-knob-grid">
        <Knob
          value={m.width}
          min={0}
          max={2}
          defaultValue={1}
          bipolar
          tone="muted"
          onPreview={(v) => set('width', v)}
          onCommit={() => commitMixer()}
          onKeyCommit={() => commitMixerSoon()}
          label="Width"
          ariaLabel="Master stereo width"
          format={fmtPct}
          disabled={locked}
          size={26}
        />
        <Knob
          value={m.limiter.ceilingDb}
          min={-12}
          max={0}
          step={0.1}
          defaultValue={-1}
          tone="ai"
          onPreview={(v) => set('limiter.ceilingDb', v)}
          onCommit={() => commitMixer()}
          onKeyCommit={() => commitMixerSoon()}
          label="Ceiling"
          ariaLabel="Master limiter ceiling"
          format={FIELD_META['limiter.ceilingDb'].fmt}
          disabled={locked || !m.limiter.enabled}
          size={26}
        />
      </div>
      <div className="mx-fader-row">
        <Fader
          value={m.volumeDb}
          label="Master volume"
          disabled={locked}
          onPreview={(v) => set('volumeDb', v)}
          onCommit={() => commitMixer()}
          onKeyCommit={() => commitMixerSoon()}
          height={MASTER_FADER_H}
        />
        <MeterBar id={MASTER_METER} height={MASTER_FADER_H} label="Master" readoutId="mx-peak-master" />
      </div>
      <div className="mx-strip-foot">
        <DbInput value={m.volumeDb} label="Master" disabled={locked} onCommitValue={(db) => applyMixer((mx) => setStripField(mx, MASTER, 'volumeDb', db))} />
        <span className="mx-peak mono" id="mx-peak-master" title="Peak hold (dBFS)">
          −∞
        </span>
      </div>
    </div>
  );
}
