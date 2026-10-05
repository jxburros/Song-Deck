import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT,
  activeLyricsMode,
  choicesForStart,
  choicesFromDraft,
  lyricsActive,
  useComposeSession,
  withSinger,
  type ComposeDraft,
} from '../src/views/compose/session';

const LYRICS = '[Verse]\nHeadlights on the empty road\n\n[Chorus]\nDriving home at dawn';
const patched = (prev: ComposeDraft, p: Partial<ComposeDraft>) => withSinger(prev, { ...prev, ...p }, p);

describe('compose session: lyrics need a singer', () => {
  it('pasting lyrics over an instrumental setting brings the vocal back', () => {
    const instrumental = { ...EMPTY_DRAFT, vocal: 'none' as const };
    const next = patched(instrumental, { lyricsText: LYRICS });
    expect(next.vocal).toBe('auto');
    expect(choicesFromDraft(next).vocal).toMatchObject({ mode: 'ai-singer' });
  });

  it('an instrumental starting point applied over lyrics keeps a singer', () => {
    const withLyrics = { ...EMPTY_DRAFT, lyricsText: LYRICS };
    const next = patched(withLyrics, { genres: [{ genreId: 'hip-hop', weight: 1 }], vocal: 'none' });
    expect(next.vocal).toBe('auto');
  });

  it('choosing Instrumental on its own is respected', () => {
    const withLyrics = { ...EMPTY_DRAFT, lyricsText: LYRICS };
    expect(patched(withLyrics, { vocal: 'none' }).vocal).toBe('none');
  });

  it('leaves drafts without lyrics alone', () => {
    expect(patched(EMPTY_DRAFT, { genres: [], vocal: 'none' }).vocal).toBe('none');
  });
});

describe('compose session: song type and starting from style', () => {
  const store = () => useComposeSession.getState();
  beforeEach(() => store().reset());

  it('Instrumental hides lyrics from the song and forces no vocal', () => {
    store().set({ lyricsOn: true });
    store().patch({ lyricsText: LYRICS });
    store().setInstrumental(true);
    const s = store();
    expect(s.draft.vocal).toBe('none');
    expect(activeLyricsMode(s)).toBe('instrumental');
    expect(lyricsActive(s)).toBe(false);
    const choices = choicesForStart(s.draft, activeLyricsMode(s));
    expect(choices.vocal).toBe('none');
    expect(choices.lyrics).toBeUndefined();
    // A starting point with a singer does not bring the vocal back.
    store().patch({ genres: [{ genreId: 'pop', weight: 1 }], vocal: 'tenor' });
    expect(store().draft.vocal).toBe('none');
  });

  it('switching back to With vocals restores an automatic vocal (and keeps the lyrics)', () => {
    store().set({ lyricsOn: true });
    store().patch({ lyricsText: LYRICS });
    store().setInstrumental(true);
    store().setInstrumental(false);
    const s = store();
    expect(s.draft.vocal).toBe('auto');
    expect(lyricsActive(s)).toBe(true);
    expect(choicesForStart(s.draft, activeLyricsMode(s)).vocal).toMatchObject({ mode: 'ai-singer' });
  });

  it('With vocals means a vocal, even with no lyrics', () => {
    const choices = choicesForStart(EMPTY_DRAFT, 'provided');
    expect(choices.vocal).toMatchObject({ mode: 'melody-only' });
  });

  it('an instrumental starting point makes a song with no lyrics instrumental', () => {
    store().patch({ genres: [{ genreId: 'hip-hop', weight: 1 }], vocal: 'none' });
    expect(store().instrumental).toBe(true);
  });

  it('any lyrics keep the singer when an instrumental starting point is applied', () => {
    store().set({ lyricsOn: true, lyricsMode: 'placeholder' });
    store().patch({ genres: [{ genreId: 'hip-hop', weight: 1 }], vocal: 'none' });
    expect(store().instrumental).toBe(false);
    expect(store().draft.vocal).toBe('auto');
  });

  it('starting from style settings opens Shape; picking a start clears it', () => {
    store().startFromStyle();
    expect(store()).toMatchObject({ step: 'shape', fromStyle: true });
    store().start('midi');
    expect(store()).toMatchObject({ step: 'material', fromStyle: false });
  });
});
