import { fileURLToPath } from 'node:url';
const coreModule = '/@fs' + fileURLToPath(new URL('../../../packages/core/src/index.ts', import.meta.url));
import { expect, test } from '@playwright/test';

test('standalone generation preserves the open project and saves persistent MIDI and audio', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const before = await page.evaluate(`(async () => {
    const { useStudio } = await import('/src/state/store.ts');
    await useStudio.getState().newProject('Keep this project');
    return JSON.stringify(useStudio.getState().project);
  })()`);
  await page.getByRole('button', { name: 'Single Track', exact: true }).first().click();
  await page.getByLabel('Asset prompt').fill('Create a 2-bar piano melody in C major at 120 BPM.');
  await page.getByTestId('generate-run').click();
  const result = page.getByTestId('alternative-card').first();
  await expect(result).toBeVisible();
  await expect(result.getByRole('button', { name: /Insert|Open.*project/ })).toHaveCount(0);
  await result.getByRole('button', { name: 'Save to Library' }).click();
  await expect(page.getByText('Saved to Library', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      `import('/src/state/store.ts').then(({useStudio}) => JSON.stringify(useStudio.getState().project))`,
    ),
  ).toBe(before);
  await page.getByRole('tab', { name: 'Create audio', exact: true }).click();
  await result.getByRole('button', { name: 'Save to Library' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        `import('/src/state/library.ts').then(({useLibrary}) => useLibrary.getState().items.length)`,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      `import('/src/state/store.ts').then(({useStudio}) => JSON.stringify(useStudio.getState().project))`,
    ),
  ).toBe(before);
  await page.reload();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByTestId('library-item')).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByTestId('library-item').first().getByRole('button', { name: 'Export', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.wav$/);
  await page.getByTestId('library-item').first().getByRole('button', { name: 'Use in Compose' }).click();
  await expect(page.getByTestId('compose-input')).toHaveCount(1);
  await page.getByRole('button', { name: 'Generate song', exact: true }).click();
  await expect(page.getByTestId('project-timeline')).toBeVisible();
  const audioPreserved = await page.evaluate(`(async () => {
    const { useStudio } = await import('/src/state/store.ts');
    const { useLibrary } = await import('/src/state/library.ts');
    const { assetStore } = await import('/src/state/assets.ts');
    const project = useStudio.getState().project;
    const track = project.song.tracks.find(t => t.kind === 'audio');
    const asset = project.meta.assets.find(a => a.id === track.clips[0].assetId);
    const stored = await assetStore.bytes(asset);
    const original = useLibrary.getState().items[0].file.bytes;
    return { sameBytes: stored.length === original.length && stored.every((v,i) => v === original[i]), locked: project.song.locks['track:'+track.id] };
  })()`);
  expect(audioPreserved).toEqual({ sameBytes: true, locked: true });
  expect(errors).toEqual([]);
});

test('library copies remap audio assets and survive deletion of the originating project', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(`(async () => {
    const core = await import('${coreModule}');
    const { useStudio } = await import('/src/state/store.ts');
    const { saveSongToLibrary, useLibrary, independentCopy } = await import('/src/state/library.ts');
    const { deleteProject } = await import('/src/state/persistence.ts');
    const song = core.createEmptySong({ title: 'Audio source' });
    song.sections = [{ id: 'sec', name: 'Verse', kind: 'verse', bars: 2, energy: 50 }];
    song.tracks = [{ id: 'track', name: 'Recording', kind: 'audio', role: 'custom', instrumentId: 'piano', constraints: {}, notes: [], clips: [{ id: 'clip', assetId: 'asset', tick: 0, offsetSeconds: 0, durationSeconds: 1, gainDb: 0, fadeInSeconds: 0, fadeOutSeconds: 0 }], color: '#abcdef', stemGroup: 'others' }];
    const project = await useStudio.getState().newProject('Audio source', song);
    const { makeAssetMeta } = await import('/src/engine/capture-song.ts');
    const bytes = new Uint8Array([1, 2, 3]);
    const meta = makeAssetMeta({ id: 'asset', name: 'take.wav', kind: 'recording', mimeType: 'audio/wav', bytes, sampleRate: 44100, channels: 1, durationSeconds: 1 });
    await useStudio.getState().addAsset(meta, bytes);
    await saveSongToLibrary(song);
    const original = useLibrary.getState().items[0];
    const a = independentCopy(original), b = independentCopy(original);
    a.assets[0].bytes[0] = 99;
    a.song.tracks[0].name = 'Changed';
    await deleteProject(project.meta.id);
    await useLibrary.getState().refresh();
    const saved = useLibrary.getState().items[0];
    return { differentTracks: a.song.tracks[0].id !== b.song.tracks[0].id, differentAssets: a.assets[0].meta.id !== b.assets[0].meta.id, linkedWithinCopy: b.song.tracks[0].clips[0].assetId === b.assets[0].meta.id, bytes: [...saved.assets[0].bytes], name: saved.song.tracks[0].name };
  })()`);
  expect(result).toEqual({
    differentTracks: true,
    differentAssets: true,
    linkedWithinCopy: true,
    bytes: [1, 2, 3],
    name: 'Recording',
  });
});

