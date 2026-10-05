/**
 * Local hardware awareness (spec §61): classify local models as Excellent / Compatible / Slow /
 * Insufficient for the detected hardware and suggest quantized variants where appropriate.
 * Detection itself happens in the local server (apps/server); this module is pure logic.
 */
import type { Capability } from './capabilities';

export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'other';
export type AccelerationBackend = 'cuda' | 'rocm' | 'metal' | 'vulkan' | 'directml' | 'cpu';

export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  /** Dedicated VRAM in GB (for Apple silicon: 0 — unified memory is reported via HardwareInfo.unifiedMemory). */
  vramGb: number;
  backend?: AccelerationBackend;
}

export interface HardwareInfo {
  gpus: GpuInfo[];
  /** System RAM in GB. */
  ramGb: number;
  cpu: { model?: string; cores: number; threads?: number };
  /** Free disk space in GB where models are stored. */
  storageFreeGb?: number;
  backends: AccelerationBackend[];
  /** Apple silicon / shared memory GPUs: GPU can use this much of system RAM. */
  unifiedMemory?: boolean;
  os?: string;
}

export interface ModelQuantization {
  /** e.g. "Q4_K_M", "Q8_0", "F16" */
  id: string;
  sizeGb: number;
  /** VRAM needed to run fully on the GPU. */
  vramGb: number;
  /** Relative quality 0..1 vs. full precision. */
  quality?: number;
}

export interface ModelRequirements {
  minVramGb: number;
  recommendedVramGb: number;
  minRamGb: number;
  /** Can run on CPU only (slowly). */
  cpuOk: boolean;
  /** Minimum CPU cores for acceptable CPU inference. */
  minCpuCores?: number;
}

export type LocalModelCategory =
  'composition' | 'audio' | 'vocals' | 'transcription' | 'separation' | 'voice-conversion' | 'mastering';

export interface LocalModelEntry {
  id: string;
  name: string;
  category: LocalModelCategory;
  /** How it is run: ollama, lm-studio, llama.cpp, or a Song Deck bridge. */
  runtime:
    | 'ollama'
    | 'lm-studio'
    | 'llama.cpp'
    | 'ace-step-bridge'
    | 'diffsinger-bridge'
    | 'demucs-bridge'
    | 'basic-pitch-bridge'
    | 'rvc-bridge'
    | 'mastering-bridge'
    | 'whisper-bridge'
    | 'yue-bridge'
    | 'diffrhythm-bridge'
    | 'stable-audio-open-bridge'
    | 'musicgen-bridge';
  /** Provider preset that connects to it. */
  presetId: string;
  version: string;
  /** Download size in GB (default variant). */
  sizeGb: number;
  license: string;
  requirements: ModelRequirements;
  quantizations?: ModelQuantization[];
  capabilities: Capability[];
  homepage: string;
  /** Ollama tag / install hint. */
  install?: string;
  notes?: string;
}

export type CompatibilityRating = 'excellent' | 'compatible' | 'slow' | 'insufficient';

export interface CompatibilityResult {
  rating: CompatibilityRating;
  reasons: string[];
  suggestedQuantization?: string;
}

export const COMPATIBILITY_LABELS: Record<CompatibilityRating, string> = {
  excellent: 'Excellent',
  compatible: 'Compatible',
  slow: 'Slow',
  insufficient: 'Insufficient Hardware',
};

/** Usable GPU memory: the largest dedicated GPU, or ~70% of RAM on unified-memory machines. */
export function usableGpuMemoryGb(hw: HardwareInfo): number {
  const dedicated = Math.max(0, ...hw.gpus.filter((g) => g.vendor !== 'apple').map((g) => g.vramGb));
  const unified = hw.unifiedMemory || hw.gpus.some((g) => g.vendor === 'apple') ? hw.ramGb * 0.7 : 0;
  const hasAccel = hw.backends.some((b) => b !== 'cpu');
  return hasAccel || unified ? Math.max(dedicated, unified) : 0;
}

