# Data Refresh

The data-refresh workflow for the Sierra Peaks Tracker. The binding rules are
frozen in [`data-contract.md`](./data-contract.md) (especially §5); this
document is the operational runbook.

## General principles

- **Authorized local snapshots only.** Refreshes consume a user-saved,
  user-exported, or otherwise authorized local snapshot placed under
  `snapshots/`. No code — build, CI, or runtime — may fetch from
  peakbagger.com or sierraclub.com. There is no Peakbagger API usage.
- **Provenance in the manifest.** Every vendored snapshot records its
  canonical URL, `retrieved_at` (UTC ISO 8601), `retrieved_by`,
  `retrieval_method`, `sha256`, importer/parser version, and expected counts
  in `data/manifest.json`.
- **Dry-run first.** Importers run in `--dry-run` mode: verify checksums,
  counts, and schema, and print the full diff without writing anything. A
  human reviews the diff; on approval, one reviewable commit updates the
  normalized data plus the manifest.
- **Deterministic reproduction.** CI re-runs the importers over the committed
  snapshots and must reproduce the committed data byte-for-byte; any drift
  fails the build.
- **Frozen counts.** The active dataset is exactly 247 peaks (never padded to
  273). The SPS source is 248 rows: 247 active plus 1 suspended (Pilot Knob,
  SPS section 1.1, class "S"), retained in source data and excluded from the
  active app dataset.

## SPS (Sierra Club) refresh — implemented (Pilot 03)

Inputs and outputs:

| Path | Role |
| --- | --- |
| `snapshots/sierraclub/sp-s-29-2025/sps-list-29th-2025.tsv` | Vendored authorized extraction of the SPS 29th Edition (Jan 2025) list: 248 rows, 24 areas |
| `scripts/vendor/extract_sps.py` | One-time local tool (PyMuPDF) that produced the TSV from the user's authorized PDF. NOT part of build/CI; the PDF binary is not committed |
| `data/manifest.json` → `sources.sierraclub["sp-s-29-2025"]` | Provenance: retrieved_at, retrieval method, TSV + source-PDF sha256, parser version, expected counts |
| `src/data/sps/sps.ts` + `src/data/sps/schema.ts` | Deterministic importer/validator (parser v1.0.0), hard-fails on any contract violation |
| `scripts/sps/import-sps.mjs` | CLI: `--dry-run` (default when output absent: prints what would change), `--check` (CI drift gate), or import |
| `data/sps/sp-s-29-2025.json` | Normalized SPS source dataset: 248 rows (247 active + 1 suspended), stable `spk-<section>.<seq>` ids |

Workflow:

1. The user saves an authorized local copy of the SPS edition. For a **new
   edition**, re-extract the TSV locally with `scripts/vendor/extract_sps.py`
   (or an equivalent one-time local tool) into
   `snapshots/sierraclub/<new-source-id>/`, then update the manifest
   (provenance, checksums, expected counts, parser version) and re-crosswalk
   ids — ids are never silently re-identified.
2. `node scripts/sps/import-sps.mjs --dry-run` — verifies the manifest
   checksum of the TSV, parses + hard-validates the snapshot (248 rows,
   247 active, 1 suspended at 1.1, 24 sections, contiguous section/seq
   ordering, no duplicate ids, raw-field shape, fixture anchors), and prints
   a full diff of what would change. Nothing is written.
3. A human reviews the diff. On approval, `node scripts/sps/import-sps.mjs`
   writes the normalized dataset; one reviewable commit lands snapshot
   changes + normalized data + manifest together.
4. CI runs `node scripts/sps/import-sps.mjs --check` and fails the build if
   the committed `data/sps/sp-s-29-2025.json` cannot be reproduced
   byte-for-byte from the committed snapshot.

   **Status note (Pilot 03):** the `pnpm check:sps` step is defined and
   exercised locally, but wiring it into `.github/workflows/ci.yml` was
   deferred: the available GitHub credential lacks the `workflow` scope,
   which GitHub requires to update a workflow file. As soon as a credential
   with that scope (or direct workflow editing) is available, add the step
   after `pnpm test`:

   ```yaml
   - name: Reproduce normalized SPS data (deterministic drift gate)
     run: pnpm check:sps
   ```

Validation is also asserted by the native test suite
(`src/data/sps/sps.test.ts`): count drift, duplicate sections/ids, malformed
rows, non-contiguous ordering, out-of-place suspended flags, and fixture
drift (Pilot Knob, Mount Emerson) are all covered as rejection tests.

## Peakbagger refresh — pending (Pilots 04–05)

- `lid=5051` (list) and `cid=30050` (public completion overlay) land as
  user-saved local snapshots under `snapshots/peakbagger/...` with the same
  manifest/dry-run/CI-reproduction treatment (see `data/manifest.json`
  `sources.peakbagger`, status `pending`).
- The explicit SPS↔Peakbagger crosswalk (`data/crosswalk.json`) and the
  canonical 247-record dataset are Pilot 05 deliverables; all joins go
  through it — name-only joins remain prohibited.

## Snapshot acceptance checklist (human, before committing)

- [ ] `retrieved_at` / `retrieved_by` / `retrieval_method` recorded in the manifest
- [ ] `sha256` of every vendored file in the manifest
- [ ] expected counts stated and asserted by the importer
- [ ] `--dry-run` diff reviewed; no invented/sample rows or dates
- [ ] one reviewable commit: snapshot + normalized data + manifest + docs
