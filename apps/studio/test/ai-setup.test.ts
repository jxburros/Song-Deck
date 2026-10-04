import { afterEach, expect, it } from 'vitest';
import { configFromPreset } from '@songdeck/ai';
import { useSettings } from '../src/state/settings';

afterEach(() => useSettings.setState(useSettings.getInitialState(), true));

it('allows a connected provider without changing routing preferences, restrictions or budgets', () => {
  const s = useSettings.getState();
  s.upsertProvider(configFromPreset('gemini'));
  s.update({
    routing: {
      ...s.routing,
      mode: 'rules',
      profileId: 'local-only',
      privacyConfirm: 'always',
      neverUpload: ['recorded-vocals'],
      rules: [{ kind: 'max-cost', usd: 0.5 }],
    },
  });
  s.allowProviderRequests('gemini');
  s.allowProviderRequests('gemini');
  expect(useSettings.getState().routing).toMatchObject({
    mode: 'rules',
    profileId: 'local-only',
    trustedProviderIds: ['gemini'],
    privacyConfirm: 'always',
    neverUpload: ['recorded-vocals'],
    rules: [{ kind: 'max-cost', usd: 0.5 }],
  });
  expect(useSettings.getState().budget).toEqual(s.budget);
});

it('clears permission when a provider is removed', () => {
  const s = useSettings.getState();
  s.upsertProvider(configFromPreset('gemini'));
  s.allowProviderRequests('gemini');
  s.removeProvider('gemini');
  s.upsertProvider(configFromPreset('gemini'));
  expect(useSettings.getState().routing.trustedProviderIds).toEqual([]);
});
