import { useEffect, useState } from 'react';
import { ACOUSTID_CREDENTIAL_REF } from '@songdeck/ai';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { useRuntime } from '../../engine/runtime';
import { deleteCredential, hasCredential, saveCredential } from '../../engine/ai';
import { forgetAttestations, loadAttestationMemory, useContentCheck } from '../../engine/rights';
import { Badge, Button, TextInput, Toggle } from '../../ui/kit';
import { Panel } from './ui';

/**
 * Settings → Privacy → Content check (docs/RIGHTS.md): the opt-in online identification of
 * uploads (AcoustID) and the per-browser memory of upload attestations.
 */
export function ContentCheckPanel() {
  const online = useContentCheck((s) => s.online);
  const update = useContentCheck((s) => s.update);
  const offline = useSettings((s) => s.routing.offline);
  const serverOnline = useRuntime((s) => s.server.status === 'online');
  const useProxy = useSettings((s) => s.useServerProxy);
  const viaServer = serverOnline && useProxy;
  const [key, setKey] = useState('');
  const [stored, setStored] = useState<boolean | null>(null);
  const [remembered, setRemembered] = useState(() => Object.keys(loadAttestationMemory().byHash).length);
  const toast = useStudio.getState().toast;

  useEffect(() => {
    let alive = true;
    void hasCredential(ACOUSTID_CREDENTIAL_REF).then((v) => alive && setStored(v));
    return () => {
      alive = false;
    };
  }, [viaServer]);

  const save = async () => {
    try {
      const where = await saveCredential(ACOUSTID_CREDENTIAL_REF, key.trim(), 'AcoustID application key (content check)');
      setKey('');
      setStored(true);
      toast(
        'success',
        where === 'vault'
          ? 'AcoustID key stored in the server vault (OS keychain).'
          : where === 'browser'
            ? 'AcoustID key stored encrypted in this browser (no local server).'
            : 'AcoustID key kept for this browser session only (this browser cannot store it encrypted).',
      );
    } catch (err) {
      toast('error', `Could not store the key: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const remove = async () => {
    await deleteCredential(ACOUSTID_CREDENTIAL_REF);
    setStored(false);
  };

  return (
    <Panel
      title="Content check"
      icon="shield"
      testId="content-check-panel"
      sub="Uploaded audio always asks for a rights attestation and is checked offline for embedded copyright tags (ISRC, ©/℗ notices, labels, store purchase markers). Online identification is optional."
    >
      <div className="col" style={{ gap: 10 }}>
        <Toggle on={online} onChange={(v) => update({ online: v })} label={<strong>Identify uploads online with AcoustID</strong>} />
        <div className="small muted">
          When on, Song Deck computes an audio fingerprint on this device and sends <strong>only the fingerprint and the duration</strong> — never the audio — to
          AcoustID (acoustid.org), which looks it up and returns MusicBrainz recording titles/artists. A match is shown as a warning in the attestation dialog; it never
          blocks the upload.{offline ? ' Offline mode is on, so no lookup is made until you turn it off.' : ''}
        </div>
        <div className="callout warning small">
          AcoustID’s API is free for <strong>non-commercial use only</strong> and needs your own application API key (register one at acoustid.org). If you use Song Deck
          commercially, get a commercial AcoustID plan or leave this off. Fingerprints recognise only the exact recording — not covers, re-recordings, humming or
          melodies — and no match does not mean you may use the audio.
        </div>
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <label className="field grow" style={{ minWidth: 220 }}>
            <span className="field-label">AcoustID application API key</span>
            <TextInput value={key} onChange={setKey} type="password" placeholder={stored ? '•••••••• (stored)' : 'Paste your key'} aria-label="AcoustID API key" autoComplete="off" />
          </label>
          <Button variant="primary" onClick={() => void save()} disabled={!key.trim()}>
            Save key
          </Button>
          {stored && (
            <Button variant="ghost" icon="trash" onClick={() => void remove()}>
              Remove key
            </Button>
          )}
          {stored !== null && <Badge tone={stored ? 'success' : undefined}>{stored ? (viaServer ? 'key in server vault' : 'key in this browser') : 'no key stored'}</Badge>}
        </div>
        <div className="small dim">
          {viaServer
            ? 'The key is kept in the local server’s vault (OS keychain); lookups go through the server, so the key never reaches the browser.'
            : 'No local server: the key is stored encrypted in this browser and lookups go directly to api.acoustid.org.'}
        </div>
        <div className="row between small" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <span className="muted">
            Remembered attestations in this browser: <strong>{remembered}</strong> file{remembered === 1 ? '' : 's'} (by SHA-256 of the file, so re-uploads are one click).
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!remembered}
            onClick={() => {
              forgetAttestations();
              setRemembered(0);
            }}
          >
            Forget
          </Button>
        </div>
      </div>
    </Panel>
  );
}
