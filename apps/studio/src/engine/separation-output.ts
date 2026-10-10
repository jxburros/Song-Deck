import { resample, type AudioData } from '@songdeck/audio';
import { stemNameFrom } from '@songdeck/ai';

export interface NamedStem {
  name: string;
  audio: AudioData;
}

export function isStemComplement(name: string): boolean {
  return /^(no|without|minus)[_ -]|instrumental|accompan|karaoke|^backing$/.test(name.toLowerCase());
}

/** Preserve fine-grained parts, avoid overlapping complements, and retain unseparated material. */
export function completeSeparatedStems(stems: NamedStem[], original: AudioData): NamedStem[] {
  if (!stems.length) throw new Error('The separator returned no stems');
  const named = stems.map((s) => ({ ...s, name: stemNameFrom(s.name) }));
  const parts = named.filter((s) => !isStemComplement(s.name));
  const complements = named.filter((s) => isStemComplement(s.name));
  // A single isolated part plus its complement already covers the recording.
  if (parts.length === 1 && complements.length === 1) return [...parts, complements[0]];
  if (!parts.length) return complements.slice(0, 1);
  if (parts.some((s) => s.name === 'other')) return parts;
  // Some services return only isolated instruments. Keep the rest as an honest residual,
  // resampling each part to the recording's clock before subtraction.
  const remainder = { sampleRate: original.sampleRate, channels: original.channels.map((c) => c.slice()) };
  for (const part of parts) {
    const aligned = resample(part.audio, original.sampleRate);
    remainder.channels.forEach((c, ci) => {
      const src = aligned.channels[Math.min(ci, aligned.channels.length - 1)];
      for (let i = 0; i < Math.min(c.length, src.length); i++) c[i] -= src[i];
    });
  }
  return [...parts, { name: 'other', audio: remainder }];
}
