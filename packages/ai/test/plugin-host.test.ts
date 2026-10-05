import { describe, expect, it } from 'vitest';
import { CapabilityRouter, configFromPreset, createProvider, Orchestrator, ProviderRegistry } from '../src';
import { bodyJson, bytesResponse, depsWith, FAKE_WAV, jsonResponse, mockFetch } from './helpers';

const PLUGINS = [
  {
    id: 'vst3:/p/Synth.vst3',
    name: 'Synth',
    vendor: 'Acme',
    format: 'vst3',
    category: 'instrument',
    loadable: true,
  },
  { id: 'clap:/p/Pad.clap', name: 'Pad', format: 'clap', category: 'unknown' },
  { id: 'vst3:/p/Verb.vst3', name: 'Verb', format: 'vst3', category: 'effect' },
];

function host() {
  return mockFetch((call) => {
    if (call.url.endsWith('/info'))
      return jsonResponse({
        name: 'Song Deck plugin host',
        version: '1.0',
        capabilities: ['INSTRUMENT_PLUGIN_HOST'],
        editor: true,
        formats: [
          { format: 'vst3', available: true, backend: 'pedalboard' },
          { format: 'lv2', available: false, note: 'configure --lv2-command' },
        ],
      });
    if (call.url.endsWith('/plugins')) return jsonResponse({ plugins: PLUGINS });
    if (call.url.endsWith('/plugins/describe'))
      return jsonResponse({
        ...PLUGINS[0],
        parameters: [{ id: 'cutoff', name: 'Cutoff', value: 0.5, min: 0, max: 1 }],
        presets: ['Init'],
        has_editor: true,
        latency_samples: 64,
      });
    if (call.url.endsWith('/render'))
      return bytesResponse(FAKE_WAV, 'audio/wav', { 'x-plugin-latency': '64' });
    if (call.url.endsWith('/state') || call.url.endsWith('/editor'))
      return jsonResponse({
        plugin_id: PLUGINS[0].id,
        state_base64: 'AAEC',
        parameters: { cutoff: 0.7 },
        preset: 'Init',
      });
    return jsonResponse({ error: 'nope' }, 404);
  });
}

describe('instrument plugin host adapter', () => {
  it('status, plugin list (rescan with paths), description, state and editor', async () => {
    const m = host();
    const inst = createProvider(configFromPreset('plugin-host-local'), depsWith(m.fetch));
    const h = inst.instrumentHost!;
    const status = await h.status();
    expect(status.editor).toBe(true);
    expect(status.formats).toEqual([
      { format: 'vst3', available: true, backend: 'pedalboard' },
      { format: 'lv2', available: false, note: 'configure --lv2-command' },
    ]);
    expect((await h.listPlugins()).map((p) => p.name)).toEqual(['Synth', 'Pad', 'Verb']);
    expect(m.calls.at(-1)!.method).toBe('GET');
    await h.listPlugins({ paths: ['/extra'] });
    expect(m.calls.at(-1)!.method).toBe('POST');
    expect(bodyJson(m.calls.at(-1)!)).toEqual({ paths: ['/extra'] });
    const d = await h.describePlugin(PLUGINS[0].id);
    expect(d).toMatchObject({
      name: 'Synth',
      vendor: 'Acme',
      hasEditor: true,
      latencySamples: 64,
      presets: ['Init'],
    });
    expect(d.parameters[0]).toMatchObject({ id: 'cutoff', value: 0.5 });
    const st = await h.captureState!(PLUGINS[0].id, { parameters: { cutoff: 0.2 } });
    expect(bodyJson(m.calls.at(-1)!)).toEqual({ plugin_id: PLUGINS[0].id, parameters: { cutoff: 0.2 } });
    expect(st).toEqual({ stateBase64: 'AAEC', parameters: { cutoff: 0.7 }, preset: 'Init' });
    const ed = await h.openEditor!(PLUGINS[0].id, st);
    expect(m.calls.at(-1)!.url).toBe('http://127.0.0.1:8817/editor');
    expect(ed.stateBase64).toBe('AAEC');
  });

  it('renders MIDI events through the orchestrator (plugins are the host’s models; effects are left out)', async () => {
    const m = host();
    const registry = new ProviderRegistry({ deps: depsWith(m.fetch) });
    registry.configure([configFromPreset('plugin-host-local')]);
    const models = await registry.discoverModels('plugin-host-local');
    expect(models.map((x) => x.id)).toEqual([PLUGINS[0].id, PLUGINS[1].id]);
    const orch = new Orchestrator({ registry, router: new CapabilityRouter(registry) });
    const run = await orch.renderInstrument(
      {
        pluginId: PLUGINS[0].id,
        state: { stateBase64: 'AAEC', parameters: { cutoff: 0.3 }, preset: 'Init' },
        sampleRate: 48000,
        durationSeconds: 2,
        events: [
          { time: 0, data: [0x90, 60, 100] },
          { time: 1, data: [0x80, 60, 64] },
          { time: -1, data: [0x90, 1, 1] },
        ],
      },
      { providerId: 'plugin-host-local', modelId: PLUGINS[0].id },
    );
    const body = bodyJson(m.calls.at(-1)!);
    expect(body).toEqual({
      plugin_id: PLUGINS[0].id,
      state_base64: 'AAEC',
      parameters: { cutoff: 0.3 },
      preset: 'Init',
      sample_rate: 48000,
      channels: 2,
      duration_seconds: 2,
      events: [
        { time_seconds: 0, data: [0x90, 60, 100] },
        { time_seconds: 1, data: [0x80, 60, 64] },
      ],
    });
    expect(run.result.latencySamples).toBe(64);
    expect([...run.result.audio.data]).toEqual([...FAKE_WAV]);
    expect(run.provenance.location).toBe('local');
  });
});
