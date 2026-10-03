import { create } from 'zustand';
import {
  addAttestation,
  attestationNeedsCare,
  attestationsNeedingCare,
  randomId,
  type AttestationBasis,
  type AudioAttestation,
  type ContentMatch,
  type ContentSignal,
  type Project,
} from '@songdeck/core';
import { classifyRightsSignals, readAudioMetadata, type AudioData, type RightsClassification } from '@songdeck/audio';
import { ACOUSTID_CREDENTIAL_REF, DirectTransport, createAcoustIdProvider, type ContentIdResult, type DataFlowDescriptor } from '@songdeck/ai';
import { useStudio } from '../state/store';
import { serverBase, useSettings } from '../state/settings';
import { localGet, localSet } from '../state/persistence';
import { decodeAudioBytes } from '../state/assets';
import { useRuntime } from './runtime';
import { jobs } from './jobs';
import { browserCredentials } from './ai';

/**
 * Upload rights checks (docs/RIGHTS.md). Warn, never block:
 *
 *  1. Every uploaded audio file (not microphone takes or tapped rhythms) goes through the shared
 *     AttestationDialog before it is used: the user states the basis on which they may use it.
 *  2. Offline signal: embedded tags (ISRC, copyright, label, store purchase markers) are read and
 *     shown as a warning in the dialog.
 *  3. Optional, opt-in online identification (AcoustID): only a Chromaprint fingerprint and the
 *     duration leave the device. Off by default; AcoustID is free for non-commercial use only.
 *
 * Attestations are remembered per file content hash (SHA-256) in this browser, so re-uploading
 * the same file pre-fills the dialog and is one click. In a local, open-source app nothing can
 * truly enforce any of this — it is a record and a reminder.
 */

// ---------------------------------------------------------------------------------------------
// SHA-256 (WebCrypto, with a small fallback for insecure contexts such as plain-HTTP LAN access)
// ---------------------------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Pure-JS SHA-256 (used only when crypto.subtle is unavailable). */
export function sha256Fallback(data: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000), false);
  view.setUint32(total - 4, (len * 8) >>> 0, false);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/** SHA-256 of the file bytes (lower-case hex). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* fall back */
    }
  }
  return sha256Fallback(bytes);
}

// ---------------------------------------------------------------------------------------------
// Per-browser memory of attestations (keyed by content hash) and content-check settings
// ---------------------------------------------------------------------------------------------

export interface RememberedAttestation {
  basis: AttestationBasis;
  attestedBy: string;
  rightsHolder?: string;
  licence?: string;
  notes?: string;
  fileName: string;
  attestedAt: string;
}

interface AttestationMemory {
  /** Content hash → last answer. */
  byHash: Record<string, RememberedAttestation>;
  /** Most recent "attested by" (pre-fills new attestations). */
  lastAttestedBy?: string;
}

const MEMORY_KEY = 'attestation-memory';
const MEMORY_LIMIT = 500;

export function loadAttestationMemory(): AttestationMemory {
  const m = localGet<AttestationMemory>(MEMORY_KEY, { byHash: {} });
  return m && typeof m === 'object' && m.byHash && typeof m.byHash === 'object' ? m : { byHash: {} };
}

/** Remember an answer for a file hash (bounded; oldest entries are dropped first). */
export function rememberAttestation(hash: string, answer: RememberedAttestation): void {
  const mem = loadAttestationMemory();
  const byHash = { ...mem.byHash, [hash]: answer };
  const keys = Object.keys(byHash);
  if (keys.length > MEMORY_LIMIT) {
    keys
      .sort((a, b) => byHash[a].attestedAt.localeCompare(byHash[b].attestedAt))
      .slice(0, keys.length - MEMORY_LIMIT)
      .forEach((k) => delete byHash[k]);
  }
  localSet(MEMORY_KEY, { byHash, lastAttestedBy: answer.attestedBy || mem.lastAttestedBy });
}

