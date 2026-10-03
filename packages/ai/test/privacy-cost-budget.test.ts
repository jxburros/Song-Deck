import { describe, expect, it } from 'vitest';
import {
  audioCostUsd,
  BudgetManager,
  describeDataFlow,
  estimateCost,
  formatCostRange,
  formatDataFlow,
  getPreset,
  llmCostUsd,
  MemoryBudgetPersistence,
  modelPricing,
  needsPrivacyConfirmation,
} from '../src';

describe('privacy / data-flow indicator (spec §50)', () => {
  it('describes what is sent and where', () => {
    const flow = describeDataFlow(
      { dataKinds: ['song-description', 'chord-progression', 'midi'], role: 'production', show: ['song-description', 'chord-progression', 'midi', 'recorded-vocals', 'reference-audio'] },
      { providerId: 'gemini', providerName: 'Gemini', location: 'cloud' },
    );
    expect(flow.leavesDevice).toBe(true);
    expect(flow.items.map((i) => [i.label, i.included])).toEqual([
      ['Song description', true],
      ['Chord progression', true],
      ['MIDI', true],
      ['Recorded vocals', false],
      ['Reference audio', false],
    ]);
    expect(formatDataFlow(flow)).toBe(
      ['Generation Request', '', 'Sending to: Gemini [cloud — data leaves this device]', '', 'Data:', '✓ Song description', '✓ Chord progression', '✓ MIDI', '✗ Recorded vocals', '✗ Reference audio'].join('\n'),
    );
    const all = describeDataFlow({ dataKinds: ['lyrics'] }, { providerName: 'Ollama', location: 'local' });
    expect(all.items).toHaveLength(10);
    expect(all.items[0]).toEqual({ kind: 'lyrics', label: 'Lyrics', included: true });
    expect(all.leavesDevice).toBe(false);
  });

  it('decides when to ask for confirmation', () => {
    const cloudMidi = describeDataFlow({ dataKinds: ['midi'] }, { providerName: 'X', location: 'cloud' });
    const cloudAudio = describeDataFlow({ dataKinds: ['recorded-vocals'] }, { providerName: 'X', location: 'cloud' });
    const local = describeDataFlow({ dataKinds: ['recorded-vocals'] }, { providerName: 'X', location: 'local' });
    expect([needsPrivacyConfirmation('always', local), needsPrivacyConfirmation('never', cloudAudio)]).toEqual([true, false]);
    expect([needsPrivacyConfirmation('cloud', cloudMidi), needsPrivacyConfirmation('cloud', local)]).toEqual([true, false]);
    expect([needsPrivacyConfirmation('audio', cloudMidi), needsPrivacyConfirmation('audio', cloudAudio)]).toEqual([false, true]);
  });
});

