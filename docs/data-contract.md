# Pilot 01 Handoff — Source, Licensing & Data Contracts (FROZEN)

Repo: btoro/sierra-peaks-tracker (public, personal). This document is the authoritative contract for Pilot 02–05. Once Pilot 02 creates the repo, commit this text verbatim as `docs/data-contract.md`.

## 1. Sources (canonical, pinned)
- S1 — Sierra Club "Sierra Peaks & Sums" (SPS), **29th Edition, January 2025**, public PDF on sierraclub.com. The exact PDF URL is recorded VERBATIM in `data/manifest.json` at first vendoring (from the user's authorized copy) and is authoritative thereafter; no URL is assumed or guessed in this contract. Content: **248 source rows = 247 active + 1 suspended**: Pilot Knob, SPS **section 1.1**, suspended class "S".
- S2 — Peakbagger list **lid=5051**, canonical URL `https://www.peakbagger.com/list/list.aspx?lid=5051`: exactly **247 active peaks**; source order is authoritative. Never pad to 273.
- S3 — Peakbagger public completion overlay **cid=30050** (owner's public profile). The exact saved-page URL is recorded verbatim in the manifest. Only real, already-public ascent dates/statuses from this overlay.

Licensing: SPS is a copyrighted Sierra Club publication — we vendor an authorized local copy for a personal tracker with attribution (edition, date, URL) in manifest and site footer; we do not redistribute the full PDF in the repo, only extracted data fields with attribution. Peakbagger data is personal-but-public: record provenance in the manifest; do not mirror Peakbagger beyond the 247-row list plus the owner's public completions.

## 2. Stable identifiers & crosswalk (frozen)
- Canonical peak id: `spk-<sps_section>.<sps_seq>` (e.g. `spk-1.1.7`), where section = SPS section id and seq = 1-based within-section row index in SPS 29th Edition document order. Ids are assigned once, never reused, stable across refreshes (pinned to the 29th Edition; a future edition = versioned re-crosswalk, never silent id changes).
- Peakbagger keys: `pb_order` = 1-based index in lid=5051 source order; `pb_id` = Peakbagger internal peak identifier when the snapshot exposes one, else null.
- `data/crosswalk.json`: explicit 1:1 entries `{sps_id, pb_order, pb_id?, aliases?[]}`. ALL joins go through this file (spk id ↔ pb key). **Name-only joins are prohibited.**
- N/S name collisions (same name in multiple SPS sections) resolve by section id + order, never by name — at minimum **Sawtooth, Morgan, Stanford, Pyramid**; **Pilot Knob (S)** is suspended and maps to NO active row.
- Every canonical record stores BOTH orderings: `sps_section`, `sps_seq` (SPS document order) and `pb_order` (list order).
- Completion records reference the stable `spk-` id (resolved via crosswalk), keep the overlay's raw reference (pb_order/pb_id) as provenance, and carry only real public date/status.

## 3. Data layout (frozen proposal)
```
snapshots/sierraclub/sp-s-29-2025/…          vendored authorized local copy
snapshots/peakbagger/lid-5051/<retrieved_at>/…
snapshots/peakbagger/cid-30050/<retrieved_at>/…
data/manifest.json                            provenance (see §5)
data/sps/sp-s-29-2025.json                    248 normalized SPS rows
data/peakbagger/lid-5051.json                 247 rows, source order
data/peakbagger/cid-30050.json                completion overlay
data/crosswalk.json                           explicit SPS↔PB mapping
scripts/…                                     deterministic importers + validation, dry-run-first
```

## 4. SPS extraction contract
- Input: user's authorized local copy of the SPS 29th Edition PDF/text only. No automated download from sierraclub.com.
- Preserve per row, unchanged from source: `sps_section`, `sps_seq`, name, `elevation_raw` (as printed), `class_raw` (raw climbing-class notation exactly as printed, e.g. "3", "5.4", "S" — never normalized/reformatted), UTM/map references when present, emblem flag, mountaineer flag, `suspended` (true only for Pilot Knob, section 1.1).
- Hard-fail validation: exactly 248 rows; 247 active + exactly 1 suspended; 24 SPS areas/sections; no duplicate section ids; no malformed rows; no count drift; Mount Emerson `class_raw` = "3" (fixture anchor).
- Output: 247 active records form the app dataset; the suspended row stays in source data (suspended=true) and is EXCLUDED from the active app dataset.

## 5. Peakbagger import & refresh contract (authorized local snapshots ONLY)
- Input: user-saved / user-exported / otherwise authorized local snapshot of lid=5051 and cid=30050.
- Provenance recorded per source in `data/manifest.json`: canonical URL, exact snapshot URL, `retrieved_at` (UTC ISO 8601), `retrieved_by`, `retrieval_method` (manual save / official export), `sha256` for every vendored file, importer/parser version, expected counts.
- Per peak preserve: name, elevation as listed, class as listed, coordinates where the snapshot exposes them, `pb_order`; stable id via crosswalk.
- Completion overlay: only records present in the cid=30050 snapshot; each resolves to a canonical active `spk-` id; dates/statuses exactly as public. Hard-fail on: unknown completion references, duplicate ids, malformed coordinates/dates, count drift (≠247), invented/sample/placeholder dates (including any dates from the design mock).
- Refresh workflow: (1) user manually saves/exports the authorized snapshot into `snapshots/`; (2) importer runs `--dry-run`: verifies checksums, counts, schema and prints the full diff, changes nothing; (3) human reviews the diff; on approval, one reviewable commit updates normalized data + manifest (new retrieved_at, checksums, parser version); (4) CI re-runs importers over committed snapshots and must reproduce committed data deterministically — any drift fails the build.

## 6. Public-data / privacy boundary
- v1 publishes ONLY: public peak metadata + the owner's already-public Peakbagger completion dates/statuses.
- Never included: photos, GPX/track files, private notes, identity or contact info, non-public summit locations, telemetry/analytics, databases, auth, browser admin.
- No deployment-provider config in the repo; host-neutral static output; no runtime backend.
- The attached design mock (80 sample rows, fake ridge lines, sample completion dates) is visual direction ONLY — never copy its rows, dates, or ridges into code, fixtures, or content.

## 7. Prohibitions (explicit)
- No live or runtime Peakbagger scraping; no automated fetching from peakbagger.com or sierraclub.com in any environment (build, CI, or runtime); no Peakbagger API calls.
- No invented/sample completion dates; no padding the dataset to 273; no name-only joins; no reusing or reassigning stable ids.
- No private data in the repo; no work-profile / Vironix / Linear / Google Workspace assets.

## 8. Acceptance anchors (fixtures for Pilot 03–05)
- SPS: 248 rows, 247 active, 1 suspended (Pilot Knob, section 1.1); 24 areas; Mount Emerson class 3.
- Peakbagger: exactly 247 unique rows in lid=5051 source order.
- Crosswalk: exactly 247 one-to-one mappings covering every active row; Pilot Knob (S) unmapped; Sawtooth/Morgan/Stanford/Pyramid/Pilot Knob collisions distinguished by section id + order.
- Manifest: every source carries URL + retrieved_at + sha256 + parser version + expected count.
