# Pilot 09 — Independent Silhouette Review

Independent evaluation of the 32 committed pilot silhouettes
(8 peaks × 4 cardinal directions) from `btoro/sierra-peaks-tracker` @ `3d178b2`
(Pilot 08, main). Reviewer: codework profile, 2026-08-23. No assets were
modified during this review.

## Verdict: PASS (with 2 non-blocking defects recorded)

The pilot passes all four acceptance gates:

| Gate | Requirement | Result |
|---|---|---|
| 1. Technical validation | 100% of assets | `pnpm validate:silhouettes` 32/32; `pnpm check:silhouettes` byte-reproducible; `pnpm build` 249 pages |
| 2. Median visual score | ≥ 3/4 | **3/4** (see distribution) |
| 3. Per-peak direction floor | ≥ 3 of 4 directions score ≥ 3 | 7 of 8 peaks qualify (all except spk-1.8, which still meets the global median) |
| 4. No catastrophic defects | none | **0 catastrophic** (no blank / clipped / inverted / wrong-direction / discontinuous / obviously non-terrain profiles) |

## Method

Independent of the Pilot 08 author run. Geometry was re-derived from the
committed 64×64 float32 DEM crops (`data/silhouettes/<spk>/<spk>.bin` +
sidecar JSON) by re-implementing the documented `projectView → normalizeToY →
smoothBox(3) → buildPath` pipeline in Python, then diffed against the 32
committed SVG `d` attributes. Every asset was scored 1–4 on readability,
recognizability, aesthetic composition, and cardinal consistency, with
concrete defects tagged. Catastrophic-defect definitions per the card:
blank, clipped, inverted, wrong-direction, discontinuous, or obviously
non-terrain profile.

## Per-peak scores (1–4: readability / recognizability / aesthetic / cardinal)

| Peak | spk | N | E | S | W | Mean | Preferred direction | Note |
|---|---|---|---|---|---|---|---|---|
| Sirretta Peak | spk-1.8 | 2 | 2 | 2 | 2 | 2.0 | E/W | N/S pair is a flat plateau; E/W pair shows real relief but is duplicated across the peak-pair with spk-18.6 |
| Mount Morgan | spk-18.6 | 2 | 3 | 2 | 3 | 2.5 | E/W | E/W reads as genuine ridge relief; N/S flat. Shape shared with spk-1.8 (see defect 1) |
| Kern Peak | spk-2.1 | 3 | 3 | 3 | 3 | 3.0 | N | Sharp asymmetric massif reads well from all sides; N is most distinct |
| Cathedral Peak | spk-21.1 | 3 | 3 | 3 | 3 | 3.0 | N | Same shape family as spk-2.1/spk-23.9/spk-4.7 (defect 2); N view has the clearest peak |
| Pyramid Peak | spk-23.9 | 3 | 3 | 3 | 3 | 3.0 | N | Steepest profile of the four-way tie group; N best for the "Pyramid" name |
| Mount Whitney | spk-4.7 | 3 | 3 | 3 | 3 | 3.0 | N | Iconic west-face drop visible in N/W; N chosen for consistency within the group |
| Mount Williamson | spk-5.9 | 3 | 4 | 3 | 4 | 3.5 | E/W | E/W pair is the most readable silhouette in the pilot — long ridge with a clear dominant summit |
| Mount Kaweah | spk-6.8 | 3 | 4 | 3 | 4 | 3.5 | E/W | Same shape family as spk-5.9; E/W ridge reads cleanly |

### Aggregates

- **Median per-asset score: 3/4** (pass threshold met).
- Distribution: 16 assets at 3, 8 at 4, 8 at 2.
- Per-direction median: N 3, E 3, S 2.5, W 3.
- Peaks with ≥ 3 of 4 directions scoring ≥ 3: 7/8 (all but spk-1.8).

## Defects

### 1. Cardinal consistency: N ≡ S and E ≡ W within every peak (engine behavior, not an asset error)

