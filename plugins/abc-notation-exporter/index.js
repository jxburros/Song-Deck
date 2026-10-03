// Song Deck plugin: ABC notation exporter (spec §55 "notation formats", §57 "Exporters").
const SHARP = ['C', '^C', 'D', '^D', 'E', 'F', '^F', 'G', '^G', 'A', '^A', 'B'];
const FLAT = ['C', '_D', 'D', '_E', 'E', 'F', '_G', 'G', '_A', 'A', '_B', 'B'];

function abcPitch(pitch, useFlats) {
  const names = useFlats ? FLAT : SHARP;
  const base = names[pitch % 12];
  const octave = Math.floor(pitch / 12) - 1; // C4 = middle C
  const letter = base.replace(/[_^]/, '');
  const acc = base.slice(0, base.length - 1);
  if (octave >= 5) return acc + letter.toLowerCase() + "'".repeat(octave - 5);
  return acc + letter + ','.repeat(Math.max(0, 4 - octave));
}

function abcLength(sixteenths) {
  return sixteenths === 1 ? '' : String(sixteenths);
}

export function register(api) {
  const { core } = api;
  api.registerExporter({
    id: 'abc',
    name: 'ABC notation (lead melody)',
    extension: 'abc',
    mimeType: 'text/vnd.abc',
    description: 'Lead melody + chord symbols as ABC text',
    export(song) {
      const melody =
        song.tracks.find((t) => t.role === 'vocal' && t.notes.length) ??
        song.tracks.find((t) => t.kind === 'midi' && t.role !== 'drums' && t.notes.length);
      const key = core.keyAtBar(song, 0);
      const meter = song.meterMap[0] ?? { numerator: 4, denominator: 4 };
      const bpm = Math.round(song.tempoMap[0]?.bpm ?? 120);
      const flats = core.keyPrefersFlats(key);
      const tonic = core.spellPitchClass(key.tonic, key);
      const mode = key.mode === 'major' ? '' : key.mode === 'minor' ? 'm' : ` ${key.mode.slice(0, 3)}`;
      const lines = [
        'X:1',
        `T:${song.title}`,
        `M:${meter.numerator}/${meter.denominator}`,
        'L:1/16',
        `Q:1/4=${bpm}`,
        `K:${tonic}${mode}`,
      ];
      if (!melody) return lines.join('\n') + '\nz16|\n';
      const sixteenth = song.ppq / 4;
      const barTicks = core.barLengthTicks(meter, song.ppq);
      const totalBars = core.songLengthBars(song);
      const notes = melody.notes
        .map((n) => ({ ...n, tick: Math.round(n.tick / sixteenth) * sixteenth, duration: Math.max(sixteenth, Math.round(n.duration / sixteenth) * sixteenth) }))
        .sort((a, b) => a.tick - b.tick);
      let body = '';
      let cursor = 0;
      let lastChord = '';
      for (let bar = 0; bar < totalBars; bar++) {
        const barStart = bar * barTicks;
        const barEnd = barStart + barTicks;
        if (cursor < barStart) cursor = barStart;
        for (const n of notes) {
          if (n.tick < barStart || n.tick >= barEnd || n.tick < cursor) continue;
          if (n.tick > cursor) body += `z${abcLength((n.tick - cursor) / sixteenth)}`;
          const chord = core.chordAtTick(song, n.tick);
          if (chord && chord.symbol !== lastChord) {
            body += `"${chord.symbol}"`;
            lastChord = chord.symbol;
          }
          const dur = Math.min(n.duration, barEnd - n.tick);
          body += abcPitch(n.pitch, flats) + abcLength(dur / sixteenth);
          cursor = n.tick + dur;
        }
        if (cursor < barEnd) body += `z${abcLength((barEnd - cursor) / sixteenth)}`;
        cursor = barEnd;
        body += bar % 4 === 3 ? '|\n' : '|';
      }
      return `${lines.join('\n')}\n${body}\n`;
    },
  });
}
