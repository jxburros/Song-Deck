import { decodeFlac, decodeWav, parseSfz, type AudioData, type SampleInstrument } from '@songdeck/audio';

export interface LoadedSfz {
  instrument: SampleInstrument;
  samples: number;
  bytes: number;
}

/**
 * Load an SFZ instrument and every sample it references (WAV or FLAC), resolving sample paths
 * relative to the SFZ file (spec §57 "Instruments: Soundfonts"). `fetchBytes` reads a file by
 * its path inside the plugin, so this works for any file source.
 */
export async function loadSfzInstrument(
  sfzPath: string,
  fetchBytes: (path: string) => Promise<Uint8Array>,
): Promise<LoadedSfz> {
  const text = new TextDecoder().decode(await fetchBytes(sfzPath));
  const dir = sfzPath.includes('/') ? sfzPath.slice(0, sfzPath.lastIndexOf('/') + 1) : '';
  // First pass: collect the sample paths the regions reference (unresolved regions are skipped).
  const wanted = new Set<string>();
  parseSfz(text, (path) => {
    wanted.add(path);
    return undefined;
  });
  const decoded = new Map<string, AudioData>();
  let bytes = 0;
  for (const path of wanted) {
    const file = joinPath(dir, path);
    const data = await fetchBytes(file);
    bytes += data.byteLength;
    decoded.set(path, decodeSample(data, file));
  }
  const instrument = parseSfz(text, (path) => decoded.get(path));
  if (!instrument.zones.length) throw new Error(`${sfzPath}: no playable regions (check the sample paths)`);
  return { instrument, samples: decoded.size, bytes };
}

function decodeSample(bytes: Uint8Array, path: string): AudioData {
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic === 'fLaC') return decodeFlac(bytes);
  if (magic === 'RIFF' || magic === 'RF64') return decodeWav(bytes);
  throw new Error(`${path}: unsupported sample format (use WAV or FLAC)`);
}

/** Join a relative sample path onto a directory, resolving "." and ".." without leaving the root. */
function joinPath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${dir}${rel}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) throw new Error(`Sample path escapes the plugin: ${rel}`);
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}
