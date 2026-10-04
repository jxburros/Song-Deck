import { useStudio } from '../../state/store';
import { Badge, Button, Modal } from '../../ui/kit';
import { formatDuration } from '../../hooks';

export interface DataFlowView {
  providerName: string;
  location: 'cloud' | 'local' | 'internal';
  leavesDevice: boolean;
  items: { kind: string; label: string; included: boolean }[];
}

export interface CostView {
  minUsd: number;
  maxUsd: number;
  known: boolean;
  basis?: string;
}

export interface ConfirmBody {
  message?: string;
  dataFlow?: DataFlowView;
  estimate?: CostView;
  model?: string;
  durationSeconds?: number;
  warning?: string;
  /** Rights reminder for uploaded audio in the request (warn-only). */
  rightsWarning?: string;
  confirmLabel?: string;
}

function money(v: number) {
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/**
 * Data-flow indicator (spec §50) and cost confirmation (spec §60) shown before a request
 * leaves the device or spends money.
 */
export function ConfirmDialog() {
  const confirm = useStudio((s) => s.confirm);
  const resolve = useStudio((s) => s.resolveConfirm);
  if (!confirm) return null;
  const body = (confirm.body ?? {}) as ConfirmBody;
  const flow = body.dataFlow;
  return (
    <Modal
      title={confirm.title}
      icon={
        confirm.kind === 'dataflow' || confirm.kind === 'consent'
          ? 'shield'
          : confirm.kind === 'cost'
            ? 'info'
            : 'alert'
      }
      onClose={() => resolve(false)}
      footer={
        <>
          <Button onClick={() => resolve(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => resolve(true)} autoFocus>
            {body.confirmLabel ?? 'Continue'}
          </Button>
        </>
      }
    >
      {body.message && <p>{body.message}</p>}
      {flow && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row between" style={{ marginBottom: 8 }}>
            <div>
              <div className="field-label">Sending to</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{flow.providerName}</div>
            </div>
            <Badge tone={flow.leavesDevice ? 'warning' : 'success'}>
              {flow.location === 'cloud'
                ? 'Cloud — leaves this device'
                : flow.location === 'local'
                  ? 'Local model — stays on this machine'
                  : 'On-device engine'}
            </Badge>
          </div>
          <div className="field-label" style={{ marginBottom: 6 }}>
            Data
          </div>
          <ul className="dataflow-list">
            {flow.items.map((it) => (
              <li key={it.kind}>
                <span className={it.included ? 'yes' : 'no'}>{it.included ? '✓' : '✗'}</span>
                <span className={it.included ? '' : 'dim'}>{it.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(body.estimate || body.durationSeconds !== undefined || body.model) && (
        <div className="card">
          {body.model && (
            <div className="row between">
              <span className="muted">Model</span>
              <span>{body.model}</span>
            </div>
          )}
          {body.estimate && (
            <div className="row between">
              <span className="muted">Estimated cost</span>
              <span className="mono">
                {body.estimate.known
                  ? `${money(body.estimate.minUsd)}–${money(body.estimate.maxUsd)}`
                  : 'unknown (provider did not publish pricing)'}
              </span>
            </div>
          )}
          {body.durationSeconds !== undefined && (
            <div className="row between">
              <span className="muted">Duration</span>
              <span className="mono">{formatDuration(body.durationSeconds)}</span>
            </div>
          )}
        </div>
      )}
      {body.rightsWarning && (
        <div className="callout warning" style={{ marginTop: 12 }} data-testid="dataflow-rights-warning">
          {body.rightsWarning}
        </div>
      )}
      {body.warning && (
        <div className="callout warning" style={{ marginTop: 12 }}>
          {body.warning}
        </div>
      )}
    </Modal>
  );
}
