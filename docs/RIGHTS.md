# Uploaded audio: rights checks and their limits

Song Deck lets people bring their own audio into a project: Rebuild a recording, Transcribe a
voice memo, add reference audio for production, import stems into the mix, import rendered guide
stems and load samples as an instrument. Some of that audio belongs to someone else. This document
says what Song Deck does about that and, just as important, what it cannot do.

**Policy, in one line:** *warn, don't block; always ask for an attestation; stay offline and free
by default.*

## What happens on every upload

1. **Attestation (always).** Before an uploaded file is used, a shared dialog asks the user to
   state their basis for using it:

   | Basis | Meaning |
   | --- | --- |
   | I made this / I own the rights | own recording, or rights otherwise held |
   | I have a licence or written permission | licence, sample-pack terms, written permission |
   | Public domain or open licence (e.g. CC) | the licence name is required |
   | Personal study only, not for release | practice / analysis on this device |

   The dialog also records who attests (pre-filled from the last answer), an optional rights
   holder, a licence/permission reference and notes. **Cancel abandons the upload.**
   Microphone takes and tapped rhythms are the user's own performance and are not asked about.

2. **Offline check: embedded metadata (always, on the device).** The file's tags are read by a
   small, bounded parser (`packages/audio/src/dsp/codecs/metadata.ts`, never throws):

   | Container | Tags read |
   | --- | --- |
   | MP3 (ID3v2.2–2.4, ID3v1) | TIT2, TPE1, TALB, TCOP, TPUB, TSRC (ISRC), TXXX (ISRC, LABEL, CATALOGNUMBER, …), COMM, WCOM, WPAY, WCOP, WPUB, OWNE, COMR, USER, store PRIV frames |
   | WAV (RIFF INFO, `id3 ` chunk) | ICOP, IART, INAM, IPRD, ICMT, … (RIFF `ISRC` means "source" and only counts when it is a well-formed ISRC) |
   | FLAC, Ogg Vorbis/Opus (Vorbis comments) | COPYRIGHT, LICENSE, ISRC, LABEL, ORGANIZATION, PUBLISHER, ARTIST, TITLE, ALBUM, … |
   | MP4/M4A (`ilst`) | cprt, ©ART, ©nam, ©alb, iTunes store atoms (apID, purd, cnID, atID, plID, sfID, ownr), `----` freeform items (ISRC, LABEL) |

   An **ISRC, a copyright notice, a label/publisher or a store purchase marker** makes the file
   "likely a commercial release": the dialog shows a prominent warning listing what was found
   (for example *This file carries ISRC USRC17607839 and "℗ 2019 Some Label"*). Artist/title tags
   alone are a softer hint. The user can still continue. The purchaser's account e-mail in an
   iTunes `apID` atom is never shown or stored, only the fact that it is present.

3. **Optional online identification (off by default).** Under *Settings → Privacy → Content
   check* the user can turn on AcoustID identification and enter their own AcoustID application
   API key. The studio then computes a Chromaprint fingerprint **on the device** and sends
   **only the fingerprint and the duration** (never audio) to `api.acoustid.org`. A match
   (MusicBrainz recording title/artists, `meta=recordings releasegroups`) is shown as a warning in
   the dialog. It does not block the upload either.

## Where attestations go

* **The project:** `ProjectMeta.attestations: AudioAttestation[]` (`packages/core/src/ir/types.ts`),
  linked to the stored asset and its `user-import` provenance record. Each record holds the SHA-256
  of the file, the basis, who attested and when, the licence, the notes, what the checks found
  (`signals`, `match`) and which checks ran.
* **Rights metadata (spec §65):** own work and personal study are listed under *Source references*,
  licences and open licences under *Licensed assets*, and sample uploads under *Samples*. The
  Inspector's rights panel lists every attestation, with flagged ones marked.
* **Exports:** the `.songproject` package carries the attestations in `project.json` and a derived
  `rights/RIGHTS.txt`. *Export everything* adds `RIGHTS.txt` to the archive.
* **This browser:** answers are remembered per file content hash (localStorage key
  `songdeck:attestation-memory`, at most 500 files). Re-uploading the same bytes, even under
  another name, pre-fills the dialog and needs one click. *Settings → Privacy → Content check →
  Forget* clears the memory.

## Downstream reminders (still warn-only)

* **Data-flow confirmation:** when a cloud request is about to include uploaded audio that was
  attested as *personal study* or flagged/matched, the confirmation dialog adds a rights reminder.
  This covers reference audio, stems, guide audio and recorded audio, including Rebuild/Transcribe
  uploads that do not belong to a project yet. Such a request always asks for confirmation,
  whatever the user's "Confirm before sending" setting.
* **Produce → Reference audio** shows the same reminder next to the reference.
* **Export mode** shows a notice when the project contains such material.

## What is *not* checked: honest limitations

