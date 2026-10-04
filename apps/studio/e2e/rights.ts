import { expect, type Page } from '@playwright/test';

/**
 * Shared e2e helpers for the upload rights attestation (docs/RIGHTS.md): every audio upload
 * shows the AttestationDialog before the audio is used.
 */

export type BasisLabel =
  | 'I made this / I own the rights'
  | 'I have a licence or written permission'
  | 'Public domain or open licence'
  | 'Personal study only, not for release';

/** Attest the pending upload (default: own work) and wait for the dialog to close. */
export async function attestUpload(
  page: Page,
  opts: { basis?: BasisLabel; licence?: string; attestedBy?: string; expectWarning?: RegExp | string } = {},
): Promise<void> {
  const dialog = page.getByTestId('attestation-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  if (opts.expectWarning)
    await expect(dialog.getByTestId('attestation-warning').first()).toContainText(opts.expectWarning);
  await dialog.getByRole('radio', { name: opts.basis ?? 'I made this / I own the rights' }).check();
  if (opts.attestedBy !== undefined)
    await dialog.getByRole('textbox', { name: 'Attested by' }).fill(opts.attestedBy);
  if (opts.licence !== undefined) await dialog.getByRole('textbox', { name: 'Licence' }).fill(opts.licence);
  await page.getByTestId('attest-confirm').click();
  await expect(dialog).toBeHidden();
}

/** Append a RIFF LIST/INFO chunk (e.g. ICOP, IART, INAM) to a 16-bit PCM WAV buffer and fix the RIFF size. */
export function withRiffInfo(wav: Buffer, entries: [string, string][]): Buffer {
  const subs = entries.map(([id, value]) => {
    const text = Buffer.from(`${value}\0`, 'utf8');
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(text.length, 4);
    return Buffer.concat([head, text, Buffer.alloc(text.length & 1)]);
  });
  const body = Buffer.concat([Buffer.from('INFO', 'latin1'), ...subs]);
  const list = Buffer.alloc(8);
  list.write('LIST', 0, 'latin1');
  list.writeUInt32LE(body.length, 4);
  const out = Buffer.concat([wav, list, body]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
