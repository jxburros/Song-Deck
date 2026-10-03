// Generates the Felt Keys samples (deterministic synthesis, no third-party audio):
//   node plugins/felt-keys-sfz/make-samples.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 16000;
const SECONDS = 1.4;
const here = dirname(fileURLToPath(import.meta.url));

/** Small deterministic PRNG (mulberry32) for the felt "thump". */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feltNote(midi) {
  const n = Math.round(SR * SECONDS);
  const out = new Float32Array(n);
  const f0 = 440 * 2 ** ((midi - 69) / 12);
  const B = 0.0004; // slight string inharmonicity
  const random = rng(midi * 7919);
  for (let k = 1; k <= 18; k++) {
    const fk = f0 * k * Math.sqrt(1 + B * k * k);
    if (fk > SR * 0.45) break;
    const amp = 1 / k ** 1.7;
    const decay = 1.6 + k * 0.9 + midi / 40; // upper partials and high notes die faster
    for (const detune of [-1.5, 1.5]) {
      const f = fk * 2 ** (detune / 1200);
      const phase = random() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        out[i] += 0.5 * amp * Math.sin(2 * Math.PI * f * t + phase) * (0.65 * Math.exp(-t * decay * 2.2) + 0.35 * Math.exp(-t * decay * 0.45));
      }
    }
  }
  // Felt hammer thump: a few milliseconds of low-passed noise.
  let lp = 0;
  for (let i = 0; i < Math.round(SR * 0.025); i++) {
    lp += 0.12 * ((random() * 2 - 1) - lp);
    out[i] += lp * 0.5 * Math.exp(-i / (SR * 0.006));
  }
  // Soft attack, gentle fade at the end, normalize to -3 dBFS.
  const attack = Math.round(SR * 0.004);
  const fade = Math.round(SR * 0.2);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    if (i < attack) out[i] *= i / attack;
    if (i > n - fade) out[i] *= (n - i) / fade;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const gain = peak > 0 ? 10 ** (-3 / 20) / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

function wav16(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

for (const [name, midi] of [['felt-c2', 36], ['felt-c3', 48], ['felt-c4', 60], ['felt-c5', 72]]) {
  writeFileSync(join(here, 'samples', `${name}.wav`), wav16(feltNote(midi)));
  console.log(`samples/${name}.wav`);
}
