# Song Deck — Brand & Visual Identity

Song Deck combines human creativity and artificial intelligence in a focused music workstation.
The identity uses angular planes, fine rules, generous space and restrained highlights. The
product name stays **Song Deck**. “AI proposes. You shape it.” describes the relationship between
the musician and the tools; it does not require connecting an AI provider.

## Palette and roles

| Colour    | Value     | Role                                               |
| --------- | --------- | -------------------------------------------------- |
| Obsidian  | `#0b0b0d` | Main canvas and icon background                    |
| Graphite  | `#1e2226` | Raised surfaces and controls                       |
| Slate     | `#3a3f45` | Illustration planes                                |
| Ice       | `#7eebff` | User actions, selection, edits, playhead and focus |
| Fog       | `#e8ecef` | Primary text and light illustration planes         |
| Muted fog | `#c5d1d9` | AI proposal controls and indicators                |

AI proposals use neutral outlines and explicit labels; user actions and selected edits use ice.
Yellow still marks locks and warnings, green success and red errors. Track colours remain a
categorical palette so existing projects, instrument identities and note labels retain their meaning.

The semantic tokens in `apps/studio/src/styles/theme.css` apply across the home screen, composer,
editors, production, vocals, mixer, export and settings. Canvas views read those same tokens through
`src/ui/theme.ts`. Light mode uses deep teal (`#00677a`) for actions and focus, slate (`#475866`)
for AI text, and dark text on pale backgrounds. Never use ice as small text on a light surface.

## Typography and layout

- **Sora Variable**: display headings and brand; light weights for the home headline.
- **Inter Variable**: controls, labels and body text.
- **JetBrains Mono Variable**: timing, tempo, numeric readouts and code.

All fonts are bundled locally for offline use. The home screen has a split hero, three creation
entry points and a project library. Thin borders and subtle angular corner details echo the artwork.
Working views retain compact controls and the existing music workflows. Phones stack the hero and
creation cards; the studio mode picker and transport remain reachable.

Interactive controls retain full rectangular hit areas and visible keyboard focus. Project cards have
separate native buttons for opening and deleting, avoiding nested interactive elements. Decorative
artwork is hidden from assistive technology; names and actions are real HTML text.

## Vixl assets

The hero is an abstract folded monolith with an ice edge and diagonal rhythm lines. The icon keeps
Song Deck's stacked music-card concept, with angular corners and an editable waveform. Both are
created with [Vixl](https://github.com/jxburros/Vixl) **0.13.0**, source commit
`6d67a5d0332766aba337dd723c0110d06f087ddb`. No image provider or remote assets are required.

- Editable sources: `docs/brand/vixl/*.vixl`.
- Hero: `apps/studio/public/brand/sound-dimension.svg`.
- Icon exports: `apps/studio/public/favicon.svg`, the PNG favicons and manifest icons.
- Reproducible recipe: `scripts/brand/build_assets.py`.

With Vixl 0.13.0 installed, run `python scripts/brand/build_assets.py` from the repository root.
The recipe saves layered documents, exports strict vector SVGs and raster icons, and runs Vixl's
design checks. Vixl is an authoring dependency only; building and running Song Deck do not require it.
The older `docs/brand/logo-*` explorations are archived concepts, not current production assets.

## Verification

`apps/studio/test/theme-contrast.test.ts` checks WCAG AA text contrast and 3:1 UI indicators in
both themes, including translucent badges, editor backgrounds and track colours. The Playwright
accessibility suite scans the main screens in dark and light modes. Visual review should include
home, composer, a populated project library and phone layouts. Vixl checks certify the rules it
measures; the generated art and the integrated app must also be previewed visually.
