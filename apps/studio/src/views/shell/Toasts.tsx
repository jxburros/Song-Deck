import { useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';

export function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  const dismiss = useStudio((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <Icon
            name={
              t.kind === 'error'
                ? 'alert'
                : t.kind === 'success'
                  ? 'check'
                  : t.kind === 'warning'
                    ? 'alert'
                    : 'info'
            }
          />
          <div className="grow">{t.message}</div>
        </div>
      ))}
    </div>
  );
}
