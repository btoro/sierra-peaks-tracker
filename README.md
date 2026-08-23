# Sierra Peaks Tracker

A host-neutral, fully static [Astro](https://astro.build) site that will track
the **247 active Sierra peaks** against the canonical Peakbagger list
(`lid=5051`), cross-referenced to the Sierra Club "Sierra Peaks & Sums"
(**SPS 29th Edition, January 2025**), with the owner's already-public
Peakbagger completion overlay (`cid=30050`) layered on top.

This repository is in **Pilot 07**: the SPS source dataset, the Peakbagger
list + completion overlays, the explicit SPS↔Peakbagger crosswalk, the
reconciled canonical 247-peak active dataset, the dark split-flap
departure-board UI, and the deterministic 3DEP terrain-silhouette engine are
all committed, tested, and CI-verified (see `data/`, `snapshots/`,
`scripts/`, `src/`, `docs/reconciliation-report.md`, `docs/silhouettes.md`).
The frozen data contract is in [`docs/data-contract.md`](docs/data-contract.md);
`docs/` also carries architecture, silhouettes, and privacy/provenance notes.

## Local development

Prerequisites: [Node.js](https://nodejs.org) ≥ 22.12.0 and
[pnpm](https://pnpm.io) ≥ 9 (the repo pins `packageManager: pnpm@11.22.0`;
corepack is also fine: `corepack enable && corepack prepare`).

```sh
pnpm install        # install dependencies (lockfile is committed)
pnpm dev            # local dev server at http://localhost:4321
pnpm check          # astro check (TypeScript + Astro diagnostics)
pnpm test           # native node:test suite (src/**/*.test.ts)
pnpm check:sps      # SPS drift gate (reproduce data/sps from the vendored TSV)
pnpm check:peakbagger  # Peakbagger drift gate (reproduce lid/crosswalk/cid data)
pnpm check:reconcile   # canonical reconciliation drift gate (data/reconciled.json + report)
pnpm check:silhouettes # silhouette drift gate (reproduce committed SVGs from DEM crops)
pnpm build          # production build to ./dist
pnpm preview        # serve the built site locally
```

All commands run from the repository root. The test suite uses Node's built-in
`node:test` runner — no extra test framework is required.

## Verification

Run all gates from the repository root:

```sh
# Install dependencies (lockfile is committed; pnpm is the only supported PM)
pnpm install --frozen-lockfile

# Type-check + Astro diagnostics
pnpm check

# Unit tests (native node:test runner)
pnpm test

# Data drift gates — committed data must reproduce byte-for-byte from source snapshots
pnpm check:sps
pnpm check:peakbagger
pnpm check:reconcile

# Silhouette gates — committed SVGs must reproduce from committed DEM crops
pnpm check:silhouettes
pnpm validate:silhouettes

# Production build (249 pages: 1 board + 1 peak list + 247 detail pages)
pnpm build
```

All commands must exit 0 for the build to be considered healthy. CI runs the
full suite on every push to `main` and on every pull request.

## Hosting (host-neutral static)

`pnpm build` emits a plain static site in `./dist` (Astro `output: 'static'`,
no adapter). It can be served by **any** static file host — a plain web server,
a CDN, or a static-hosting product — with no provider-specific code in this
repository.

- **No deployment-provider configuration** exists or is planned in the repo
  (no provider CLI configs, no provider-specific CI, no environment-specific
  branches).
- **No runtime backend.** The site makes no server calls: no database, no
  auth, no API, no serverless functions. Everything a visitor sees is static
  files plus static JSON data committed to this repository.
- No secrets are required for development or build; none are referenced.

## Public-data implications (privacy)

What this site may publish, and what it never will:

- **Publishes (v1):** public peak metadata (names, elevations, classes,
  coordinates where the source exposes them) and the owner's
  **already-public** Peakbagger completion dates/statuses from `cid=30050`.
- **Never includes:** photos, GPX/track files, private notes, identity or
  contact information, non-public summit locations, analytics/telemetry of
  any kind, databases, auth, or browser-based administration.
- Visitors are not tracked in any way: the built site contains no
  analytics, cookies, or data collection.
- Data refresh is a deliberate, human-run, commit-based workflow over
  **authorized local snapshots** only — see
  [`docs/data-refresh.md`](docs/data-refresh.md). No automated scraping of
  peakbagger.com or sierraclub.com happens in this repository, in CI, or at
  runtime.

## Repository layout

```text
/
├── public/            # static assets (favicons; generated silhouettes land here)
├── data/
│   ├── manifest.json  # provenance: URL/edition, retrieved_at, sha256, parser version, expected counts
│   ├── sps/
│   │   └── sp-s-29-2025.json   # normalized SPS 29th Ed. dataset (248 rows: 247 active + 1 suspended)
│   ├── peakbagger/
│   │   ├── lid-5051.json       # 247 active peaks, lid=5051 source order
│   │   └── cid-30050.json      # 30 public completions, resolved to spk- ids
│   ├── crosswalk.json          # explicit 1:1 SPS↔Peakbagger mapping (247 entries)
│   ├── reconciled.json         # canonical active dataset: 247 peaks, both orderings + completions
│   └── silhouettes/            # compact DEM crops + per-peak meta + manifest.json (committed)
├── snapshots/
│   ├── sierraclub/sp-s-29-2025/
│   │   └── sps-list-29th-2025.tsv   # vendored authorized extraction (TSV, 248 rows)
│   └── peakbagger/{lid-5051,cid-30050}/2026-08-22/  # authorized local HTML snapshots
├── scripts/
│   ├── vendor/
│   │   └── extract_sps.py   # one-time local tool (PyMuPDF) that produced the TSV; not in build/CI
│   ├── sps/
│   │   └── import-sps.mjs   # deterministic importer/validator CLI (--dry-run / --check / import)
│   ├── peakbagger/
│   │   └── import-pb.mjs    # Peakbagger importer CLI (--dry-run / --check / import)
│   ├── reconcile/
│   │   └── reconcile.mjs    # canonical reconciliation CLI (--dry-run / --check / import)
│   └── silhouette/
│       ├── generate-silhouettes.mjs  # 3DEP silhouette generator CLI (--dry-run / --check / generate)
│       ├── validate-silhouettes.mjs  # SVG asset validator (malformed/blank/duplicate/out-of-viewbox)
│       └── verify-silhouette.mjs     # standalone test runner for the silhouette engine (no node:test)
├── src/
│   ├── constants.ts         # frozen dataset invariants (asserted in tests)
│   ├── constants.test.ts
│   ├── data/sps/
│   │   ├── schema.ts        # normalized SPS row/area types (frozen §2/§4)
│   │   ├── sps.ts           # parse + hard-fail validation + deterministic JSON serialization
│   │   └── sps.test.ts      # native node:test suite (happy path + every rejection class)
│   ├── data/peakbagger/
│   │   ├── schema.ts        # Peakbagger row/crosswalk/completion types (frozen §2/§5)
│   │   ├── pb.ts            # parse + crosswalk build + completion resolution + serialization
│   │   └── pb.test.ts       # native node:test suite (happy path + every rejection class)
│   ├── data/
│   │   ├── reconcile.ts     # canonical dataset reconciliation (247 active peaks)
│   │   ├── reconcile.test.ts # reconciliation tests (counts, collisions, rejections, determinism)
│   │   ├── silhouette.ts    # deterministic 3DEP silhouette engine (projection, skyline, closed SVG paths)
│   │   ├── silhouette.test.ts # silhouette engine tests (synthetic DEMs: orientation, occlusion, flat/empty, clipping, determinism)
│   │   ├── tracker.ts       # UI data layer: loads reconciled.json, derives summary/groups/filters
│   │   └── tracker.test.ts  # UI data-layer tests (invariants, groups, filters, slugs, views)
│   ├── layouts/
│   │   └── Layout.astro     # shared layout: head, skip link, header + progress summary, footer
│   ├── components/
│   │   ├── Board.astro      # filter bar + 24 SPS sections of split-flap tiles
│   │   └── PeakCard.astro   # one split-flap tile (link to detail page)
│   ├── pages/
│   │   ├── index.astro      # the 247-peak board; server-side filter application
│   │   └── peaks/[id].astro # per-peak detail page; N/E/S/W view selector
│   └── styles/
│       └── global.css       # dark split-flap theme, responsive, reduced-motion
├── public/
│   └── client/board.js      # client-side live filter (progressive enhancement)
├── docs/
│   ├── architecture.md      # data pipeline + UI layer documentation (Pilot 06)
│   ├── data-contract.md     # FROZEN contract from Pilot 01 (verbatim)
│   ├── data-refresh.md      # operational runbook (SPS + Peakbagger + reconciliation implemented)
│   ├── reconciliation-report.md  # machine-generated per-peak reconciliation report (Pilot 05)
│   ├── silhouettes.md       # 3DEP silhouette pipeline: engine, data layout, CI gates, provenance
│   └── privacy-provenance.md
├── astro.config.mjs   # static output, host-neutral
├── .github/workflows/ci.yml
└── pnpm-lock.yaml     # committed; pnpm is the only supported package manager
```

Data pipeline commands (all offline; see `docs/data-refresh.md`):

```sh
pnpm import:sps:dry-run   # verify checksum + validate snapshot + print diff; writes nothing
pnpm import:sps           # write the normalized dataset after a reviewed dry-run
pnpm check:sps            # CI drift gate: committed data must reproduce byte-for-byte
```

## Data contract (summary)

The frozen rules are in [`docs/data-contract.md`](docs/data-contract.md).
Short summary:

- **247 active peaks**, exactly, in Peakbagger `lid=5051` source order —
  never padded to 273.
- SPS 29th Edition source has **248 rows: 247 active + 1 suspended**
  (Pilot Knob, section 1.1, class "S"). The suspended row is retained in
  source data and excluded from the active dataset.
- All joins between SPS and Peakbagger go through an explicit crosswalk of
  stable `spk-` ids — name-only joins are prohibited.
- Refreshes record provenance (URL, retrieved_at, sha256, parser version) in
  a manifest and are deterministic and re-verifiable in CI.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and on every pull request:
`pnpm install` → `pnpm check` → `pnpm test` → all drift gates → `pnpm build`,
on a Node 22 runner, using the committed pnpm lockfile.

## Silhouettes

Mountain silhouettes are static SVG files generated deterministically from
USGS 3DEP terrain data — see [`docs/silhouettes.md`](docs/silhouettes.md)
for the pipeline, data layout, and provenance rules. The design mock's
fake ridge lines are visual direction only and are never used as
geometry.
