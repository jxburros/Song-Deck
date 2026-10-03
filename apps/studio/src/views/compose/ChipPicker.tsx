import { useMemo, useState } from 'react';
import { getGenre, listTags, type GenreProfile, type InstrumentProfile, type StyleTag, type TagKind } from '@songdeck/core';
import { Icon } from '../../ui/icons';

/**
 * Searchable, grouped chip picker for large catalogs (hundreds of tags, dozens of genres and
 * instruments): groups show a few chips with "+N more", search matches names, aliases, groups and
 * descriptions across everything.
 */

export interface PickItem {
  id: string;
  label: string;
  group: string;
  /** Small trailing hint, e.g. a style tag's parent genres. */
  hint?: string;
  title?: string;
  /** Extra searchable text (aliases, description). */
  keywords?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();

export function ChipPicker({
  items,
  selected,
  onToggle,
  label,
  placeholder,
  perGroup = 10,
  maxResults = 80,
  testId,
}: {
  items: PickItem[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  /** Accessible name of the search box, e.g. "Search moods". */
  label: string;
  placeholder?: string;
  perGroup?: number;
  maxResults?: number;
  testId?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const q = norm(query);
  const groups = useMemo(() => {
    const words = q ? q.split(' ') : [];
    const hit = (it: PickItem) => {
      if (!words.length) return true;
      const hay = norm(`${it.label} ${it.id} ${it.group} ${it.keywords ?? ''}`);
      return words.every((w) => hay.includes(w));
    };
    const byGroup = new Map<string, PickItem[]>();
    let n = 0;
    for (const it of items) {
      if (!hit(it)) continue;
      if (q && n >= maxResults) break;
      n++;
      byGroup.set(it.group, [...(byGroup.get(it.group) ?? []), it]);
    }
    if (q) {
      // Best matches first: names that start with the query.
      for (const [g, list] of byGroup) byGroup.set(g, [...list].sort((a, b) => Number(!norm(a.label).startsWith(q)) - Number(!norm(b.label).startsWith(q))));
    }
    return [...byGroup.entries()];
  }, [items, q, maxResults]);
  const total = groups.reduce((t, [, l]) => t + l.length, 0);

  return (
    <div className="cb-picker" data-testid={testId}>
      <div className="cb-search">
        <Icon name="zoomIn" size={14} />
        <input className="input sm" type="search" value={query} placeholder={placeholder ?? 'Search…'} aria-label={label} onChange={(e) => setQuery(e.target.value)} />
        {query && <span className="small dim nowrap">{total} found</span>}
      </div>
      {groups.length === 0 && <div className="small muted">Nothing matches “{query}”.</div>}
      <div className="cb-groups">
        {groups.map(([group, list]) => {
          const expanded = Boolean(q) || open[group] || list.length <= perGroup + 2;
          const shown = expanded ? list : list.filter((it, i) => i < perGroup || selected.includes(it.id));
          return (
            <div key={group} className="cb-group" role="group" aria-label={group}>
              {groups.length > 1 || group ? <div className="cb-group-label small dim">{group}</div> : null}
              <div className="chip-list">
                {shown.map((it) => {
                  const on = selected.includes(it.id);
                  return (
                    <button key={it.id} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} title={it.title} onClick={() => onToggle(it.id)}>
                      {on && <Icon name="check" size={11} />}
                      {it.label}
                      {it.hint && <span className="cb-chip-hint">{it.hint}</span>}
                    </button>
                  );
                })}
                {!expanded && list.length > shown.length && (
                  <button type="button" className="chip cb-more" onClick={() => setOpen((o) => ({ ...o, [group]: true }))} aria-label={`Show all ${list.length} in ${group}`}>
                    +{list.length - shown.length} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<TagKind, string> = {
  style: 'Style',
  mood: 'Mood',
  era: 'Era',
  production: 'Production',
  vocal: 'Vocal',
  region: 'Region',
  rhythm: 'Rhythm',
};

export const tagKindLabel = (k: TagKind) => KIND_LABEL[k] ?? k;

/** Parent genres of a style tag as a short hint ("→ Emo, Rock"). */
export function parentHint(tag: StyleTag, genres?: GenreProfile[]): string | undefined {
  if (!tag.parents?.length) return undefined;
  return `→ ${tag.parents.map((p) => getGenre(p.genreId, genres)?.name ?? p.genreId).join(', ')}`;
}

/** Catalog tags of some kinds as picker items, grouped by kind and the tag's own group. */
export function tagItems(kinds: readonly TagKind[], genres?: GenreProfile[]): PickItem[] {
  const multi = kinds.length > 1;
  const tags = kinds.flatMap((k) => listTags(k));
  return tags.map((t) => {
    const group = multi ? (t.group && t.group !== KIND_LABEL[t.kind] ? `${KIND_LABEL[t.kind]} · ${t.group}` : KIND_LABEL[t.kind]) : t.group ?? KIND_LABEL[t.kind];
    return {
      id: t.id,
      label: t.name,
      group,
      hint: t.kind === 'style' ? parentHint(t, genres) : undefined,
      title: [t.description, t.kind === 'style' && t.parents?.length ? `Pulls the blend toward ${parentHint(t, genres)!.slice(2)}` : ''].filter(Boolean).join(' — ') || undefined,
      keywords: [t.kind, ...(t.aliases ?? []), t.description ?? ''].join(' '),
    };
  });
}

const STYLE_FAMILY: Record<string, string> = {
  rock: 'Rock & guitar',
  punk: 'Rock & guitar',
  'pop-punk': 'Rock & guitar',
  emo: 'Rock & guitar',
  metal: 'Rock & guitar',
  indie: 'Rock & guitar',
  pop: 'Pop & electronic',
  'synth-pop': 'Pop & electronic',
  'four-on-floor': 'Pop & electronic',
  trance: 'Pop & electronic',
  'hip-hop': 'Hip-hop & R&B',
  trap: 'Hip-hop & R&B',
  rnb: 'Hip-hop & R&B',
  'jazz-swing': 'Jazz, folk & country',
  folk: 'Jazz, folk & country',
  country: 'Jazz, folk & country',
  orchestral: 'Orchestral & cinematic',
  cinematic: 'Orchestral & cinematic',
};

/** Genres as picker items: custom/plugin genres first, built-ins grouped by family. */
export function genreItems(builtIn: readonly GenreProfile[], custom: readonly GenreProfile[]): PickItem[] {
  const customIds = new Set(custom.map((g) => g.id));
  const all = [...custom, ...builtIn.filter((g) => !customIds.has(g.id))];
  const items = all.map((g) => ({
    id: g.id,
    label: g.name,
    group: customIds.has(g.id) ? 'Your genres' : STYLE_FAMILY[g.rhythm.drumStyle] ?? 'More genres',
    title: g.description,
    keywords: [g.description ?? '', ...(g.tags ?? [])].join(' '),
  }));
  const order = ['Your genres', 'Rock & guitar', 'Pop & electronic', 'Hip-hop & R&B', 'Jazz, folk & country', 'Orchestral & cinematic', 'More genres'];
  return items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

const FAMILY_LABEL: Record<string, string> = {
  drums: 'Drums & percussion',
  percussion: 'Drums & percussion',
  bass: 'Bass',
  guitar: 'Guitars',
  keys: 'Keys',
  organ: 'Keys',
  strings: 'Strings',
  brass: 'Brass & winds',
  woodwind: 'Brass & winds',
  synth: 'Synths',
  vocal: 'Voices',
};

/** Instruments as picker items, grouped by family; custom/plugin instruments first. */
export function instrumentItems(builtIn: readonly InstrumentProfile[], custom: readonly InstrumentProfile[]): PickItem[] {
  const customIds = new Set(custom.map((i) => i.id));
  const all = [...custom, ...builtIn.filter((i) => !customIds.has(i.id))];
  const order = ['Your instruments', 'Drums & percussion', 'Bass', 'Guitars', 'Keys', 'Strings', 'Brass & winds', 'Synths', 'Voices', 'More'];
  return all
    .map((i) => ({ id: i.id, label: i.name, group: customIds.has(i.id) ? 'Your instruments' : FAMILY_LABEL[i.family] ?? 'More', keywords: `${i.family} ${i.defaultRole}` }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}
