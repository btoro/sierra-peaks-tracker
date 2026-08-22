# Architecture (placeholder)

This document will describe the target architecture of the Sierra Peaks Tracker
site. It is intentionally a placeholder in Pilot 02; content lands in a later
milestone.

## What is already decided (frozen)

- **Host-neutral static Astro site.** The build output is a plain static site in
  `./dist`. No deployment-provider configuration, no serverless functions, no
  runtime backend, no database.
- **Astro + vanilla TypeScript.** No framework island (React/Svelte/etc.) is
  present or planned for v1 unless a concrete need justifies one.
- **Data as content.** Peak data lives in committed, version-controlled JSON
  (`data/`), generated from authorized local snapshots (`snapshots/`) by
  deterministic importers (`scripts/`). See the frozen contract in
  [`data-contract.md`](./data-contract.md).
- **No runtime fetching.** Nothing in the built site (or in CI) contacts
  peakbagger.com or sierraclub.com. All data refresh is an explicit, human-run,
  commit-based workflow.

## Open questions (to be resolved by the design milestone)

- Page/route structure for the peak list and detail views.
- How silhouettes are generated and validated (see
  [`silhouettes.md`](./silhouettes.md)).
- Refresh-diff presentation and review workflow UX.