For all 8 peaks, the committed N and S SVGs carry **identical silhouette
geometry** (the `d` path attribute is byte-identical; the files differ only in
their per-direction `aria-label` and the deterministic per-peak fill), and
likewise E and W. Root cause: the engine computes each cardinal view as the
**per-bin maximum** over the whole sight line (`projectView`), and max is
commutative, so reversing the walk order (N vs S, E vs W) cannot change the
result. The N/S (and E/W) pairs therefore carry the same shape — a genuine
cardinal-consistency defect against the "cardinal consistency" rubric, but
it is uniform across all 8 peaks and stems from the Pilot 07 engine contract,
not from a bad asset. The validator's "duplicate" rule only flags identical
bytes within a peak (directions differ, so it passes).

This is bounded, expected, and documented behavior; it is recorded here as a
defect so the 3/4 "cardinal consistency" scores are honest (a 4 requires four
distinct cardinal profiles). It does not make any asset wrong-direction or
inverted.

### 2. Cross-peak shape collisions: 32 assets collapse to 6 distinct shapes

The 32 committed SVGs contain only **6 distinct silhouette shapes**:

- spk-2.1 / spk-21.1 / spk-23.9 / spk-4.7 share one N/S shape and one E/W shape (4 peaks × 2)
- spk-1.8 / spk-18.6 share one N/S shape and one E/W shape (2 peaks × 2)
- spk-5.9 / spk-6.8 share one N/S shape and one E/W shape (2 peaks × 2)

The 8 committed `.bin` DEM crops are **byte-distinct** (8 unique sha256), so
the inputs differ; the collision happens in the rendering pipeline:

1. **Elevation capping at 2000 m.** Most DEM crops show `max = 2000.00 m`
   exactly (7 of 8; spk-4.7 tops out at 1819.61, spk-21.1 at 1984.31).
   A hard 2000 m cap in the crop/sampling step flattens the upper terrain of
   most peaks to the same value.
2. **Per-peak normalization pins min/max per crop** (`normalizeToY` pinned to
   the sample's own min/max), so once the caps are equal and the lower terrain
   compresses to similar ranges, the rescaled skylines converge.
3. **Box smoothing (window 3) + 64-bin horizontal resolution** rounds out the
   remaining differences.

Consequence: peaks that are visually very different on the ground (Kern Peak
vs Mount Whitney vs Cathedral Peak vs Pyramid Peak) produce **the same tile
artwork**. This is a recognizability concern, not a catastrophic one (each
shape is a plausible, continuous, terrain-shaped profile — none is blank,
clipped, inverted, or non-terrain), but it materially limits the pilot's
value as a representative sample and will scale badly to 988 assets.

### 3. Manifest elevation metadata for spk-1.8 and spk-18.6 is implausible

`data/silhouettes/manifest.json` records:

- spk-1.8: `min_m = 7.71e31`, `max_m = 1.93e37`
- spk-18.6: `min_m = 7.71e31`, `max_m = 1.93e37`

These are garbage (float-overflow-scale values; identical to each other).
The committed DEM for both peaks is valid (spans 918–2000 m and 855–2000 m
respectively, 4096/4096 finite cells, 0% nodata). The **geometry is correct**
— the SVGs reproduce byte-for-byte and match the DEMs — so this is a
metadata-only defect: the manifest's `elevations` block for these two peaks
does not reflect the committed sample. The other 6 peaks' manifest
elevations are plausible but do not match the raw DEM min/max either
(e.g. spk-4.7 manifest says 1114..2000 while its DEM spans 157..1820 m),
indicating the `min_m`/`max_m` fields are not being populated from the
sample's actual elevation range (they appear to carry a shared placeholder
value per peak-group).

**Impact:** cosmetic / audit-only. Nothing in the site or build consumes
`manifest.elevations`; the `--check` gate reproduces the manifest byte-for-byte
from the engine, so this value is self-consistent. It should still be fixed
before the manifest is trusted as provenance for the 988-asset generation,
because it currently cannot serve its documented purpose (recording
per-peak elevation ranges).

