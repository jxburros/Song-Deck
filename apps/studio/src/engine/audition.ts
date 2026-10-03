/** Tiny main-thread synth for auditioning notes while editing (independent of the playback engine). */
let ctx: AudioContext | null = null;

export function auditionNote(pitch: number, velocity = 96, drum = false) {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    const v = (velocity / 127) * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(v, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (drum ? 0.12 : 0.45));
    gain.connect(ctx.destination);
    if (drum) {
      const len = Math.floor(ctx.sampleRate * 0.12);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = pitch < 40 ? 'lowpass' : 'highpass';
      f.frequency.value = pitch < 40 ? 180 : 3000;
      src.connect(f).connect(gain);
      src.start(t);
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.5);
  } catch {
    /* audio unavailable */
  }
}
