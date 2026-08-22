/**
 * Normalized Peakbagger data schema (Pilot 04).
 *
 * Frozen by docs/data-contract.md §2 and §5. Sources:
 *   S2 — lid=5051 list page: exactly 247 active peaks, source order
 *        authoritative.
 *   S3 — cid=30050 public completion overlay (owner's profile): only real,
 *        already-public ascent dates/statuses.
 *
 * The 2026-08-22 browser snapshot is versioned as
 * `lid-5051@2026-08-22` / `cid-30050@2026-08-22`; a later refresh is a new
 * retrieval directory plus a new parser output, never silent mutation of
 * stable ids.
 */

/** Canonical URL of the lid=5051 list (frozen §1, S2). */
export const PB_LIST_CANONICAL_URL =
  'https://www.peakbagger.com/list/list.aspx?lid=5051' as const;

/** Exact URL of the saved completion overlay page (frozen §1, S3). */
export const PB_OVERLAY_CANONICAL_URL =
  'https://www.peakbagger.com/list/list.aspx?lid=5051&cid=30050' as const;

/** Peakbagger list source id (lid=5051). */
export const PB_LIST_SOURCE_ID = 'lid-5051' as const;
/** Peakbagger completion-overlay source id (cid=30050). */
export const PB_OVERLAY_SOURCE_ID = 'cid-30050' as const;

/**
 * One peak row as listed on Peakbagger, in lid=5051 source order.
 *
 * `*_raw` fields are preserved UNCHANGED from the snapshot; they are never
 * normalized or reformatted. The snapshot exposes no coordinates and no
 * summit class, so this record deliberately carries neither (frozen §5:
 * "coordinates where the snapshot exposes them" — it does not).
 */
export interface PbRow {
  /** 1-based index in lid=5051 source order (the authoritative list order). */
  pb_order: number;
  /**
   * Printed rank cell, verbatim as a number. Peakbagger ties ranks for equal
   * elevations (e.g. two "196." rows), so `pb_order` — not the printed rank —
   * is the list key.
   */
  pb_rank: number;
  /** Peakbagger internal peak id (`peak.aspx?pid=`), as a string. */
  pb_id: string;
  /** Peak name exactly as printed on the list page. */
  name: string;
  /** Printed Peakbagger section label, verbatim (e.g. "04. Corcoran to Whitney"). */
  section_label: string;
  /** Peakbagger section number (1..24), derived from the label prefix. */
  pb_section: number;
  /** Elevation exactly as listed (e.g. "14,500.7"). */
  elevation_raw: string;
  /** Level-5 range name exactly as listed (e.g. "Mount Whitney Group"). */
  range: string;
  /** Peakbagger level-5 range id (`range.aspx?rid=`), as a string. */
  range_id: string;
  /** Prominence exactly as listed (e.g. "1,081.0"). */
  prominence_raw: string;
  /** Total public ascent count, exactly as listed (digits only). */
  ascents: number;
}

/**
 * One entry of data/crosswalk.json (frozen §2). Explicit 1:1 mapping between
 * a stable canonical SPS id and its Peakbagger key. ALL joins go through this
 * file; name-only joins are prohibited.
 */
export interface CrosswalkEntry {
  /** Stable canonical id, e.g. `spk-4.7`. */
  sps_id: string;
  /** 1-based lid=5051 source-order index of the matching peak. */
  pb_order: number;
  /** Peakbagger internal peak id. */
  pb_id: string;
  /** SPS name verbatim from the 29th Edition row. */
  sps_name: string;
  /** Peakbagger name verbatim from the lid=5051 snapshot. */
  pb_name: string;
  /**
   * Why the two spellings differ; `null` when identical verbatim.
   * Recorded so future re-crosswalks can audit every non-trivial match
   * (e.g. N/S variant suffixes, "Mt"/"Mount" notation, "Devil's Crag #1" vs
   * "Devils Crags").
   */
  alias_note: string | null;
}

/** The committed crosswalk document. */
export interface CrosswalkDoc {
  version: number;
  note: string;
  /** Exactly 247 one-to-one entries covering every active SPS row. */
  entries: CrosswalkEntry[];
}

/** One real, already-public completion from the cid=30050 overlay. */
export interface Completion {
  /** Stable canonical id resolved through data/crosswalk.json. */
  sps_id: string;
  /** Peak name exactly as printed on the overlay row. */
  name: string;
  /** Public ascent date exactly as printed (YYYY-MM-DD). */
  date: string;
  /** Multi-ascent day marker letter exactly as printed ("a"/"b"), else null. */
  day_suffix: string | null;
  /** Overlay's raw provenance reference: pb_order + pb_id + ascent link id. */
  pb_ref: {
    pb_order: number;
    pb_id: string;
    ascent_id: string;
  };
}

/** The committed completion-overlay document. */
export interface CompletionDoc {
  source_id: string;
  canonical_url: string;
  parser_version: string;
  note: string;
  /** One entry per ascent link present in the overlay (30 for 2026-08-22). */
  completions: Completion[];
}
