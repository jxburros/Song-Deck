import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addAttestation, createEmptySong, createProject, type AudioAttestation, type Project } from '@songdeck/core';

// localStorage stand-in (the studio persists the attestation memory there).
const store = new Map<string, string>();
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});
beforeEach(() => store.clear());

const rights = await import('../src/engine/rights');

function wavWithIcop(): Uint8Array {
  const text = new TextEncoder().encode('Copyright 2020 Example Records\0');
  const info = new Uint8Array([...new TextEncoder().encode('INFOICOP'), text.length, 0, 0, 0, ...text, ...(text.length & 1 ? [0] : [])]);
  const list = new Uint8Array([...new TextEncoder().encode('LIST'), info.length & 255, (info.length >> 8) & 255, 0, 0, ...info]);
  const fmt = [...new TextEncoder().encode('fmt '), 16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0];
  const data = [...new TextEncoder().encode('data'), 4, 0, 0, 0, 0, 0, 0, 0];
  const body = [...new TextEncoder().encode('WAVE'), ...fmt, ...data, ...list];
  return new Uint8Array([...new TextEncoder().encode('RIFF'), body.length & 255, (body.length >> 8) & 255, 0, 0, ...body]);
}

describe('content hashing', () => {
  it('hashes with WebCrypto and the pure-JS fallback identically', async () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 70_000]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 31 + 7) & 255);
      const expected = createHash('sha256').update(bytes).digest('hex');
      expect(rights.sha256Fallback(bytes)).toBe(expected);
      expect(await rights.sha256Hex(bytes)).toBe(expected);
    }
  });
});

describe('attestation memory', () => {
  it('remembers answers per content hash and pre-fills re-uploads', async () => {
    const file = { name: 'song.wav', bytes: wavWithIcop() };
    const first = await rights.checkFileOffline(file);
    expect(first.remembered).toBeUndefined();
    expect(first.metadata.level).toBe('likely-commercial');
    expect(first.metadata.summary).toContain('Copyright 2020 Example Records');
    const [att] = rights.buildAttestations([first], { basis: 'licensed', attestedBy: 'Jo', licence: 'Sync #42' }, 'rebuild');
    expect(att).toMatchObject({ fileName: 'song.wav', context: 'rebuild', basis: 'licensed', attestedBy: 'Jo', licence: 'Sync #42', flagged: true, checks: { metadata: true, online: 'off' } });
    expect(att.contentHash).toBe(createHash('sha256').update(file.bytes).digest('hex'));
    expect(att.signals[0]).toMatchObject({ kind: 'copyright', source: 'RIFF ICOP' });

    // Same bytes under another name → remembered; different bytes → not.
    const again = await rights.checkFileOffline({ name: 'renamed.wav', bytes: file.bytes.slice() });
    expect(again.remembered).toMatchObject({ basis: 'licensed', attestedBy: 'Jo', licence: 'Sync #42', fileName: 'song.wav' });
    const other = file.bytes.slice();
    other[other.length - 1] ^= 1;
    expect((await rights.checkFileOffline({ name: 'x.wav', bytes: other })).remembered).toBeUndefined();
    expect(rights.loadAttestationMemory().lastAttestedBy).toBe('Jo');

    rights.forgetAttestations();
    expect(rights.recallAttestation(att.contentHash)).toBeUndefined();
    expect(rights.loadAttestationMemory().lastAttestedBy).toBe('Jo');
  });

  it('keeps the memory bounded and survives corrupt storage', () => {
    for (let i = 0; i < 510; i++) rights.rememberAttestation(`h${i}`, { basis: 'own-work', attestedBy: 'A', fileName: `${i}.wav`, attestedAt: new Date(1_700_000_000_000 + i * 1000).toISOString() });
    const mem = rights.loadAttestationMemory();
    expect(Object.keys(mem.byHash)).toHaveLength(500);
    expect(mem.byHash.h0).toBeUndefined();
    expect(mem.byHash.h509).toBeDefined();
    store.set('songdeck:attestation-memory', '{not json');
    expect(rights.loadAttestationMemory()).toEqual({ byHash: {} });
    store.set('songdeck:attestation-memory', '"str"');
    expect(rights.loadAttestationMemory()).toEqual({ byHash: {} });
  });

  it('queues attestation requests and resolves them in order (cancel → null)', async () => {
    const a = rights.requestAttestation([{ name: 'a.wav', bytes: new Uint8Array(4) }], { context: 'mix-stem', purpose: 'A' });
    const b = rights.requestAttestation([{ name: 'b.wav', bytes: new Uint8Array(4) }], { context: 'mix-stem', purpose: 'B' });
    expect(rights.useAttestationDialog.getState().request?.purpose).toBe('A');
    rights.settleAttestation(null);
    expect(await a).toBeNull();
    expect(rights.useAttestationDialog.getState().request?.purpose).toBe('B');
    rights.settleAttestation([]);
    expect(await b).toEqual([]);
    expect(rights.useAttestationDialog.getState().request).toBeNull();
    expect(await rights.requestAttestation([], { context: 'x', purpose: 'none' })).toEqual([]);
  });
});

