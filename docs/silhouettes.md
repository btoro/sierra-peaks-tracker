# Silhouettes

## Current state (Pilot 06)

The split-flap board ships with **no silhouettes and no fake ridge lines**.
The N/E/S/W view selector on each peak detail page is a functional
navigation surface with an honest placeholder panel: it says plainly that no
per-face view geometry is published in the current dataset and that a real
view (angle, approach notes, or terrain profile) will appear when a
licensed geometry source is added. No angles, coordinates, or ridge shapes
are invented (frozen §6 of `data-contract.md`).

## What is decided (frozen)

- **No generated fake silhouettes in the repository baseline.** The design
  mock's fake ridge lines are visual direction only and must not be copied
  into code, fixtures, or content.
- **Host-neutral.** Whatever is shipped must be plain static assets (SVG/other)
  under `public/` or `src/assets/` — no runtime geometry generation, no
  external tile services, no provider-specific behavior.

## Open questions (for the silhouette milestone)

- Source of silhouette geometry (e.g. terrain-derived profiles vs. hand-drawn
  reference ridges) and its licensing.
- How silhouette assets are generated, stored, versioned, and validated in CI.
- Fallback behavior when a peak has no silhouette.
