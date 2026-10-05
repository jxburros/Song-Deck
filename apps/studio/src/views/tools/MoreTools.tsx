import { useMemo, useState } from 'react';
import type { VocalTab } from '../../engine/vocal-model';
import { useStudio, type RightPanel, type WorkbenchView } from '../../state/store';
import { Icon, type IconName } from '../../ui/icons';
import { openMixTab } from '../mix/MixMode';
import { useProduceUi, type ProduceTab } from '../produce/state';
import { openSettings } from '../settings/nav';
import { useVocalSession } from '../vocals/session';
import './tools.css';

/**
 * More tools: every detailed editor inside a song, grouped and searchable. Write, Sound and Export
 * keep only the everyday controls; anything deeper is one click from here.
 */

interface Tool {
  name: string;
  desc: string;
  ai?: boolean;
  open: () => void;
}

interface Group {
  name: string;
  icon: IconName;
  tools: Tool[];
}

const st = () => useStudio.getState();
const view = (v: WorkbenchView) => () => st().setWorkbenchView(v);
const panel = (p: Exclude<RightPanel, 'ai-edit'>) => () => {
  st().setRightPanel(p);
  st().setMode('workbench');
};
const vocals = (tab: VocalTab) => () => {
  useVocalSession.getState().set({ tab });
  st().setMode('vocals');
};
const produce = (tab: ProduceTab) => () => {
  useProduceUi.getState().set({ tab });
  st().setMode('produce');
};

const tool = (name: string, desc: string, open: () => void, ai = false): Tool => ({ name, desc, open, ai });

export const TOOL_GROUPS: Group[] = [
  {
    name: 'Notes and structure',
    icon: 'midi',
    tools: [
      tool(
        'Piano roll',
        'Draw, snap, quantize, record from a MIDI keyboard, expression lanes',
        view('piano-roll'),
      ),
      tool('Pattern editor', 'Step grid for loops; copy to every repeat or every chorus', view('pattern')),
      tool('Chords', 'Edit chords by section, theory suggestions, lock the harmony', view('chords')),
      tool(
        'Structure editor',
        'Add, move, duplicate sections; bars, feel, energy, purpose',
        view('structure'),
      ),
      tool('Theory', 'Why it works, plus darker, brighter, more tension, modal', view('theory'), true),
      tool('Macros', 'Complexity, energy, density and more, for the song or one track', panel('macros')),
      tool('Locks', 'Lock tempo, key, chords, lyrics, motifs, or any track and section', panel('locks')),
    ],
  },
  {
    name: 'Vocals',
    icon: 'mic',
    tools: [
      tool(
        'Lyrics',
        'Write lyrics in several languages, lock sections, align to the melody',
        vocals('lyrics'),
        true,
      ),
      tool('Vocal melody', 'Voice type, regenerate by section, export vocal.mid', vocals('melody')),
      tool('Expression', 'Breath, tension, vibrato, onset and release, by phrase', vocals('expression')),
      tool(
        'Singer and render',
        'Choose a singer and voice, render history, re-sing changes',
        vocals('render'),
        true,
      ),
      tool(
        'Change the vocals in words',
        'Regenerate a phrase or section from an instruction',
        vocals('regenerate'),
        true,
      ),
      tool('Record a take', 'Count-in, latency, takes, turn a take into vocal MIDI', vocals('recording')),
      tool('Voice library', 'Stock and imported voices, with consent records', vocals('voices')),
      tool('Voice conversion', 'Turn a take into another authorized voice', vocals('conversion'), true),
    ],
  },
  {
    name: 'Production',
    icon: 'produce',
    tools: [
      tool('Guide sound', 'Built-in instruments, your sample instruments, or DAW stems', produce('guide')),
      tool(
        'Production plan',
        'Full, stem or hybrid production; prompts, reference audio',
        produce('production'),
        true,
      ),
      tool(
        'Audio versions',
        'Compare, rate, add notes, stems, provenance, discard',
        produce('candidates'),
        true,
      ),
      tool(
        'Regenerate a region',
        'Redo some bars of one version, with crossfade',
        produce('regenerate'),
        true,
      ),
    ],
  },
  {
    name: 'Mixing and mastering',
    icon: 'mixer',
    tools: [
      tool('Full console', 'EQ, compressor, pan, width, drive, sends and effect buses', () =>
        openMixTab('console'),
      ),
      tool(
        'Mix assistant',
        'Ask for a mix change, audition it, keep or discard',
        () => openMixTab('console'),
        true,
      ),
      tool('Automation', 'Draw volume, pan, sends and EQ changes over time', () => openMixTab('automation')),
      tool('Mastering', 'Method, target, tone, width, loudness report, A/B', () => openMixTab('mastering')),
    ],
  },
  {
    name: 'Versions',
    icon: 'branch',
    tools: [
      tool(
        'History and branches',
        'Every saved version: compare, restore, branch, merge, duplicate',
        panel('history'),
      ),
      tool(
        'Variations and Song DNA',
        'Ornament, vary or reinterpret; compose a related song',
        panel('variation'),
        true,
      ),
    ],
  },
  {
    name: 'Track details',
    icon: 'info',
    tools: [
      tool('Inspector', 'Name, instrument, role, range, complexity, colour, sections', panel('inspector')),
      tool(
        'Provenance, rights and credits',
        'What made each part, plus rights and attribution',
        panel('inspector'),
      ),
      tool('Upload checks', 'Rights statements and content checks for uploaded audio', () =>
        openSettings('privacy'),
      ),
    ],
  },
  {
    name: 'Ask and review',
    icon: 'chat',
    tools: [
      tool('Assistant', 'Ask anything about the song; it can propose changes', panel('assistant'), true),
      tool('Proposal history', 'Every change you kept or discarded, with diffs', panel('proposals')),
    ],
  },
  {
    name: 'Add parts',
    icon: 'plus',
    tools: [
      tool(
        'Describe a part',
        'Generate a new MIDI part from words, fitted to this song',
        () => st().setMode('generate'),
        true,
      ),
      tool('A part from audio', 'Turn a recording or humming into MIDI', () => st().setMode('transcribe')),
      tool('From the Library', 'Reuse saved tracks and clips from other songs', () =>
        st().setMode('library'),
      ),
    ],
  },
  {
    name: 'Queue and together',
    icon: 'tasks',
    tools: [
      tool('Generation queue', 'Pause, resume, cancel, retry; logs and cost per task', () =>
        st().setTaskDrawer(true),
      ),
      tool('Comments and live room', 'Share, comment on bars and sections, work together live', () =>
        openSettings('collab'),
      ),
    ],
  },
];

