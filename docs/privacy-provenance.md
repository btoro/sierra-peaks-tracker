# Privacy & Provenance (placeholder)

This document will describe the privacy boundary and data-provenance policy of
the Sierra Peaks Tracker in operational detail. It is intentionally a
placeholder in Pilot 02; the binding boundary is already frozen in
[`data-contract.md`](./data-contract.md) and is repeated here for orientation.

## What is published (frozen boundary)

- **v1 publishes ONLY:** public peak metadata and the owner's
  already-public Peakbagger completion dates/statuses (from the public
  `cid=30050` overlay).
- The site is fully static. Visitors' browsers fetch nothing but the published
  files. There is no analytics, no telemetry, no cookies, no tracking, and no
  personal data of visitors collected.

## What is never included (frozen boundary)

- Photos, GPX/track files, private notes, identity or contact information,
  non-public summit locations, telemetry/analytics, databases, auth, or
  browser-based administration.
- Invented, sample, or placeholder completion dates (including any dates from
  the design mock). No private data of the owner or anyone else.

## Provenance (frozen)

- Every data source is recorded in `data/manifest.json`: canonical URL, exact
  snapshot URL, `retrieved_at` (UTC ISO 8601), `retrieved_by`,
  `retrieval_method`, `sha256` of the vendored file, importer/parser version,
  and expected counts.
- Peakbagger completion records keep their raw reference (`pb_order`/`pb_id`)
  as provenance and resolve to a stable `spk-` id via the crosswalk.
- SPS data carries source attribution (29th Edition, January 2025) in the
  manifest and on the site; the full PDF is not redistributed.

## Open questions (to be resolved by the data milestone)

- How the attribution notice will be rendered (site footer).
- Any refresh-history presentation (list of snapshots with dates/checksums).