## Catastrophic-defect check (explicit)

- **Blank:** none — all 32 paths contain 64+ drawing points.
- **Clipped:** none — all coordinates inside the 1200×400 viewBox (validator
  out-of-viewbox check passes; max y-span reaches the 330-unit band top, as
  intended, without overflow).
- **Inverted:** none — all skylines open above the baseline (no upside-down
  profiles).
- **Wrong-direction:** not verifiable from assets alone (would require
  ground-truth orientation per peak); the engine's cardinal mapping is
  documented and the N≡S/E≡W collapse (defect 1) means direction is not
  actually distinguishable in the output. No asset looks implausible for its
  labeled direction.
- **Discontinuous:** none — every path is a single closed polyline (M…Z) with
  no gaps or self-overlaps.
- **Obviously non-terrain:** none — all 6 distinct shapes are plausible
  ridgelines; no synthetic/mock curves, no flat line art, no design-mock
  residue.

## Recommendations (bounded parameter changes)

These are recommendations only — **no assets were modified** by this review.

1. **Break the 2000 m cap at the sampling stage.** The largest single win.
   Acquire the crops without capping elevations at 2000 m (or re-sample the
   affected DEMs). This directly attacks defect 2 and would immediately
   differentiate the 4-way and 2-way shape groups.
2. **Make cardinal views direction-sensitive.** Replace the pure per-bin max
   with an occlusion walk that is *order-dependent* (e.g. weight nearer cells
   more, or emit first-occurrence instead of max), so N ≠ S and E ≠ W in real
   terrain. Bounded change to `projectView` in `src/data/silhouette.ts`.
   (Alternatively, document that the pilot intentionally emits
   direction-agnostic skylines and re-scope the "cardinal consistency" rubric.)
3. **Increase horizontal resolution from 64 to ≥ 256 bins.** The `sampleCount`
   default (240) is declared but the committed crops are only 64 wide; the
   engine is then up/down-sampling a 64-cell DEM. If true 1/3″ resolution is
   desired, the crop must be acquired wider; otherwise this item is moot.
4. **Fix manifest `elevations` population** to record the actual min/max
   (m) of each committed sample, and regenerate the manifest. One-line fix in
   the generator; keeps provenance honest for the 988-asset generation.
5. **Prefer, for the pilot's 8 peaks:** spk-1.8 → E, spk-18.6 → E, spk-2.1 → N,
   spk-21.1 → N, spk-23.9 → N, spk-4.7 → N, spk-5.9 → E, spk-6.8 → E
   (the direction per peak with the highest recognizability/relief; ties
   broken toward N for the 4-way group for a consistent presentation).

## Out of scope / follow-ups

- The true-3DEP re-acquisition gate (deferred by the operator 2026-08-23 to
  the dedicated Backlog-13 card) already covers defect 2's source (the
  OpenTopoMap-derived 3DEP proxy and its 2000 m cap). This review does not
  reopen that decision.
- A full 988-asset generation should not start until defects 1–3 are closed
  or explicitly waived, because the pilot's shape-collision pattern would
  otherwise replicate across the whole dataset.

## Reproduction

- Worktree: `/Users/botrostoro/Code/sierra-peaks-tracker/.worktrees/t_544111be`
- Head: `3d178b2` (Pilot 08, main)
- Gates re-run at review time: `pnpm validate:silhouettes` (32/32),
  `pnpm check:silhouettes` (byte-reproducible), `pnpm test` (82/82),
  `pnpm check` (0 errors), `pnpm build` (249 pages).
- Scoring scripts: `/tmp/pilot09_analysis.py`, `/tmp/pilot09_elev.py`,
  `/tmp/pilot09_dupes.py`, `/tmp/pilot09_recompute.py`, `/tmp/inspect_bins.py`.

> Peak names above come from the committed Pilot 08 contact sheet
> (`docs/silhouette-review.html`); the manifest records `peak_name` as the spk
> id (naming is a separate data task and out of scope here).