export default function MoreTools() {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOOL_GROUPS;
    return TOOL_GROUPS.map((g) => ({
      ...g,
      tools: g.tools.filter((t) => `${g.name} ${t.name} ${t.desc}`.toLowerCase().includes(q)),
    })).filter((g) => g.tools.length);
  }, [query]);
  return (
    <div className="area-page tools-page">
      <header className="page-band split measure-grid">
        <div className="grow col" style={{ gap: 6, minWidth: 0 }}>
          <span className="eyebrow-rule">Inside a song</span>
          <h1>More tools</h1>
          <p className="lede">
            Every detailed editor, one click from Write, Sound or Export. Close one to come back to where you
            were.
          </p>
        </div>
        <label className="tools-search">
          <Icon name="zoomIn" size={14} />
          <input
            className="input"
            type="search"
            placeholder="Find a tool"
            aria-label="Find a tool"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </header>
      <div className="area-body tools-grid">
        {groups.map((g, i) => (
          <section key={g.name} className="panel quiet tools-group" aria-labelledby={`tools-g-${i}`}>
            <div className="rule-title">
              <span className="index">{String(g.tools.length).padStart(2, '0')}</span>
              <Icon name={g.icon} />
              <h2 id={`tools-g-${i}`}>{g.name}</h2>
              <span className="line" />
            </div>
            <ul className="tools-list">
              {g.tools.map((t) => (
                <li key={t.name}>
                  <button type="button" className="tools-item" onClick={t.open}>
                    <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                      <span className="tools-name">{t.name}</span>
                      <span className="small dim">{t.desc}</span>
                    </span>
                    {t.ai && <span className="badge ai">AI</span>}
                    <Icon name="chevronRight" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="muted">No tool matches “{query}”.</p>}
      </div>
    </div>
  );
}
