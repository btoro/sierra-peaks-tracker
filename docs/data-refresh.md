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

## Peakbagger refresh — implemented (Pilot 04)

**Status note (Pilot 04):** the `check:peakbagger` step is defined and
exercised locally, but wiring the SPS/PB/reconciliation drift gates into
`.github/workflows/ci.yml` is deferred: the available GitHub credential
lacks the `workflow` scope, which GitHub requires to update a workflow file.
As soon as a credential with that scope (or direct workflow editing) is
available, add these steps after `pnpm test`:

```yaml
- name: Reproduce normalized SPS data (deterministic drift gate)
  run: pnpm check:sps
- name: Reproduce normalized Peakbagger data (deterministic drift gate)
  run: pnpm check:peakbagger
- name: Reproduce canonical reconciliation (deterministic drift gate)
  run: pnpm check:reconcile
```

Inputs and outputs:

| Path | Role |
| --- | --- |
| `snapshots/peakbagger/lid-5051/2026-08-22/lid-5051.html` | Authorized local HTML snapshot of the lid=5051 list (247 rows, source order) |
| `snapshots/peakbagger/cid-30050/2026-08-22/cid-30050.html` | Authorized local HTML snapshot of the cid=30050 completion overlay (30 dated rows) |
| `data/manifest.json` → `sources.peakbagger["lid-5051"]`, `sources.peakbagger["cid-30050"]`, `sources.peakbagger.crosswalk` | Provenance: URL, retrieval date, sha256, parser version, expected counts |
| `src/data/peakbagger/pb.ts` + `src/data/peakbagger/schema.ts` | Deterministic parser/validator (parser v1.0.0), hard-fails on any contract violation |
| `scripts/peakbagger/import-pb.mjs` | CLI: `--dry-run` (verify + print diffs, write nothing), `--check` (CI drift gate), or import |
| `data/peakbagger/lid-5051.json` | 247 rows in lid=5051 source order |
| `data/crosswalk.json` | Explicit 1:1 SPS↔Peakbagger crosswalk (247 entries) |
| `data/peakbagger/cid-30050.json` | Real public completions only (30 dated rows, resolved to `spk-` ids via crosswalk) |

Workflow:

1. The user saves the authorized local snapshot into `snapshots/peakbagger/...`.
2. `pnpm import:peakbagger:dry-run` — verifies manifest checksums, parses +
   hard-validates both snapshots, builds the crosswalk and completion
   resolution, and prints the full diff of what would change. Nothing is
   written.
3. A human reviews the diff. On approval, `pnpm import:peakbagger` writes the
   normalized data plus the manifest; one reviewable commit lands snapshot
   changes + normalized data + manifest together.
4. CI runs `pnpm check:peakbagger` and fails the build if any committed
   Peakbagger data file cannot be reproduced byte-for-byte from the committed
   snapshots.

Validation is also asserted by the native test suite
(`src/data/peakbagger/pb.test.ts`): count drift, duplicate ids, malformed
cells, crosswalk non-bijectivity, overlay drift, unknown/suspended completion
references, prototype-date leakage, and byte-for-byte serialization
reproducibility are all covered.

## Canonical reconciliation — implemented (Pilot 05)

| Path | Role |
| --- | --- |
| `data/sps/sp-s-29-2025.json`, `data/peakbagger/lid-5051.json`, `data/peakbagger/cid-30050.json`, `data/crosswalk.json` | The four committed normalized inputs |
| `src/data/reconcile.ts` + `src/data/reconcile.test.ts` | Pure reconciliation engine + rejection test suite |
| `scripts/reconcile/reconcile.mjs` | CLI: `--dry-run` / `--check` (CI drift gate) / import |
| `data/reconciled.json` | Authoritative canonical active dataset: exactly 247 peaks, each carrying both SPS and Peakbagger orderings plus the owner's public completion when present |
| `docs/reconciliation-report.md` | Machine-generated per-peak reconciliation report (247 rows + collision families) |

`pnpm import:reconcile` reconciles the four committed sources against the
frozen contract and writes `data/reconciled.json` plus the report. It hard-
fails on duplicates, missing canonical rows, unknown completion references,
and sample/mock dates. CI runs `pnpm check:reconcile` to verify byte-for-byte
reproduction; any drift fails the build.

## Snapshot acceptance checklist (human, before committing)

- [ ] `retrieved_at` / `retrieved_by` / `retrieval_method` recorded in the manifest
- [ ] `sha256` of every vendored file in the manifest
- [ ] expected counts stated and asserted by the importer
- [ ] `--dry-run` diff reviewed; no invented/sample rows or dates
- [ ] one reviewable commit: snapshot + normalized data + manifest + docs