describe('cost estimates (spec §60)', () => {
  const anthropic = getPreset('anthropic')!;
  it('estimates LLM ranges from characters/4 and per-role output estimates', () => {
    const e = estimateCost({ location: 'cloud', pricing: anthropic.pricing, defaultModel: 'claude-opus-5-5' }, { kind: 'llm', role: 'midi-editing', inputChars: 40_000 });
    // 10,000 input tokens; 400–6,000 output tokens @ $4/$20.
    expect(e.known).toBe(true);
    expect(e.minUsd).toBeCloseTo((10_000 * 4 + 400 * 20) / 1e6, 10);
    expect(e.maxUsd).toBeCloseTo((11_000 * 4 + 6_000 * 20) / 1e6, 10);
    expect(e.basis).toContain('~10,000 input + 400–6,000 output tokens @ $4/$20 per MTok (claude-opus-5-5)');
    expect(formatCostRange(e)).toBe('$0.05–$0.16');
    // Model-specific pricing by longest prefix (dated snapshot ids).
    expect(modelPricing(anthropic.pricing, 'claude-sonnet-5-5-20261001')).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(modelPricing(anthropic.pricing, 'claude-opus-5-20260101')).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(llmCostUsd(anthropic.pricing, 'claude-fable-5-1', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(15, 10);
  });

  it('estimates audio by duration / per-generation / per-clip pricing', () => {
    const per = estimateCost({ location: 'cloud', pricing: { perMinuteUsd: 0.3 } }, { kind: 'audio', durationSeconds: 222, generations: 3 });
    expect(per.minUsd).toBeCloseTo(0.3 * 3.7 * 3, 10);
    expect(per.maxUsd).toBeCloseTo(0.3 * 3.7 * 3 * 1.15, 10);
    expect(formatCostRange(per)).toBe('$3.33–$3.83');
    const flat = estimateCost({ location: 'cloud', pricing: getPreset('stability-audio')!.pricing }, { kind: 'audio', durationSeconds: 60, generations: 2 });
    expect([flat.minUsd, flat.maxUsd]).toEqual([0.4, 0.4]);
    const lyria = estimateCost({ location: 'cloud', pricing: getPreset('google-lyria')!.pricing }, { kind: 'audio', durationSeconds: 95 });
    expect(lyria.minUsd).toBeCloseTo(0.24, 10); // 4 × 30 s clips
    expect(audioCostUsd(getPreset('google-lyria')!.pricing, 'lyria-002', 30, 2)).toBeCloseTo(0.12, 10);
  });

  it('local is free and unknown pricing is reported as unknown', () => {
    const local = estimateCost({ location: 'local' }, { kind: 'llm', inputChars: 1e6 });
    expect(local).toMatchObject({ minUsd: 0, maxUsd: 0, known: true });
    expect(formatCostRange(local)).toBe('free (runs locally)');
    const unknown = estimateCost({ location: 'cloud', pricing: getPreset('elevenlabs-music')!.pricing }, { kind: 'audio', durationSeconds: 120 });
    expect(unknown.known).toBe(false);
    expect(formatCostRange(unknown)).toBe('unknown cost');
  });
});

describe('BudgetManager', () => {
  const day = (h: number) => Date.parse(`2026-10-03T${String(h).padStart(2, '0')}:00:00Z`);
  const est = (usd: number) => ({ minUsd: usd, maxUsd: usd, basis: '', known: true, currency: 'USD' as const });

  it('enforces per-generation, daily and monthly limits with warnings', async () => {
    let now = day(9);
    const persistence = new MemoryBudgetPersistence([{ at: '2026-09-15T10:00:00Z', providerId: 'x', costUsd: 40 }]);
    const b = new BudgetManager({ perGenerationUsd: 2, dailyUsd: 5, monthlyUsd: 50, warningThreshold: 0.8 }, persistence, { now: () => now, timeZone: 'utc' });
    await b.ready();
    expect(b.check(est(3))).toMatchObject({ allowed: false, reasons: ['estimated $3.00 exceeds the per-generation limit $2.00'] });
    expect(b.check(est(1))).toMatchObject({ allowed: true });
    b.record({ providerId: 'eleven', costUsd: 1.5, role: 'production' });
    b.record({ providerId: 'eleven', costUsd: 1.5 });
    b.record({ providerId: 'gemini', costUsd: 1 });
    expect(b.totals()).toMatchObject({ todayUsd: 4, monthUsd: 4, totalUsd: 44 });
    expect(b.totals().byProvider.eleven).toEqual({ todayUsd: 3, monthUsd: 3, totalUsd: 3 });
    const warn = b.check(est(0.5));
    expect(warn.allowed).toBe(true);
    expect(warn.warning).toBe('daily spend would reach $4.50 of $5.00 (90%)');
    expect(b.check(est(1.5))).toMatchObject({ allowed: false, reasons: ['daily limit $5.00 would be exceeded (spent $4.00 today)'] });
    // A new day resets the daily total; September spend is not in October.
    now = Date.parse('2026-10-04T09:00:00Z');
    expect(b.check(est(1.5)).allowed).toBe(true);
    expect(persistence.entries).toHaveLength(4);
    // Per-provider budgets.
    expect(b.check(est(1), { providerId: 'eleven', providerBudget: { monthlyUsd: 3.5 } })).toMatchObject({ allowed: false, reasons: ['eleven: monthly limit $3.50 would be exceeded (spent $3.00 this month)'] });
    // Unknown cost is allowed with a warning.
    expect(b.check({ minUsd: 0, maxUsd: 0, basis: '', known: false, currency: 'USD' })).toMatchObject({ allowed: true, warning: expect.stringContaining('unknown') });
    // Monthly warning.
    b.setLimits({ monthlyUsd: 5, warningThreshold: 0.8 });
    expect(b.check(est(0.5)).warning).toMatch(/monthly spend would reach \$4\.50 of \$5\.00/);
  });
});
