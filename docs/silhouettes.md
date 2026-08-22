# Silhouettes (placeholder)

This document will describe how the site's mountain silhouettes are produced
and validated. It is intentionally a placeholder in Pilot 02; content lands in
a later milestone.

## What is already decided (frozen)

- **No generated fake silhouettes in the repository baseline.** The design
  mock's fake ridge lines are visual direction only and must not be copied
  into code, fixtures, or content (frozen rule in
  [`data-contract.md`](./data-contract.md)).
- **Host-neutral.** Whatever is shipped must be plain static assets (SVG/other)
  under `public/` or `src/assets/` — no runtime geometry generation, no
  external tile services, no provider-specific behavior.

## Open questions (to be resolved by the design milestone)

- Source of silhouette geometry (e.g. terrain-derived profiles vs. hand-drawn
  reference ridges) and its licensing.
- How silhouette assets are generated, stored, versioned, and validated in CI.
- Fallback behavior when a peak has no silhouette.
