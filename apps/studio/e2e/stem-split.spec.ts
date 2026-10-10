import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openArea, openTool } from './nav';
import { attestUpload } from './rights';

const audioModule = '/@fs' + fileURLToPath(new URL('../../../packages/audio/src/index.ts', import.meta.url));

/** A tiny "band": a bass line, a held chord and kick-like bursts every half second (stereo, 6 s). */
const BAND = `((sr) => {
  const n = sr * 6, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr, beat = t % 0.5;
    const bass = Math.sin(2 * Math.PI * (Math.floor(t) % 2 ? 98 : 110) * t) * 0.3;
    const chord = [262, 330, 392].reduce((a, f) => a + Math.sin(2 * Math.PI * f * t), 0) * 0.06;
    const kick = beat < 0.08 ? Math.sin(2 * Math.PI * 60 * beat) * Math.exp(-beat * 40) * 0.6 : 0;
    const hat = beat > 0.25 && beat < 0.27 ? (Math.random() * 2 - 1) * 0.2 : 0;
    L[i] = bass + chord * 1.4 + kick + hat;
    R[i] = bass + chord * 0.6 + kick + hat;
  }
  return { sampleRate: sr, channels: [L, R] };
})(22050)`;

async function newSong(page: Page) {
  await page.goto('/');
  await page.evaluate(`(async () => {
    const { useStudio } = await import('/src/state/store.ts');
    const { buildIdeaSong } = await import('/src/engine/capture-song.ts');
    const { encodeWav } = await import('${audioModule}');
    const st = useStudio.getState();
    await st.newProject('Stems');
    const song = buildIdeaSong({title:'Stems', bpm:120, meter:{numerator:4,denominator:4}, key:{tonic:0,mode:'major'}, notes:[{id:'n',pitch:60,tick:0,duration:480,velocity:90}], instrumentId:'piano', bars:4});
    st.commit(song, 'Test song', 'import');
    st.setMode('workbench');
    const { useLibrary } = await import('/src/state/library.ts');
    await useLibrary.getState().save({name:'Band recording', kind:'audio', assets:[], file:{name:'band.wav', mime:'audio/wav', bytes: encodeWav(${BAND})}});
  })()`);
}

const stemTracks = (page: Page) =>
  page.evaluate(`(async () => {
    const { useStudio } = await import('/src/state/store.ts');
    const p = useStudio.getState().project;
    return p.song.tracks.filter((t) => t.kind === 'audio').map((t) => ({
      name: t.name, group: t.stemGroup, notes: t.notes.length, mode: t.audioMidi?.mode,
      kind: p.meta.assets.find((a) => a.id === t.clips[0]?.assetId)?.kind,
    }));
  })()`) as Promise<{ name: string; group: string; notes: number; mode?: string; kind?: string }[]>;

test('library audio with several parts is separated into stems, each with its own MIDI', async ({ page }) => {
  await newSong(page);
  await openArea(page, 'Library');
  await page.getByRole('button', { name: 'Add to this song', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: /Separate into instrument stems first/ }).check();
  await dialog.getByRole('button', { name: 'Make MIDI and continue', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 120_000 });
  const tracks = await stemTracks(page);
  expect(tracks.length).toBeGreaterThan(1);
  expect(tracks.every((t) => t.name.startsWith('Band recording · ') && t.kind === 'stem')).toBe(true);
  expect(tracks.find((t) => t.group === 'drums')?.mode).toBe('drums');
  expect(tracks.filter((t) => t.notes > 0).length).toBeGreaterThan(1);
});

test('importing a full mix in Mix can split it into stem tracks that each make MIDI', async ({ page }) => {
  await newSong(page);
  await openTool(page, 'Full console');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import stem/audio' }).click(),
  ]);
  const band = await page.evaluate(`import('${audioModule}').then((m) => Array.from(m.encodeWav(${BAND})))`);
  await chooser.setFiles({ name: 'band.wav', mimeType: 'audio/wav', buffer: Buffer.from(band as number[]) });
  await attestUpload(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: /Separate into instrument stems/ }).check();
  await expect(dialog.getByRole('combobox', { name: 'Stem group' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Separate and add tracks' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByRole('group', { name: 'band · Drums channel strip' })).toBeVisible();
  await expect
    .poll(async () => (await stemTracks(page)).filter((t) => t.notes > 0).length, { timeout: 120_000 })
    .toBeGreaterThan(1);
});