describe('online identification', () => {
  it('sends nothing in offline mode', async () => {
    const { useSettings } = await import('../src/state/settings');
    const prev = useSettings.getState().routing;
    useSettings.setState({ routing: { ...prev, offline: true } });
    let fetched = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('should not fetch');
    }) as typeof fetch;
    try {
      const r = await rights.checkFileOnline({ name: 'a.wav', bytes: new Uint8Array(8) });
      expect(r).toEqual({ online: 'error', onlineError: 'Offline mode is on, so nothing was sent.' });
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = orig;
      useSettings.setState({ routing: prev });
    }
  });
});

describe('data-flow rights reminder', () => {
  function project(): Project {
    let p = createProject('P', createEmptySong());
    const asset = (id: string, kind: 'reference' | 'stem' | 'guide-render') => ({ id, name: `${id}.wav`, kind, path: `audio/${id}.wav`, mimeType: 'audio/wav', sampleRate: 44100, channels: 2, durationSeconds: 1, bytes: 1, createdAt: '' });
    p = { ...p, meta: { ...p.meta, assets: [asset('ref', 'reference'), asset('stem', 'stem'), asset('guide', 'guide-render')] } };
    const att = (over: Partial<AudioAttestation>): AudioAttestation => ({ id: over.assetId!, contentHash: over.assetId!, fileName: `${over.assetId}.wav`, context: 'x', basis: 'own-work', attestedBy: 'Jo', attestedAt: new Date().toISOString(), signals: [], flagged: false, checks: { metadata: true }, ...over });
    p = addAttestation(p, att({ assetId: 'ref', basis: 'personal-study' }));
    p = addAttestation(p, att({ assetId: 'stem', flagged: true, match: { service: 'AcoustID', score: 0.9, title: 'Known' } }));
    return p;
  }
  const flow = (kinds: string[], leavesDevice = true) => ({ leavesDevice, items: ['reference-audio', 'stems', 'midi'].map((k) => ({ kind: k as never, label: k, included: kinds.includes(k) })) });

  it('warns when flagged or personal-study audio is about to leave the device', () => {
    const p = project();
    expect(rights.dataFlowRightsWarning(p, flow(['reference-audio']))).toContain('“ref.wav” (personal study only)');
    expect(rights.dataFlowRightsWarning(p, flow(['stems']))).toContain('“stem.wav” (matched a known recording)');
    expect(rights.dataFlowRightsWarning(p, flow(['midi']))).toBeUndefined();
    expect(rights.dataFlowRightsWarning(p, flow(['reference-audio'], false))).toBeUndefined();
    expect(rights.dataFlowRightsWarning(null, flow(['stems']))).toBeUndefined();
  });

  it('also covers projectless Rebuild/Transcribe uploads attested this session', () => {
    const pending = rights.requestAttestation([{ name: 'r.wav', bytes: new Uint8Array(4) }], { context: 'rebuild', purpose: 'R' });
    rights.settleAttestation([{ id: 'att', contentHash: 'h-r', fileName: 'r.wav', context: 'rebuild', basis: 'personal-study', attestedBy: 'Jo', attestedAt: new Date().toISOString(), signals: [], flagged: false, checks: { metadata: true } }]);
    void pending;
    expect(rights.dataFlowRightsWarning(null, flow(['reference-audio']))).toContain('“r.wav” (personal study only)');
    expect(rights.dataFlowRightsWarning(null, flow(['stems']))).toBeUndefined();
  });
});
