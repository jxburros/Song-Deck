import type { TaskRole } from '@songdeck/ai';
import { Select, Button } from '../../ui/kit';
import { useRoleOptions } from '../../engine/ai';
import { openSettings } from '../settings/nav';

/**
 * Choose who performs a task: "Auto" (routing rules decide by capability), the on-device
 * engine, or any configured provider whose capabilities fit the role (spec §49, §59).
 */
export function ProviderPicker({
  role,
  value,
  onChange,
  size,
}: {
  role: TaskRole;
  value: string;
  onChange: (v: string) => void;
  size?: 'sm';
}) {
  const options = useRoleOptions(role);
  return (
    <div className="row">
      <Select
        size={size}
        value={options.some((o) => o.value === value) ? value : 'auto'}
        onChange={onChange}
        options={options.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled }))}
        aria-label="Provider"
      />
      {!options.some((o) => o.location && o.location !== 'internal') && (
        <Button
          size="sm"
          icon="plug"
          onClick={() => openSettings('providers', 'connect')}
          aria-label={`Connect a service for ${role}`}
        >
          Connect
        </Button>
      )}
    </div>
  );
}