test('compose combines multiple MIDI inputs, preserves their timing, and displays a seekable timeline', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(`(async () => {
    const core = await import('${coreModule}');
    const { useComposeInputs } = await import('/src/views/compose/inputs.ts');
    const { buildIdeaSong } = await import('/src/engine/capture-song.ts');
    const { useComposeSession } = await import('/src/views/compose/session.ts');
    const { useStudio } = await import('/src/state/store.ts');
    for (const [i, bpm] of [90, 150].entries()) {
      const song = buildIdeaSong({ title: 'Input ' + i, bpm, meter: {numerator:4, denominator:4}, key:{tonic:0,mode:'major'}, notes:[{id:'note',pitch:60+i*7,tick:480,duration:960,velocity:91}], instrumentId:'piano', bars:2 });
      useComposeInputs.getState().add({ id:'item'+i, name:'Input '+i, kind:'midi', song, assets:[], createdAt:new Date().toISOString() });
    }
    useComposeSession.getState().patch({ instruments:[{ instrumentId:'cello',count:1 }], vocal:'none', length:'short', title:'Combined song' });
    useStudio.getState().setMode('compose');
  })()`);
  await expect(page.getByTestId('compose-input')).toHaveCount(2);
  await expect(page.getByLabel('Interpretation for Input 0')).toHaveValue('preserve');
  await page.getByRole('button', { name: 'Generate song', exact: true }).click();
  await expect(page.getByTestId('project-timeline')).toBeVisible();
  await expect(page.locator('.project-name')).toHaveText('Combined song');
  const result = await page.evaluate(`(async () => {
    const core = await import('${coreModule}');
    const { useStudio } = await import('/src/state/store.ts');
    const song = useStudio.getState().project.song;
    const tm = core.createTimeMap(song);
    return song.tracks.filter(t => song.locks['track:'+t.id]).map(t => ({ pitch:t.notes[0].pitch, seconds:tm.tickToSeconds(t.notes[0].tick), duration:tm.tickToSeconds(t.notes[0].tick+t.notes[0].duration)-tm.tickToSeconds(t.notes[0].tick), velocity:t.notes[0].velocity }));
  })()`);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ pitch: 60, velocity: 91 });
  expect(result[0].seconds).toBeCloseTo(60 / 90, 2);
  expect(result[1].seconds).toBeCloseTo(60 / 150, 2);
  expect(result[1].duration).toBeCloseTo(120 / 150, 2);
  await page.getByLabel('Seek project playback').fill('1');
  await expect(page.getByLabel('Seek project playback')).toHaveValue('1');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByTestId('project-timeline')).toBeVisible();
});

test('reinterpretation changes independent copies while Preserve locks the original performance', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(`(async () => {
    const core = await import('${coreModule}');
    const { buildIdeaSong } = await import('/src/engine/capture-song.ts');
    const { interpretInput, mergeComposeInputs } = await import('/src/views/compose/inputs.ts');
    const song = buildIdeaSong({title:'Original melody', bpm:120, meter:{numerator:4,denominator:4}, key:{tonic:0,mode:'major'}, notes:[{id:'n',pitch:60,tick:0,duration:480,velocity:90,locked:true}],instrumentId:'piano',bars:4});
    song.locks['track:'+song.tracks[0].id] = true;
    const item = {id:'lib',name:'Melody',kind:'midi',song,assets:[],createdAt:new Date().toISOString()};
    const before = JSON.stringify(item);
    const input = {id:'input',item,interpretation:'preserve',startBar:1};
    const preserve = await interpretInput(input, 123);
    const free = await interpretInput({...input,interpretation:'free'}, 123);
    const originalNotes = song.tracks[0].notes.map(({pitch,tick,duration,velocity}) => ({pitch,tick,duration,velocity}));
    const freeNotes = free.item.song.tracks[0].notes.map(({pitch,tick,duration,velocity}) => ({pitch,tick,duration,velocity}));
    const merged = mergeComposeInputs(core.createEmptySong(), [preserve]);
    return { unchanged: before === JSON.stringify(item), freshTrack: preserve.item.song.tracks[0].id !== song.tracks[0].id, locked: merged.locks['track:'+merged.tracks[0].id], varied: JSON.stringify(originalNotes) !== JSON.stringify(freeNotes) };
  })()`);
  expect(result).toEqual({ unchanged: true, freshTrack: true, locked: true, varied: true });
});
