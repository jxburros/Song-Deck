import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../../../state/store';
import { Button, Spinner, TextArea } from '../../../ui/kit';
import { ProviderPicker } from '../../shared/ProviderPicker';
import { aiChat } from '../../../engine/ai';

const SUGGESTIONS = [
  'Why does the pre-chorus feel weak?',
  "Give the bass more movement but don't change the chords.",
  'What would happen if this chorus were in half-time?',
  'Make the bridge contrast more strongly with the chorus.',
  'Add strings without making the arrangement crowded.',
];

/** Project-aware AI conversation (spec §44). Answers reference the actual song; edits come back as proposals. */
export default function AssistantPanel() {
  const song = useStudio((s) => s.project?.song ?? null);
  const chat = useStudio((s) => s.chat);
  const selection = useStudio((s) => s.selection);
  const st = useStudio.getState();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState('auto');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [chat.length]);
  if (!song) return null;

  const send = async (q = text) => {
    if (!q.trim()) return;
    setText('');
    st.pushChat({ role: 'user', content: q });
    setBusy(true);
    try {
      const history = [...useStudio.getState().chat].map((m) => ({ role: m.role, content: m.content }));
      const res = await aiChat(song, history, selection, { providerChoice: provider });
      st.pushChat({ role: 'assistant', content: res.answer, provider: res.source, proposalId: res.proposalId });
    } catch (err) {
      st.pushChat({ role: 'assistant', content: `I couldn't answer that: ${err instanceof Error ? err.message : String(err)}`, provider: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>
          Assistant
        </h3>
        <Button size="sm" variant="ghost" onClick={() => st.clearChat()}>
          Clear
        </Button>
      </div>
      <ProviderPicker role="chat" value={provider} onChange={setProvider} size="sm" />
      <div className="chat-log grow" style={{ overflow: 'auto', minHeight: 120 }}>
        {chat.length === 0 && (
          <div className="col">
            <div className="small muted">Ask about this song. Answers use its real sections, chords and parts.</div>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" style={{ justifyContent: 'flex-start', height: 'auto', padding: '6px 10px', textAlign: 'left' }} onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.content}
            {m.provider && m.role === 'assistant' && <div className="small dim" style={{ marginTop: 4 }}>{m.provider}</div>}
            {m.proposalId && (
              <div style={{ marginTop: 6 }}>
                <Button
                  size="sm"
                  variant="ai"
                  onClick={() => {
                    st.setActiveProposal(m.proposalId!);
                    st.setRightPanel('proposals');
                  }}
                >
                  Review proposed change
                </Button>
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="row small muted">
            <Spinner /> thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>
      <TextArea
        value={text}
        onChange={setText}
        rows={2}
        placeholder="Ask about the song…"
        aria-label="Ask the assistant"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Button variant="ai" icon="chat" disabled={busy || !text.trim()} onClick={() => void send()}>
        Send
      </Button>
    </div>
  );
}
