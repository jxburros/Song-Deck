import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, choicesFromDraft, withSinger, type ComposeDraft } from '../src/views/compose/session';

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
