import { useState } from 'react';
import { Tabs } from '../../ui/kit';
import GenerateMode from '../generate/GenerateMode';
import TranscribeMode from '../transcribe/TranscribeMode';
export default function SingleTrackMode() {
  const [tab, setTab] = useState<'midi' | 'audio' | 'transcribe'>('midi');
  return (
    <div className="single-track-page">
      <div className="single-track-intro">
        <h1>Single Track</h1>
        <p className="muted">Create a standalone file, then export it or save it to your Library.</p>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'midi', label: 'Create MIDI', icon: 'midi' },
            { value: 'audio', label: 'Create audio', icon: 'music' },
            { value: 'transcribe', label: 'Audio to MIDI', icon: 'mic' },
          ]}
        />
        {tab === 'audio' && (
          <p className="small muted">
            Compose one instrument and render it to WAV using the on-device instrument renderer.
          </p>
        )}
      </div>
      {tab === 'transcribe' ? <TranscribeMode standalone /> : <GenerateMode standalone output={tab} />}
    </div>
  );
}
