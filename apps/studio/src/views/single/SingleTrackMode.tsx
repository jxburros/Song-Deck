import { useState } from 'react';
import GenerateMode from '../generate/GenerateMode';
import TranscribeMode from '../transcribe/TranscribeMode';

type Tool = 'transcribe' | 'midi' | 'audio';

const TOOLS: { value: Tool; num: string; label: string; note: string }[] = [
  {
    value: 'transcribe',
    num: '01',
    label: 'Audio to MIDI',
    note: 'Hum, sing, tap, clap or upload a recording; get editable notes with a confidence for each.',
  },
  {
    value: 'midi',
    num: '02',
    label: 'Generate MIDI',
    note: 'Describe one part, or set instrument, style, key and length; compare alternatives.',
  },
  {
    value: 'audio',
    num: '03',
    label: 'Generate audio',
    note: 'Compose one instrument and render it to WAV with the on-device instruments.',
  },
];

/** The last tool used, kept while the app is open. */
let lastTool: Tool = 'transcribe';

/**
 * Single Track: one part at a time, with no song open. Everything made here can be downloaded or
 * kept in the Library, then used in any song.
 */
export default function SingleTrackMode() {
  const [tool, setToolState] = useState<Tool>(lastTool);
  const setTool = (t: Tool) => {
    lastTool = t;
    setToolState(t);
  };
  const current = TOOLS.find((t) => t.value === tool)!;
  return (
    <div className="area-page single-track-page">
      <header className="page-band measure-grid">
        <span className="eyebrow-rule">Single Track</span>
        <h1>Make one part</h1>
        <p className="lede">
          No song needed. Keep anything you like in your Library and use it in any song later.
        </p>
        <div className="steps" role="tablist" aria-label="Single Track tools">
          {TOOLS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              className="step"
              aria-selected={tool === t.value}
              aria-current={tool === t.value ? 'page' : undefined}
              onClick={() => setTool(t.value)}
            >
              <span className="num" aria-hidden="true">
                {t.num}
              </span>
              {t.label}
            </button>
          ))}
        </div>
        <p className="small dim" style={{ margin: 0 }}>
          {current.note}
        </p>
      </header>
      <div className="single-track-body" role="tabpanel" aria-label={current.label}>
        {tool === 'transcribe' ? <TranscribeMode standalone /> : <GenerateMode standalone output={tool} />}
      </div>
    </div>
  );
}
