import type { ExportMetadata, Song } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { Button, CommitText } from '../../ui/kit';
import { deliverFile, songFileBase } from '../../engine/export-files';
import { metadataForSong } from '../../engine/export-metadata';

const fields: [keyof ExportMetadata, string][] = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['composer', 'Composer'],
  ['genre', 'Genre'],
  ['date', 'Release date / year'],
  ['trackNumber', 'Track number'],
  ['copyright', 'Copyright'],
  ['isrc', 'ISRC'],
  ['comment', 'Comment'],
];

export function MetadataPanel({ song }: { song: Song }) {
  return (
    <section className="panel" aria-label="Export metadata">
      <div className="panel-header">
        <h3 className="grow">Export metadata</h3>
        <Button
          size="sm"
          onClick={() =>
            deliverFile(
              `${songFileBase(song)} - Metadata.json`,
              JSON.stringify(metadataForSong(song), null, 2),
              'application/json',
            )
          }
        >
          Download metadata
        </Button>
      </div>
      <div className="panel-body col">
        <p className="small muted">
          Saved with this song. Embedded in WAV, FLAC, MP3 and AAC downloads, including stems. Export
          everything also includes Metadata.json.
        </p>
        <div className="grid-2">
          {fields.map(([key, label]) => (
            <label className="field" key={key}>
              <span className="field-label">{label}</span>
              <CommitText
                aria-label={`Export ${label.toLowerCase()}`}
                value={song.exportMetadata?.[key] ?? (key === 'title' ? song.title : '')}
                onCommit={(value) => {
                  const st = useStudio.getState();
                  const current = st.project?.song;
                  if (!current || current.id !== song.id) return;
                  st.commit(
                    { ...current, exportMetadata: { ...current.exportMetadata, [key]: value } },
                    `Updated export ${label.toLowerCase()}`,
                    'edit',
                  );
                }}
              />
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
