# Data Refresh (placeholder)

This document will describe the concrete data-refresh workflow for the Sierra
Peaks Tracker. It is intentionally a placeholder in Pilot 02; the operational
details land in a later milestone. The binding rules below are already
frozen in [`data-contract.md`](./data-contract.md) and are repeated here only
for orientation.

## Frozen rules (summary — see the contract for authority)

- **Authorized local snapshots only.** Refreshes consume a user-saved,
  user-exported, or otherwise authorized local snapshot of Peakbagger
  `lid=5051` and the public completion overlay `cid=30050`, placed under
  `snapshots/`.
- **No automated live scraping.** No code — build, CI, or runtime — may fetch
  from peakbagger.com or sierraclub.com. There is no Peakbagger API usage.
- **Provenance in the manifest.** Every vendored snapshot records its canonical
  URL, exact snapshot URL, `retrieved_at` (UTC ISO 8601), `retrieved_by`,
  `retrieval_method`, and `sha256` in `data/manifest.json`.
- **Dry-run-first refresh.** Importers run in `--dry-run` mode, verify
  checksums/counts/schema, and print the full diff without writing anything. A
  human reviews the diff; on approval, one reviewable commit updates the
  normalized data plus the manifest.
- **Deterministic reproduction.** CI re-runs the importers over the committed
  snapshots and must reproduce the committed data byte-for-byte; any drift
  fails the build.
- **Frozen counts.** The active dataset is exactly 247 peaks (never padded to
  273). The SPS source is 248 rows: 247 active plus 1 suspended (Pilot Knob,
  SPS section 1.1, class "S"), which is retained in source data and excluded
  from the active app dataset.

## Open questions (to be resolved by the data milestone)

- Exact snapshot file formats accepted (HTML save, official export, CSV).
- Importer/parser versioning scheme and the `--dry-run` CLI shape.
- Review workflow ergonomics (diff output, commit conventions).