export function classifyCompatibility(model: LocalModelEntry, hw: HardwareInfo): CompatibilityResult {
  const req = model.requirements;
  const reasons: string[] = [];
  const gpuMem = usableGpuMemoryGb(hw);
  const cores = hw.cpu.threads ?? hw.cpu.cores;

  if (hw.storageFreeGb !== undefined) {
    const smallest = Math.min(model.sizeGb, ...(model.quantizations ?? []).map((q) => q.sizeGb));
    if (hw.storageFreeGb < smallest)
      return {
        rating: 'insufficient',
        reasons: [`needs ${smallest.toFixed(1)} GB of disk space, ${hw.storageFreeGb.toFixed(1)} GB free`],
      };
  }
  if (hw.ramGb < req.minRamGb) {
    return { rating: 'insufficient', reasons: [`needs ${req.minRamGb} GB RAM, ${hw.ramGb} GB available`] };
  }

  // CPU-first models (e.g. Basic Pitch, Matchering): no GPU needed at all.
  if (req.recommendedVramGb <= 0 && req.cpuOk) {
    if (cores >= (req.minCpuCores ?? 2))
      return { rating: 'excellent', reasons: [`runs on CPU (${cores} threads)`] };
    return { rating: 'slow', reasons: [`CPU with only ${cores} threads`] };
  }
  // GPU path.
  if (gpuMem >= req.recommendedVramGb) {
    reasons.push(`${gpuMem.toFixed(1)} GB GPU memory ≥ recommended ${req.recommendedVramGb} GB`);
    return { rating: 'excellent', reasons };
  }
  if (gpuMem >= req.minVramGb && gpuMem > 0) {
    reasons.push(
      `${gpuMem.toFixed(1)} GB GPU memory ≥ minimum ${req.minVramGb} GB (recommended ${req.recommendedVramGb} GB)`,
    );
    return { rating: 'compatible', reasons };
  }
  // A smaller quantization that fits?
  const fitting = (model.quantizations ?? [])
    .filter((q) => gpuMem > 0 && q.vramGb <= gpuMem)
    .sort((a, b) => (b.quality ?? b.vramGb) - (a.quality ?? a.vramGb))[0];
  if (fitting) {
    reasons.push(
      `default variant needs ${req.minVramGb} GB VRAM; ${fitting.id} fits in ${gpuMem.toFixed(1)} GB`,
    );
    return { rating: 'compatible', reasons, suggestedQuantization: fitting.id };
  }
  if (req.cpuOk) {
    const smallest = [...(model.quantizations ?? [])].sort((a, b) => a.sizeGb - b.sizeGb)[0];
    reasons.push(
      gpuMem > 0
        ? `only ${gpuMem.toFixed(1)} GB GPU memory (needs ${req.minVramGb} GB) — CPU / partial offload`
        : 'no GPU acceleration — runs on CPU',
    );
    const result: CompatibilityResult = {
      rating: cores >= (req.minCpuCores ?? 4) ? 'slow' : 'insufficient',
      reasons,
    };
    if (result.rating === 'insufficient') reasons.push(`needs at least ${req.minCpuCores ?? 4} CPU threads`);
    if (smallest) result.suggestedQuantization = smallest.id;
    return result;
  }
  reasons.push(
    gpuMem > 0
      ? `needs ${req.minVramGb} GB GPU memory, ${gpuMem.toFixed(1)} GB available`
      : `needs a GPU with ${req.minVramGb} GB+ memory`,
  );
  return { rating: 'insufficient', reasons };
}

export function summarizeHardware(hw: HardwareInfo): string {
  const gpu = hw.gpus.length
    ? hw.gpus.map((g) => `${g.name} (${g.vramGb ? `${g.vramGb} GB` : 'shared memory'})`).join(', ')
    : 'no GPU';
  return `${gpu} · ${hw.ramGb} GB RAM · ${hw.cpu.cores} cores${hw.storageFreeGb !== undefined ? ` · ${Math.round(hw.storageFreeGb)} GB free` : ''} · ${hw.backends.join('/') || 'cpu'}`;
}
