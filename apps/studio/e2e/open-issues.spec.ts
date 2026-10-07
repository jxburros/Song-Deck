import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readAudioMetadata } from '@songdeck/audio';
import { openArea, songStep } from './nav';
const coreModule = '/@fs' + fileURLToPath(new URL('../../../packages/core/src/index.ts', import.meta.url));
const audioModule = '/@fs' + fileURLToPath(new URL('../../../packages/audio/src/index.ts', import.meta.url));

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(`(async () => {
    const { useStudio } = await import('/src/state/store.ts');
    const { buildIdeaSong, makeAssetMeta } = await import('/src/engine/capture-song.ts');
    const { encodeWav } = await import('${audioModule}');
    const st = useStudio.getState();
    await st.newProject('Issue regression');
    const song = buildIdeaSong({title:'Issue regression', bpm:120, meter:{numerator:4,denominator:4}, key:{tonic:0,mode:'major'}, notes:[{id:'n',pitch:69,tick:0,duration:1920,velocity:90}],instrumentId:'piano',bars:2});
    song.mastering.method = 'none';
    const audio = {sampleRate:22050, channels:[Float32Array.from({length:22050*5},(_,i)=>Math.sin(2*Math.PI*440*i/22050)*0.25)]};
    const bytes = encodeWav(audio);
    const meta = makeAssetMeta({name:'AI version.wav',kind:'generation',mimeType:'audio/wav',bytes,sampleRate:22050,channels:1,durationSeconds:5});
    await st.addAsset(meta,bytes);
    song.production.candidates = [{id:'candidate',label:'A',providerId:'internal',seed:1,mixAssetId:meta.id,stemAssetIds:{},createdAt:new Date().toISOString(),strategy:'full'}];
    st.commit(song,'Test song','import');
    st.setMode('workbench');
    const { useLibrary } = await import('/src/state/library.ts');
    await useLibrary.getState().save({name:'Test recording',kind:'audio',assets:[],file:{name:'recording.wav',mime:'audio/wav',bytes}});
  })()`);
}

test('generated audio previews play, stop and end when leaving Sound; library audio can be heard', async ({
  page,
}) => {
  await setup(page);
  await songStep(page, 'Sound');
  await page.getByRole('button', { name: 'Listen to version A', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop version A', exact: true })).toHaveText('Stop');
  await page.getByRole('button', { name: 'Stop version A', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Listen to version A', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Listen to version A', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop version A', exact: true })).toHaveText('Stop');
  await openArea(page, 'Library');
  await expect
    .poll(() =>
      page.evaluate(
        `import('/src/engine/capture-playback.ts').then(({previewPlayer})=>previewPlayer.playingId)`,
      ),
    )
    .toBeNull();
  await page.getByRole('button', { name: 'Listen to Test recording', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop Test recording', exact: true })).toHaveText('Stop');
});

test('metadata survives navigation and is embedded in downloaded audio and project files', async ({
  page,
}) => {
  await setup(page);
  await songStep(page, 'Export');
  await page.getByLabel('Export artist', { exact: true }).fill('Zoë');
  await page.getByLabel('Export album', { exact: true }).fill('New release');
  await page.getByLabel('Export copyright', { exact: true }).fill('© 2026 Zoë');
  await songStep(page, 'Sound');
  await songStep(page, 'Export');
  await expect(page.getByLabel('Export artist', { exact: true })).toHaveValue('Zoë');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download song', exact: true }).click();
  const download = await pending;
  const bytes = new Uint8Array(readFileSync((await download.path())!));
  const tags = readAudioMetadata(bytes).tags;
  expect(tags.find((t) => t.field === 'artist')?.value).toBe('Zoë');
  expect(tags.find((t) => t.field === 'copyright')?.value).toBe('© 2026 Zoë');
  const exported = await page.evaluate(`(async()=>{
    const {useStudio}=await import('/src/state/store.ts');
    const {unpackProject}=await import('${coreModule}');
    return unpackProject(await useStudio.getState().exportProjectBytes()).project.song.exportMetadata;
  })()`);
  expect(exported).toMatchObject({ artist: 'Zoë', album: 'New release' });
});

test('recommends MIDI before adding library audio and preserves its recording after transcription', async ({
  page,
}) => {
  await setup(page);
  await openArea(page, 'Library');
  await page.getByRole('button', { name: 'Add to this song', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('AI can use the notes');
  await page.getByRole('button', { name: 'Make MIDI and continue', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60000 });
  const result = await page.evaluate(`(async()=>{
    const {useStudio}=await import('/src/state/store.ts');
    const {useLibrary}=await import('/src/state/library.ts');
    const {assetStore}=await import('/src/state/assets.ts');
    const p=useStudio.getState().project;
    const t=p.song.tracks.find(t=>t.kind==='audio'&&t.audioMidi);
    const bytes=await assetStore.bytes(p.meta.assets.find(a=>a.id===t.clips[0].assetId));
    const original=useLibrary.getState().items[0].file.bytes;
    return {notes:t.notes.length,play:t.audioMidi.play,same:bytes.length===original.length&&bytes.every((b,i)=>b===original[i])};
  })()`);
  expect(result.notes).toBeGreaterThan(0);
  expect(result).toMatchObject({ play: 'audio', same: true });
});