export function recallAttestation(hash: string): RememberedAttestation | undefined {
  return loadAttestationMemory().byHash[hash];
}

export function forgetAttestations(): void {
  localSet(MEMORY_KEY, { byHash: {}, lastAttestedBy: loadAttestationMemory().lastAttestedBy });
}

export interface ContentCheckSettings {
  /** Opt-in online identification (AcoustID). Off by default. */
  online: boolean;
}

const SETTINGS_KEY = 'content-check';

export const useContentCheck = create<ContentCheckSettings & { update(patch: Partial<ContentCheckSettings>): void }>((set, get) => ({
  online: false,
  ...localGet<Partial<ContentCheckSettings>>(SETTINGS_KEY, {}),
  update(patch) {
    set(patch);
    const { online } = get();
    localSet(SETTINGS_KEY, { online });
  },
}));

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

export interface UploadFile {
  name: string;
  bytes: Uint8Array;
  /** Decoded audio when the caller already has it (used for the optional online check). */
  audio?: AudioData;
}

export type OnlineState = 'off' | 'pending' | 'matched' | 'no-match' | 'error';

export interface CheckedFile {
  name: string;
  size: number;
  hash: string;
  metadata: RightsClassification;
  online: OnlineState;
  onlineError?: string;
  match?: ContentMatch;
  remembered?: RememberedAttestation;
}

export function signalsOf(c: Pick<CheckedFile, 'metadata' | 'match'>): ContentSignal[] {
  const out: ContentSignal[] = c.metadata.signals.map((s) => ({ kind: s.kind, label: s.label, value: s.value, source: s.source }));
  if (c.match) {
    const who = c.match.artists?.length ? ` — ${c.match.artists.join(', ')}` : '';
    out.push({ kind: 'match', label: `${c.match.service} match`, value: `${c.match.title ?? 'unknown title'}${who} (${Math.round(c.match.score * 100)}%)`, source: c.match.service });
  }
  return out;
}

export function isFlagged(c: Pick<CheckedFile, 'metadata' | 'match'>): boolean {
  return c.metadata.level === 'likely-commercial' || !!c.match;
}

/** Hash + embedded-metadata check (offline, synchronous apart from hashing). */
export async function checkFileOffline(file: UploadFile): Promise<CheckedFile> {
  const hash = await sha256Hex(file.bytes);
  const metadata = classifyRightsSignals(readAudioMetadata(file.bytes));
  return { name: file.name, size: file.bytes.length, hash, metadata, online: 'off', remembered: recallAttestation(hash) };
}

function lookupViaServer(): boolean {
  return useRuntime.getState().server.status === 'online' && useSettings.getState().useServerProxy;
}

/** Look a fingerprint up at AcoustID: through the local server's vault key, or directly with a session key. */
let lastLookupAt = 0;
/** AcoustID allows 3 requests per second: keep lookups at least 350 ms apart. */
async function throttleLookup(): Promise<void> {
  const wait = lastLookupAt + 350 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLookupAt = Date.now();
}

