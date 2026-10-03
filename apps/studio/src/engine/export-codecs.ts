/**
 * Export codecs shared by the export worker and the main-thread fallback:
 *  - MP3: LAME (via @breezystack/lamejs), CBR, 16-bit TPDF-dithered input.
 *  - AAC: WebCodecs `AudioEncoder` ('mp4a.40.2', AAC-LC) wrapped in ADTS frames (.aac).
 *  - ZIP: fflate, stored (level 0) for audio / nested archives, deflated otherwise.
 * Long loops yield regularly so cancellation (and the UI, on the main thread) stays responsive.
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { zipSync, type Zippable } from 'fflate';

export interface CodecControl {
  onProgress?: (p: number) => void;
  /** Checked between blocks; throw to stop. */
  checkpoint?: () => Promise<void>;
}

export interface PcmInput {
  sampleRate: number;
  channels: Float32Array[];
  kbps: number;
}

export interface ZipFileInput {
  name: string;
  data: Uint8Array;
  level?: 0 | 1 | 6 | 9;
}

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.length;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------

export const MP3_RATES = [32000, 44100, 48000, 22050, 24000, 16000, 11025, 12000, 8000];

export async function encodeMp3(a: PcmInput, ctl: CodecControl = {}): Promise<Uint8Array> {
  if (!MP3_RATES.includes(a.sampleRate)) throw new Error(`MP3 does not support ${a.sampleRate} Hz`);
  const nch = Math.min(2, Math.max(1, a.channels.length));
  const left = a.channels[0];
  const right = nch === 2 ? a.channels[1] : undefined;
  const frames = left?.length ?? 0;
  const enc = new Mp3Encoder(nch, a.sampleRate, a.kbps);
  const BLOCK = 1152 * 16;
  const l16 = new Int16Array(BLOCK);
  const r16 = new Int16Array(BLOCK);
  const parts: Uint8Array[] = [];
  let total = 0;
  // Deterministic TPDF dither (two uniform LCG values per sample).
  let seed = 0x2545f491;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const toI16 = (x: number) => {
    const v = x * 32767 + (rnd() - rnd());
    return v >= 32767 ? 32767 : v <= -32768 ? -32768 : Math.round(v);
  };
  let blocks = 0;
  for (let start = 0; start < frames; start += BLOCK) {
    const n = Math.min(BLOCK, frames - start);
    for (let i = 0; i < n; i++) l16[i] = toI16(left[start + i]);
    if (right) for (let i = 0; i < n; i++) r16[i] = toI16(right[start + i]);
    const out = right ? enc.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n)) : enc.encodeBuffer(l16.subarray(0, n));
    if (out.length) {
      parts.push(new Uint8Array(out));
      total += out.length;
    }
    if (++blocks % 8 === 0) {
      ctl.onProgress?.(start / Math.max(1, frames));
      await (ctl.checkpoint?.() ?? tick());
    }
  }
  const tail = enc.flush();
  if (tail.length) {
    parts.push(new Uint8Array(tail));
    total += tail.length;
  }
  ctl.onProgress?.(1);
  return concat(parts, total);
}

// ---------------------------------------------------------------------------
// AAC (WebCodecs) → ADTS
// ---------------------------------------------------------------------------

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** 7-byte ADTS header (MPEG-4, AAC-LC, no CRC) for one raw access unit. */
export function adtsHeader(payloadLength: number, sampleRate: number, channels: number): Uint8Array {
  const freqIdx = ADTS_RATES.indexOf(sampleRate);
  if (freqIdx < 0) throw new Error(`AAC/ADTS does not support ${sampleRate} Hz`);
  const len = payloadLength + 7;
  const profile = 1; // AAC-LC (audioObjectType 2) − 1
  const h = new Uint8Array(7);
  h[0] = 0xff;
  h[1] = 0xf1; // sync, MPEG-4, layer 0, no CRC
  h[2] = ((profile & 3) << 6) | ((freqIdx & 15) << 2) | ((channels >> 2) & 1);
  h[3] = ((channels & 3) << 6) | ((len >> 11) & 3);
  h[4] = (len >> 3) & 0xff;
  h[5] = ((len & 7) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

export async function encodeAac(a: PcmInput, ctl: CodecControl = {}): Promise<Uint8Array> {
  const g = globalThis as unknown as { AudioEncoder?: typeof AudioEncoder; AudioData?: typeof globalThis.AudioData };
  const Encoder = g.AudioEncoder;
  const WcAudioData = g.AudioData;
  if (!Encoder || !WcAudioData) throw new Error('This browser has no WebCodecs AudioEncoder');
  const nch = Math.min(2, Math.max(1, a.channels.length));
  const config: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate: a.sampleRate, numberOfChannels: nch, bitrate: a.kbps * 1000 };
  const support = await Encoder.isConfigSupported(config);
  if (!support.supported) throw new Error('AAC encoding is not supported by this browser');
  const parts: Uint8Array[] = [];
  let total = 0;
  let failure: Error | null = null;
  const encoder = new Encoder({
    output: (chunk) => {
      const raw = new Uint8Array(chunk.byteLength);
      chunk.copyTo(raw);
      // Some encoders already emit ADTS (sync word 0xFFF) — only wrap raw access units.
      const framed = raw.length > 1 && raw[0] === 0xff && (raw[1] & 0xf0) === 0xf0 ? [raw] : [adtsHeader(raw.length, a.sampleRate, nch), raw];
      for (const f of framed) {
        parts.push(f);
        total += f.length;
      }
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure(config);
  const frames = a.channels[0]?.length ?? 0;
  const CHUNK = 4096;
  let n = 0;
  try {
    for (let start = 0; start < frames; start += CHUNK) {
      if (failure) throw failure;
      const count = Math.min(CHUNK, frames - start);
      const planar = new Float32Array(count * nch);
      for (let c = 0; c < nch; c++) planar.set(a.channels[c].subarray(start, start + count), c * count);
      const data = new WcAudioData({
        format: 'f32-planar',
        sampleRate: a.sampleRate,
        numberOfFrames: count,
        numberOfChannels: nch,
        timestamp: Math.round((start / a.sampleRate) * 1e6),
        data: planar,
      });
      encoder.encode(data);
      data.close();
      if (++n % 16 === 0 || encoder.encodeQueueSize > 32) {
        ctl.onProgress?.(start / Math.max(1, frames));
        while (encoder.encodeQueueSize > 8) await tick();
        await ctl.checkpoint?.();
      }
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  ctl.onProgress?.(1);
  return concat(parts, total);
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

export function buildZip(files: ZipFileInput[], mtime = Date.now()): Uint8Array {
  const tree: Zippable = {};
  const used = new Set<string>();
  for (const f of files) {
    // Never allow two entries with the same path (later ones get " (2)").
    let name = f.name.replace(/^\/+/, '');
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let i = 2;
      while (used.has(`${stem} (${i})${ext}`)) i++;
      name = `${stem} (${i})${ext}`;
    }
    used.add(name);
    tree[name] = [f.data, { level: f.level ?? 6, mtime }];
  }
  return zipSync(tree);
}
