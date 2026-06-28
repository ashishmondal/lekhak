# Lekhak — Design System

Single source of truth for the app's visual identity. The runtime tokens live in
[src/styles.css](src/styles.css) under `:root[data-theme='light']` and
`:root[data-theme='dark']`; this file documents them so design mockups and the
shipped app stay in sync.

Two themes, selected by `data-theme` on `<html>`:

- **Light = Manuscript** — warm paper, serif, oxblood accent.
- **Dark = Midnight Studio** — warm charcoal, serif, glowing amber accent.

Default comes from the OS `prefers-color-scheme`; users override via the header
toggle (`system → light → dark`), persisted to `localStorage` key `lekhak.theme`.

## Color tokens

| Token | Light (Manuscript) | Dark (Midnight Studio) |
|---|---|---|
| `--bg` | `#f6f1e7` | `#17130f` |
| `--bg-grad` | radial `#fbf7ee → #f6f1e7` | radial `#221a13 → #17130f` |
| `--surface` | `#fffdf8` | `#211b15` |
| `--surface-2` | `#efe4cf` | `#2a221a` |
| `--surface-3` | `#fbf6ea` | `#241d16` |
| `--text` | `#211b16` | `#ece3d3` |
| `--muted` | `#6f6453` | `#9b8f7c` |
| `--faint` | `#a99c84` | `#6f6557` |
| `--line` | `#e4d9c4` | `#352b21` |
| `--line-soft` | `#ece2cf` | `#2c241b` |
| `--accent` | `#8a2d2d` (oxblood) | `#e6a93f` (amber) |
| `--accent-ink` | `#fdf3ef` | `#2a1c06` |
| `--accent-soft` | `#f3e1dd` | `rgba(230,169,63,0.14)` |
| `--accent-text-glow` | `none` | `0 0 12px rgba(230,169,63,0.6)` |
| `--danger` | `#8a2417` | `#e8907c` |
| `--ok` | `#2f7d4f` | `#7fae84` |
| `--warn` | `#7a4a12` | `#e6b15f` |
| `--focus` | `#211b16` | `#e6a93f` |

## Typography

Variant A (Manuscript) typography is used in **both** themes:

| Role | Font |
|---|---|
| `--font-display` (wordmark, headings, Write button) | Fraunces |
| `--font-body` (story prose) | Spectral |
| `--font-ui` (nav, library, chrome) | Spectral |

Loaded via Google Fonts in [src/index.html](src/index.html). Story prose:
`1.08rem / line-height 1.75`.

## Signature components

- **Wordmark:** `lekhak.` lowercase, `--font-display`, with the trailing dot in
  `--accent` (glows in dark via `--accent-text-glow`).
- **Nav links:** uppercase, `letter-spacing: 0.13em`, `0.72rem`, `--muted`.
- **Chapter pager:** `‹ Ch x/y ›` grouped in one bordered pill (`--line` border,
  `--surface` bg, `0.5rem` radius).
- **Era line:** an uppercase `ERA` pill (`--accent` on `--accent-soft`) + `Set in
  <era>`.
- **Story sheet:** `--surface` bg, `1px --line` border, `2px --accent` left rule,
  `--sheet-shadow` soft drop-shadow, `0.75rem` radius.
- **Primary button (Write next):** `--accent` bg, `--accent-ink` text,
  `--font-display`, `--accent-shadow`.
- **Advisory chips (opt-in consistency):** status-bar pills that open a `--surface`
  + `--shadow-menu` popover. _Continuity_ uses `--warn` on `--warn-soft`
  (`N to review` → stacked notes, each individually dismissable). _New-card
  suggestions_ use `--accent` on `--accent-soft` (`N new names` → a listbox tray
  with Accept / Dismiss per row). Both are quiet by default: nothing renders when
  the draft is clean or the toggle is off — no spinner, no "all consistent" badge.
  Failures degrade to a plain `couldn't analyze` chip, never a red alert banner.
  Counts announce via a polite live region; popovers close on outside-click and
  Escape, and become a full-width sheet on narrow screens.

## Backdrop & shadows

- App background uses `--bg-grad` (subtle radial), applied to each route host and
  `body`.
- `--sheet-shadow`: light `0 14px 30px -22px rgba(33,27,22,0.5)`, dark
  `0 24px 48px -30px rgba(0,0,0,0.8)`.
- `--shadow-menu` for popovers; `--accent-shadow` for the primary button.

## Mockup-only flourishes (intentionally not shipped)

The editor surface is a plain `<textarea>`, so these mockup details from
variant A/C do not render and are not implemented:

- Drop-cap first letter on the opening paragraph.
- Inline blinking caret glyph in the prose.

If the editor ever moves to a rich-text/contenteditable surface, revisit these.