export async function identifyFingerprint(fingerprint: string, durationSeconds: number, signal?: AbortSignal): Promise<ContentIdResult> {
  await throttleLookup();
  if (lookupViaServer()) {
    const res = await fetch(`${serverBase()}/api/content-check/acoustid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint, duration: durationSeconds }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as ContentIdResult & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `Content check failed (HTTP ${res.status})`);
    return body;
  }
  return createAcoustIdProvider({ transport: new DirectTransport(browserCredentials) }).identify({ fingerprint, durationSeconds, signal });
}

/** Optional online identification of one file (fingerprint computed on this device). */
export async function checkFileOnline(file: UploadFile, signal?: AbortSignal): Promise<Pick<CheckedFile, 'online' | 'onlineError' | 'match'>> {
  // Offline mode (spec §51): nothing leaves the device, not even a fingerprint.
  if (useSettings.getState().routing.offline) return { online: 'error', onlineError: 'Offline mode is on, so nothing was sent.' };
  try {
    const audio = file.audio ?? (await decodeAudioBytes(file.bytes));
    const fp = await jobs.call<{ fingerprint: string; durationSeconds: number }>('fingerprint', { audio }, { signal });
    if (fp.durationSeconds < 1) return { online: 'error', onlineError: 'Too short to identify.' };
    const r = await identifyFingerprint(fp.fingerprint, fp.durationSeconds, signal);
    const best = r.matches[0];
    if (!best) return { online: 'no-match' };
    const match: ContentMatch = { service: best.service, score: best.score };
    if (best.recordingId) match.recordingId = best.recordingId;
    if (best.title) match.title = best.title;
    if (best.artists) match.artists = best.artists;
    if (best.releaseTitle) match.releaseTitle = best.releaseTitle;
    return { online: 'matched', match };
  } catch (err) {
    return { online: 'error', onlineError: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------------------------
// The dialog request (rendered by views/shared/AttestationDialog.tsx)
// ---------------------------------------------------------------------------------------------

export interface AttestationAnswer {
  basis: AttestationBasis;
  attestedBy: string;
  rightsHolder?: string;
  licence?: string;
  notes?: string;
}

/** A completed attestation not yet stored in a project (projectless flows keep it in their session). */
export type PendingAttestation = Omit<AudioAttestation, 'assetId' | 'provenanceId'>;

export interface AttestationRequest {
  id: string;
  files: UploadFile[];
  /** Where the files enter (stored on the attestation). */
  context: string;
  /** Short description of the use, e.g. "Rebuild a recording". */
  purpose: string;
  resolve(result: PendingAttestation[] | null): void;
}

interface AttestationDialogState {
  request: AttestationRequest | null;
  queue: AttestationRequest[];
}

export const useAttestationDialog = create<AttestationDialogState>(() => ({ request: null, queue: [] }));

/**
 * Ask the user to attest their right to use uploaded audio. Resolves with one attestation per
 * file, or null when the user cancels (the upload must then be abandoned).
 */
export function requestAttestation(files: UploadFile[], opts: { context: string; purpose: string }): Promise<PendingAttestation[] | null> {
  if (!files.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    const req: AttestationRequest = { id: randomId('attreq'), files, context: opts.context, purpose: opts.purpose, resolve };
    const s = useAttestationDialog.getState();
    if (s.request) useAttestationDialog.setState({ queue: [...s.queue, req] });
    else useAttestationDialog.setState({ request: req });
  });
}

/** Called by the dialog: finish the current request and show the next queued one. */
export function settleAttestation(result: PendingAttestation[] | null): void {
  const s = useAttestationDialog.getState();
  const cur = s.request;
  const [next, ...rest] = s.queue;
  useAttestationDialog.setState({ request: next ?? null, queue: rest });
  if (result) sessionUploads = [...sessionUploads, ...result].slice(-20);
  cur?.resolve(result);
}

/**
 * Uploads attested in this session — Rebuild and Transcribe use a file before any project exists,
 * so the data-flow reminder also looks here.
 */
let sessionUploads: PendingAttestation[] = [];
const PROJECTLESS_CONTEXTS = new Set(['rebuild', 'transcribe']);

/** Build the attestation records for the checked files and remember the answer per hash. */
export function buildAttestations(checked: CheckedFile[], answer: AttestationAnswer, context: string): PendingAttestation[] {
  const now = new Date().toISOString();
  return checked.map((c) => {
    const a: PendingAttestation = {
      id: randomId('att'),
      contentHash: c.hash,
      fileName: c.name,
      context,
      basis: answer.basis,
      attestedBy: answer.attestedBy.trim(),
      attestedAt: now,
      signals: signalsOf(c),
      flagged: isFlagged(c),
      checks: { metadata: true, online: c.online === 'pending' ? 'off' : c.online },
    };
    if (answer.rightsHolder?.trim()) a.rightsHolder = answer.rightsHolder.trim();
    if (answer.licence?.trim()) a.licence = answer.licence.trim();
    if (answer.notes?.trim()) a.notes = answer.notes.trim();
    if (c.match) a.match = c.match;
    rememberAttestation(c.hash, { basis: a.basis, attestedBy: a.attestedBy, rightsHolder: a.rightsHolder, licence: a.licence, notes: a.notes, fileName: c.name, attestedAt: now });
    return a;
  });
}

// ---------------------------------------------------------------------------------------------
// Recording in the open project
// ---------------------------------------------------------------------------------------------

/** Store an attestation in the open project (linked to the stored asset/provenance when there is one). */
export function recordAttestation(pending: PendingAttestation, link: { assetId?: string; provenanceId?: string } = {}): void {
  const st = useStudio.getState();
  if (!st.project) return;
  const att: AudioAttestation = { ...pending };
  if (link.assetId) att.assetId = link.assetId;
  if (link.provenanceId) att.provenanceId = link.provenanceId;
  st.updateProject((p) => addAttestation(p, att));
}

/** Attestation of a project asset (latest first). */
export function attestationForAsset(project: Project | null | undefined, assetId: string | undefined): AudioAttestation | undefined {
  if (!project || !assetId) return undefined;
  return [...(project.meta.attestations ?? [])].reverse().find((a) => a.assetId === assetId);
}

/** One line describing why a file needs care, e.g. "song.mp3 (personal study only)". */
export function careLabel(a: Pick<AudioAttestation, 'basis' | 'flagged' | 'match' | 'fileName'>): string {
  const why = [a.basis === 'personal-study' ? 'personal study only' : null, a.match ? 'matched a known recording' : a.flagged ? 'tagged as a commercial release' : null].filter(Boolean).join(', ');
  return `“${a.fileName}” (${why})`;
}

/** Asset kinds that travel under each audio data kind of a provider request (spec §50). */
const KIND_ASSETS: Record<string, string[]> = {
  'reference-audio': ['reference', 'recording', 'import'],
  stems: ['stem', 'import'],
  'guide-audio': ['guide-render', 'stem', 'import'],
  'recorded-vocals': ['recording', 'vocal'],
};

/**
 * The warning line for the data-flow confirmation: audio attested as personal study, flagged by
 * the metadata check or matched online is about to leave the device. Undefined when not relevant.
 */
export function dataFlowRightsWarning(project: Project | null | undefined, flow: Pick<DataFlowDescriptor, 'leavesDevice' | 'items'>): string | undefined {
  if (!flow.leavesDevice) return undefined;
  const included = flow.items.filter((i) => i.included && KIND_ASSETS[i.kind]);
  const kinds = new Set(included.flatMap((i) => KIND_ASSETS[i.kind]));
  if (!kinds.size) return undefined;
  const care: AudioAttestation[] = [];
  if (project) care.push(...attestationsNeedingCare(project, project.meta.assets.filter((a) => kinds.has(a.kind)).map((a) => a.id)));
  // Files uploaded to Rebuild / Transcribe travel as reference audio or recorded vocals before they belong to a project.
  if (included.some((i) => i.kind === 'reference-audio' || i.kind === 'recorded-vocals')) {
    const known = new Set((project?.meta.attestations ?? []).map((a) => a.contentHash));
    const cutoff = Date.now() - 6 * 3600_000;
    for (const a of sessionUploads) {
      if (PROJECTLESS_CONTEXTS.has(a.context) && !known.has(a.contentHash) && attestationNeedsCare(a) && Date.parse(a.attestedAt) > cutoff && !care.some((c) => c.contentHash === a.contentHash)) care.push(a);
    }
  }
  if (!care.length) return undefined;
  const list = care.slice(0, 3).map(careLabel).join('; ');
  return `Rights reminder: this request may include uploaded audio you marked or that was flagged — ${list}${care.length > 3 ? ` and ${care.length - 3} more` : ''}. Sending it to a cloud provider may not be covered by your rights to it.`;
}
