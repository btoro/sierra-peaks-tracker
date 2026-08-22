/**
 * Normalized SPS data schema (Pilot 03).
 *
 * Frozen by docs/data-contract.md §2 and §4. The 29th Edition source is
 * versioned as `sp-s-29-2025`; a future edition would be a new source file
 * plus a versioned re-crosswalk, never silent re-identification of existing
 * rows.
 */

/** SPS source identifier pinned to the 29th Edition (January 2025). */
export const SPS_SOURCE_ID = 'sp-s-29-2025' as const;

export type SpsSourceId = typeof SPS_SOURCE_ID;

/** One SPS area/section as printed in the source ("@AREA" rows in the snapshot). */
export interface SpsArea {
  /** SPS section id, e.g. `1` for the Southern Sierra. */
  section: number;
  /** Area name verbatim from the source (uppercase, as printed). */
  name: string;
}

/**
 * Normalized SPS row — exactly one per source row (248 total for the
 * 29th Edition), including the suspended row.
 *
 * `*_raw` fields are preserved UNCHANGED from the source; they are never
 * normalized or reformatted.
 */
export interface SpsRow {
  /** Stable canonical peak id: `spk-<section>.<seq>` (frozen §2), e.g. section 1 seq 1 → `spk-1.1`. */
  id: string;
  /** SPS section id (area number), e.g. `16`. */
  sps_section: number;
  /** 1-based within-section row index in SPS document order. */
  sps_seq: number;
  /** Area name verbatim from the source. */
  area: string;
  /** Peak name as printed, sans emblem/mountaineer markers (those are flags). */
  name: string;
  /** Elevation exactly as printed (e.g. "8453", "6200+"). */
  elevation_raw: string;
  /**
   * Raw climbing-class notation exactly as printed (e.g. "1", "2", "2s3",
   * "5.4" if ever printed, "S"). Never normalized.
   */
  class_raw: string;
  /** UTM 6-figure coordinate as printed, or `""` when the source has none. */
  utm_raw: string;
  /** Map references verbatim from the source, source order. */
  maps_raw: string;
  /** `true` when the source marks the name with `**`. */
  emblem: boolean;
  /** `true` when the source marks the name with `*`. */
  mountaineer: boolean;
  /**
   * `true` only for the suspended Pilot Knob row (section 1.1). Suspended
   * rows stay in the source data and are EXCLUDED from the active app
   * dataset (frozen §4).
   */
  suspended: boolean;
}

/** Parsed SPS TSV snapshot: the 24 areas plus the 248 source rows. */
export interface SpsSnapshot {
  areas: SpsArea[];
  rows: SpsRow[];
}