* **Fingerprinting finds only the exact recording**, including re-encodes and modest edits. It
  does **not** detect covers, re-recordings, remixes built from scratch, humming, a melody played
  on another instrument, interpolations or samples buried in a mix.
* **Tags are trivial to strip or fake.** No tags does not mean the audio is free to use, and
  tags can be wrong.
* **No match proves nothing.** AcoustID's database is community-built and far from complete.
* **Nothing checks generated output.** Song Deck does not test whether AI-produced audio, MIDI or
  lyrics resemble existing works.
* **Online checks need the network** and the user's own key. In offline mode Song Deck skips the
  lookup entirely, sends nothing, and the dialog says so.
* **Nothing can truly enforce this in a local, open-source app.** Anyone can edit the code, the
  project file or the browser storage. An attestation is the user's own statement, recorded for
  their benefit and for collaborators. It is not a verification and not legal advice.

## AcoustID terms

AcoustID's web service is **free for non-commercial use only** and requires an application API
key (register at <https://acoustid.org>). Commercial use needs a paid AcoustID plan. Because Song
Deck's commercial status is undecided, the feature ships **off by default** and the settings panel
states the terms. Each user brings their own key, and Song Deck ships none. Respect AcoustID's
rate limit (3 requests/second); Song Deck makes one request per uploaded file.

**Key storage** uses the existing credential path. With the local server running, the key goes
to the server vault (OS keychain) and lookups go through `POST /api/content-check/acoustid`,
which reads the key there, so the browser never sees it. Without a server, the key is stored
encrypted in this browser (see [CREDENTIALS.md](./CREDENTIALS.md)) and the lookup goes directly to
`api.acoustid.org`.

## The Chromaprint port

`packages/audio/src/analysis/chromaprint.ts` is a TypeScript port of Chromaprint's default
algorithm (TEST2: 11025 Hz mono, 4096-sample frames with a 1365-sample hop, Hamming window, 12-band
chroma over 28–3520 Hz, 5-tap chroma filter, normalization, 16 Haar-like classifiers with gray
coding, then the compressed URL-safe base64 encoding). It was validated against
`fpcalc` 1.5.1 (Debian `libchromaprint-tools`):

* 16-bit mono 11025 Hz input reproduces fpcalc **bit for bit**, both the raw sub-fingerprints and
  the encoded string. This held for synthetic chords, noise and very quiet signals.
* Other rates (22.05, 32, 44.1 and 48 kHz, mono and stereo) are resampled with a Kaiser-windowed
  sinc close to FFmpeg's swresample. On chord material the result was identical to fpcalc. On
  noise and sweeps the bit error rate was at most 0.07%, far inside AcoustID's matching
  tolerance (it compares fingerprints by bit error rate and offset).

`packages/audio/test/analysis-chromaprint.test.ts` pins golden fpcalc fingerprints and re-runs
the comparison live when `fpcalc` is installed. Because the port is validated, no server-side
`fpcalc` fallback is shipped.

## Plugging in a commercial service

The identification step is a seam, not a hard-wired call:

1. Implement `ContentIdentificationProvider` (`packages/ai/src/adapters/acoustid.ts`):
   `identify({ fingerprint, durationSeconds, signal }) → { status, matches[] }`, plus a
   human-readable `sends` statement. The capability `CONTENT_IDENTIFICATION` exists in
   `packages/ai/src/capabilities.ts` for such providers.
2. Services that need audio instead of a Chromaprint fingerprint (e.g. ACRCloud, Audible Magic,
   Pex) must extend the request with an excerpt. That changes what leaves the device, so update
   the dialog/settings wording and treat it as a data-flow item (`reference-audio`) with a
   confirmation.
3. Wire it in `identifyFingerprint()` in `apps/studio/src/engine/rights.ts`, and, so keys stay
   in the vault, add a server route modeled on `apps/server/src/content-check.ts`.
4. Keep it warn-only unless the product decision changes. The dialog, the attestation record and
   the reminders already handle any `ContentMatch` (service, score, title, artists, release).

## Code map

| Piece | Where |
| --- | --- |
| Metadata reader + classification | `packages/audio/src/dsp/codecs/metadata.ts` |
| Chromaprint port | `packages/audio/src/analysis/chromaprint.ts` (worker job `fingerprint`) |
| Attestation model + rights reflection + summaries | `packages/core/src/ir/types.ts`, `packages/core/src/project/rights.ts` |
| AcoustID adapter / provider seam | `packages/ai/src/adapters/acoustid.ts` |
| Server lookup with the vault key | `apps/server/src/content-check.ts` |
| Studio engine (hashing, memory, checks, reminders) | `apps/studio/src/engine/rights.ts` |
| Dialog | `apps/studio/src/views/shared/AttestationDialog.tsx` |
| Settings panel | `apps/studio/src/views/settings/ContentCheckPanel.tsx` |
| Inspector list | `apps/studio/src/views/workbench/panels/AttestationList.tsx` |
