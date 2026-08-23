# Architecture

## Overview

The Sierra Peaks Tracker is a host-neutral, fully static Astro site that
renders the canonical 247-peak active dataset (SPS 29th Edition × Peakbagger
lid=5051) as a dark split-flap "departure board". The owner's already-public
Peakbagger completion overlay (cid=30050) is layered on top. No runtime
backend, no database, no auth, no analytics.

## Data pipeline (Pilot 03–05)

All data is committed as version-controlled JSON under `data/`, generated
from authorized local snapshots under `snapshots/` by deterministic
importers. The pipeline is fully offline: no code (build, CI, or runtime)
contacts peakbagger.com or sierraclub.com.

```
snapshots/  →  scripts/  →  data/
 (TSV/HTML)     (importers)    (normalized JSON)
                              ↓
                    data/reconciled.json   ← canonical 247-peak dataset
                              ↓
                    src/data/tracker.ts    ← UI data layer
                              ↓
                    src/pages/ + src/components/
```

The frozen data contract is in [`data-contract.md`](./data-contract.md).
Operational runbook: [`data-refresh.md`](./data-refresh.md).
Per-peak reconciliation report: [`reconciliation-report.md`](./reconciliation-report.md).

## UI layer (Pilot 06)

### Design direction

Dark split-flap / departure-board aesthetic:

- Near-black board background with subtle vertical panel seams
- Split-flap "flap card" tiles: charcoal faces, central seam, soft
  top-to-bottom shading, slight top highlight
- Phosphor-glow amber accents for completed flaps
- Monospace tabular numerals, letterspaced uppercase labels
- Strong contrast: body text ≥ 7:1, muted text ≥ 4.5:1 on board background
- `prefers-reduced-motion` respected: no animations when reduced

### Page structure

| URL | Component | Behaviour |
| --- | --- | --- |
| `/` | `index.astro` → `Board.astro` | Full 247-peak board grouped by 24 SPS areas; filter bar (search, area, status) |
| `/peaks/:id/` | `peaks/[id].astro` | Single-peak detail: SPS facts, Peakbagger facts, completion status, N/E/S/W view selector |

### Progressive enhancement

- **No-JS baseline (always works):** all 247 tiles render server-side;
  each tile is a link to its detail page. The filter bar is a native GET
  form — without JS it reloads the page with `?q=&section=&status=` query
  params, and `index.astro` applies the same filters server-side.
  The compass view selector on detail pages is a native radio form that
  reloads with `?view=N|E|S|W`.
- **JS enhancement (optional):** `public/client/board.js` intercepts the
  filter form and filters the already-rendered DOM live (no reload).
  An inline script on detail pages intercepts the compass form and swaps
  the view panel in place. Neither script is required for any core content.

### Key files

| Path | Role |
| --- | --- |
| `src/data/tracker.ts` | UI data layer: loads `data/reconciled.json`, derives summary/groups/filters, re-asserts 247 invariant at build time |
| `src/data/tracker.test.ts` | Native `node:test` suite: count invariants, group reconstruction, filter logic, slug generation, compass views |
| `src/layouts/Layout.astro` | Shared layout: `<head>`, skip link, header with progress summary, footer |
| `src/components/Board.astro` | Board: filter bar + 24 SPS sections each with a grid of flap tiles |
| `src/components/PeakCard.astro` | One split-flap tile: link to detail page, SPS name, class, elevation, completion state |
| `src/pages/index.astro` | Board page; reads `?q=&section=&status=` from URL, passes to Board |
| `src/pages/peaks/[id].astro` | Detail page; `getStaticPaths()` generates one page per peak; N/E/S/W view selector |
| `src/styles/global.css` | Global stylesheet: dark theme, split-flap styles, responsive, reduced-motion |
| `public/client/board.js` | Client-side filter enhancement (loaded on index only) |

### No-JS accessibility

- Skip link (`<a class="skip-link" href="#main">`) for keyboard users
- All tiles are `<a>` elements (natively focusable, screen-reader friendly)
- `aria-label` on every tile with full name, class, elevation, completion state
- `role="progressbar"` with `aria-valuenow/min/max/valuetext` on the progress bar
- `aria-live="polite"` on the filter result count
- `aria-labelledby` on each SPS section panel
- Semantic headings: `h1` for site title, `h2` for section names and fact-card titles
- Focus styles: `:focus-visible` with high-contrast ring
- `prefers-reduced-motion`: all animations/transitions disabled

### No fabricated data

- N/E/S/W view panels are honest placeholders — the current dataset carries
  no per-face view geometry. Each panel says so explicitly. No fake
  silhouettes, ridge lines, angles, or coordinates are rendered
  (frozen §6 / `silhouettes.md`).
- Completion dates come exclusively from the cid=30050 overlay; no
  invented or sample dates (frozen §6 / `PROTOTYPE_DATES` rejection).

## Open questions

- View geometry: source of per-face view data (licensed terrain profiles,
  approach notes, or hand-drawn reference ridges) and its licensing.
  Tracked in [`silhouettes.md`](./silhouettes.md).
- Refresh-diff presentation and review workflow UX (future milestone).
