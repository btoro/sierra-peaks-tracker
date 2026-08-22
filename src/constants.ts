/**
 * Frozen dataset invariants for the Sierra Peaks Tracker.
 *
 * These values are contractual anchors defined by the frozen data contract
 * (docs/data-contract.md). They are asserted by the native test suite so a
 * dataset change that drifts the frozen counts fails the build instead of
 * silently landing. Do not "fix" a failing assertion by editing these
 * constants — fix the data, or update the contract through a deliberate,
 * reviewable change.
 */

/** Number of active peaks in the canonical Peakbagger list lid=5051. */
export const SPS_ACTIVE = 247;

/** Number of suspended source rows in the SPS 29th Edition (Pilot Knob, section 1.1). */
export const SPS_SUSPENDED = 1;

/** Total SPS 29th Edition source rows = active + suspended. */
export const SPS_TOTAL_ROWS = SPS_ACTIVE + SPS_SUSPENDED;

/** Peakbagger list identifier (lid) for the canonical 247-peak list. */
export const PEAKBAGGER_LIST_ID = 5051;

/** Peakbagger public completion-overlay identifier (cid) for the owner's profile. */
export const PEAKBAGGER_COMPLETION_CID = 30050;
