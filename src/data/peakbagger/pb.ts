/**
 * Deterministic importer + hard-fail validator for the vendored Peakbagger
 * snapshots (Pilot 04).
 *
 * Inputs : snapshots/peakbagger/lid-5051/2026-08-22/lid-5051.html
 *          snapshots/peakbagger/cid-30050/2026-08-22/cid-30050.html
 * Outputs: data/peakbagger/lid-5051.json     (247 rows, source order)
 *          data/crosswalk.json               (247 explicit 1:1 SPS↔PB entries)
 *          data/peakbagger/cid-30050.json    (real public completions only)
 *
 * Faithfulness rules (frozen, docs/data-contract.md §2, §5):
 *   * Per row, UNCHANGED from the snapshot: name, section label, elevation,
 *     range, prominence, ascents, pb_id, pb_order (source order).
 *   * No coordinates: the lid=5051 list page exposes none, so the canonical
 *     record carries none (frozen §5: "coordinates where the snapshot exposes
 *     them" — it does not).
 *   * The crosswalk is an EXPLICIT 1:1 mapping keyed by SPS section id +
 *     unique in-section name match, plus a recorded alias note for every
 *     non-verbatim spelling pair. Name-only joins across sections are
 *     PROHIBITED; every match is scoped to a single SPS section and must be
 *     bijective (247 ↔ 247).
 *   * Completions: only ascent links actually present in the cid=30050
 *     snapshot. Each resolves to a canonical active `spk-` id via the
 *     crosswalk, keeping pb_order/pb_id/ascent_id as provenance. Hard-fail on
 *     unknown references, duplicate ids, malformed dates, count drift, and
 *     prototype (design-mock) dates.
 *
 * The module exposes pure functions so tests can exercise both the happy
 * path and every rejection class without touching the committed data files.
 */
import type { SpsRow, SpsArea } from '../sps/schema.ts';

import type {
  PbRow,
  CrosswalkEntry,
  CrosswalkDoc,
  Completion,
  CompletionDoc,
} from './schema.ts';

/** Validation errors are strings; a non-empty list means the input is unusable. */
export type PbErrors = string[];

/** Parse result for the lid=5051 list snapshot. */
export type PbListResult =
  | { ok: true; rows: PbRow[] }
  | { ok: false; errors: PbErrors };

/** Parse result for the cid=30050 overlay snapshot (row-level only). */
export type PbDated = {
  pb_order: number;
  pb_id: string;
  name: string;
  date: string;
  day_suffix: string | null;
  ascent_id: string;
};

export type PbOverlayResult =
  | { ok: true; rows: PbRow[]; dated: PbDated[] }
  | { ok: false; errors: PbErrors };

/** Row counts pinned by the frozen data contract (frozen §1, §5, §8). */
export const PB_EXPECTED_ROWS = 247;
export const PB_EXPECTED_SECTIONS = 24;

/**
 * Known prototype / sample dates from the attached design mock
 * (frozen §6: the mock is visual direction ONLY). These values must never
 * appear in committed completion data. The mock is intentionally not stored
 * in the repo; its 12 exact sample dates (from SPS Split-Flap Board.dc.html)
 * are pinned here as rejection fixtures only.
 */
export const PROTOTYPE_DATES: string[] = [
  '2017-05-27',
  '2018-09-22',
  '2019-08-14',
  '2020-06-28',
  '2021-07-03',
  '2022-08-05',
  '2023-07-19',
  '2023-07-20',
  '2024-08-02',
  '2024-08-03',
  '2025-07-11',
  '2025-08-09',
];

/** Shape of one data row: 7 or 8 `<td>` cells, first cell a printed rank. */
const ROW_RE =
  /<tr><td>(\d+)\.<\/td><td><a href="peak\.aspx\?pid=(\d+)">(.*?)<\/a><\/td><td>(.*?)<\/td><td[^>]*>(.*?)<\/td><td><a href="range\.aspx\?rid=(\d+)">(.*?)<\/a><\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td>(?:<td>(.*?)<\/td>)?<\/tr>/g;

/** Shape of a dated last cell in the overlay. */
const DATED_CELL_RE =
  /^<a href="climber\/ascent\.aspx\?aid=(\d+)">(\d{4}-\d{2}-\d{2})(?: ([a-z]))?<\/a>$/;
/** Shape of an empty last cell in the overlay. */
const EMPTY_CELL_RE = /^&nbsp;$/;

/** Calendar date sanity (real month/day; 20th–21st century). */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isValidCalendarDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  const dim = [31, mo === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : 31, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d < 1 || d > dim) return false;
  return y >= 1900 && y <= 2100;
}

/** Peakbagger printed name: letters, digits, spaces and light punctuation. */
const PB_NAME_RE = /^[A-Z][A-Za-z0-9 .'\u2019#-]*$/;
/**
 * Elevation / prominence exactly as listed, allowing Peakbagger's
 * "hidden-integer" rendering: some whole-number values are printed as
 * `10,081<span style="visibility: hidden;">.0</span>` (the `.0` sits in a
 * zero-opacity inline span so the page shows "10,081"). The hidden span is
 * markup, not data — it is stripped before the value is matched, and the
 * preserved raw value keeps the printed decimal (`"10,081.0"`).
 */
const PB_HIDDEN_DESIGN_RE = /<span[^>]*>\.0<\/span>/g;
/**
 * Elevation exactly as listed: 4-digit or smaller integer part, no comma
 * (e.g. "9987.5"), or 5 digits comma-grouped (e.g. "14,500.7"); always one
 * decimal digit.
 */
const PB_ELEVATION_RE = /^(\d{1,4}\.\d|\d{1,2},\d{3}\.\d)$/;
/** Prominence exactly as listed — same printed form as elevation. */
const PB_PROMINENCE_RE = PB_ELEVATION_RE;
/** Section label exactly as listed: two-digit prefix + " " + text. */
const PB_SECTION_RE = /^(\d{2})\. [A-Za-z][A-Za-z0-9 '&-]*$/;
/** Total ascent count: digits only (list-page column is always numeric). */
const PB_ASCENTS_RE = /^\d+$/;
/** Range name: letters, digits, spaces, hyphens. */
const PB_RANGE_RE = /^[A-Za-z][A-Za-z0-9 -]*$/;

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Remove tags and un-escape entities; trim. Pure. */
export function clean(s: string): string {
  // Peakbagger hides whole-number ".0" decimals in a visibility:hidden span
  // (`10,081<span style="visibility: hidden;">.0</span>`); strip the markup but
  // keep the printed decimal so the raw value stays "10,081.0".
  const noHidden = s.replace(PB_HIDDEN_DESIGN_RE, '.0');
  return unescapeHtml(noHidden.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse + validate the lid=5051 list snapshot text.
 *
 * The printed rank is Peakbagger's competition ranking by elevation: equal
 * elevations share a rank and the next distinct elevation skips it (the
 * 2026-08-22 snapshot has exactly one tie: two "196." rows at 11,513.4). The
 * list key is therefore the 1-based position `pb_order`, never the printed
 * rank; the rank cell is validated only as a well-formed non-decreasing
 * competition rank.
 *
 * Hard-fails (returns `ok: false`) on:
 *   * count drift (≠ 247 rows),
 *   * duplicate pb_ids or duplicate (section, name) pairs,
 *   * malformed cells (rank not a non-decreasing competition rank, bad
 *     pid/elevation/prominence/ascents/section/range shapes, missing 7th
 *     cell, content in a list-row 8th cell),
 *   * section coverage (must be exactly sections 01..24, all present).
 */
export function parseList(text: string): PbListResult {
  const errors: PbErrors = [];
  const rows: PbRow[] = [];
  const seenPids = new Set<string>();
  const seenKeys = new Set<string>();

  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let prevRank = 0;
  let prevElev = '';
  while ((m = ROW_RE.exec(text)) !== null) {
    const order = rows.length + 1;
    const rank = Number(m[1]);
    const pid = m[2];
    const name = clean(m[3]);
    const sectionLabel = clean(m[4]);
    const elevation = clean(m[5]);
    const rangeId = m[6];
    const range = clean(m[7]);
    const prominence = clean(m[8]);
    const ascents = clean(m[9]);
    const extra = m[10];

    // Competition rank: row p carries rank p, or the previous row's rank
    // (a tie — which must then share the previous row's elevation exactly).
    if (rank !== order && rank !== prevRank) {
      errors.push(`row ${order}: printed rank ${rank} is not a valid competition rank (expected ${order} or previous rank ${prevRank})`);
    }
    if (rank === prevRank && prevRank !== 0 && elevation !== prevElev) {
      errors.push(`row ${order}: tied rank ${rank} but elevation ${JSON.stringify(elevation)} differs from previous row ${JSON.stringify(prevElev)}`);
    }
    if (!/^\d+$/.test(pid)) {
      errors.push(`row ${order}: malformed pb_id ${JSON.stringify(pid)}`);
    }
    if (seenPids.has(pid)) {
      errors.push(`row ${order}: duplicate pb_id ${pid}`);
    }
    seenPids.add(pid);
    if (!PB_NAME_RE.test(name)) {
      errors.push(`row ${order}: malformed name ${JSON.stringify(name)}`);
    }
    const sm = PB_SECTION_RE.exec(sectionLabel);
    if (!sm) {
      errors.push(`row ${order}: malformed section label ${JSON.stringify(sectionLabel)}`);
    }
    if (!PB_ELEVATION_RE.test(elevation)) {
      errors.push(`row ${order}: malformed elevation_raw ${JSON.stringify(elevation)}`);
    }
    if (!/^\d+$/.test(rangeId)) {
      errors.push(`row ${order}: malformed range_id ${JSON.stringify(rangeId)}`);
    }
    if (!PB_RANGE_RE.test(range)) {
      errors.push(`row ${order}: malformed range ${JSON.stringify(range)}`);
    }
    if (!PB_PROMINENCE_RE.test(prominence)) {
      errors.push(`row ${order}: malformed prominence_raw ${JSON.stringify(prominence)}`);
    }
    if (!PB_ASCENTS_RE.test(ascents)) {
      errors.push(`row ${order}: malformed ascents ${JSON.stringify(ascents)}`);
    }
    if (extra !== undefined && extra !== null) {
      if (EMPTY_CELL_RE.test(extra.trim())) {
        // Tolerate an empty overlay-style cell; content in a list row is drift.
      } else {
        errors.push(`row ${order}: unexpected 8th cell content in list snapshot: ${JSON.stringify(extra)}`);
      }
    }
    if (errors.length > 0) continue;

    const key = `${sectionLabel}\u0000${name}`;
    if (seenKeys.has(key)) {
      errors.push(`row ${order}: duplicate (section, name) ${JSON.stringify(key.replace('\u0000', ' / '))}`);
      continue;
    }
    seenKeys.add(key);

    rows.push({
      pb_order: order,
      pb_rank: rank,
      pb_id: pid,
      name,
      section_label: sectionLabel,
      pb_section: Number(sm!.slice(1)[0]),
      elevation_raw: elevation,
      range,
      range_id: rangeId,
      prominence_raw: prominence,
      ascents: Number(ascents),
    });
    prevRank = rank;
    prevElev = elevation;
  }

  if (rows.length !== PB_EXPECTED_ROWS) {
    errors.push(`count drift: expected ${PB_EXPECTED_ROWS} lid=5051 rows, got ${rows.length}`);
  }
  const sections = new Set(rows.map((r) => r.pb_section));
  if (sections.size !== PB_EXPECTED_SECTIONS) {
    errors.push(`section drift: expected ${PB_EXPECTED_SECTIONS} sections, got ${sections.size}`);
  } else {
    for (let i = 1; i <= PB_EXPECTED_SECTIONS; i += 1) {
      if (!sections.has(i)) errors.push(`missing Peakbagger section ${i}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rows };
}

/**
 * Parse + validate the cid=30050 overlay snapshot text.
 *
 * The overlay is the lid=5051 table with one extra column (Ascent Date).
 * The same 247 rows must appear in the same order; each last cell is either
 * `&nbsp;` (no public completion) or a single ascent link with a real date.
 *
 * Hard-fails on: row-order drift vs the lid=5051 table shape, duplicate
 * pids, a missing last cell, a last cell that is neither empty nor a valid
 * dated ascent link, malformed ascent dates, and count drift.
 */
export function parseOverlay(text: string): PbOverlayResult {
  const errors: PbErrors = [];
  const rows: PbRow[] = [];
  const dated: PbDated[] = [];
  const seenPids = new Set<string>();

  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let prevRank = 0;
  let prevElev = '';
  while ((m = ROW_RE.exec(text)) !== null) {
    const order = rows.length + 1;
    const rank = Number(m[1]);
    const pid = m[2];
    const name = clean(m[3]);
    const sectionLabel = clean(m[4]);
    const elevation = clean(m[5]);
    const rangeId = m[6];
    const range = clean(m[7]);
    const prominence = clean(m[8]);
    const ascents = clean(m[9]);
    const last = m[10];

    if (rank !== order && rank !== prevRank) errors.push(`row ${order}: printed rank ${rank} is not a valid competition rank (expected ${order} or previous rank ${prevRank})`);
    if (rank === prevRank && prevRank !== 0 && elevation !== prevElev) errors.push(`row ${order}: tied rank ${rank} but elevation ${JSON.stringify(elevation)} differs from previous row ${JSON.stringify(prevElev)}`);
    if (seenPids.has(pid)) errors.push(`row ${order}: duplicate pb_id ${pid}`);
    seenPids.add(pid);
    if (!PB_NAME_RE.test(name)) errors.push(`row ${order}: malformed name ${JSON.stringify(name)}`);
    if (!PB_SECTION_RE.exec(sectionLabel)) errors.push(`row ${order}: malformed section label ${JSON.stringify(sectionLabel)}`);
    if (!PB_ELEVATION_RE.test(elevation)) errors.push(`row ${order}: malformed elevation_raw ${JSON.stringify(elevation)}`);
    if (!PB_PROMINENCE_RE.test(prominence)) errors.push(`row ${order}: malformed prominence_raw ${JSON.stringify(prominence)}`);
    if (!PB_ASCENTS_RE.test(ascents)) errors.push(`row ${order}: malformed ascents ${JSON.stringify(ascents)}`);
    if (last === undefined || last === null) {
      errors.push(`row ${order}: missing Ascent Date cell`);
      continue;
    }
    const lm = DATED_CELL_RE.exec(last.trim());
    if (lm) {
      if (!isValidCalendarDate(lm[2])) {
        errors.push(`row ${order}: malformed ascent date ${JSON.stringify(lm[2])}`);
        continue;
      }
      dated.push({
        pb_order: order,
        pb_id: pid,
        name,
        date: lm[2],
        day_suffix: lm[3] ?? null,
        ascent_id: lm[1],
      });
    } else if (!EMPTY_CELL_RE.test(last.trim())) {
      errors.push(`row ${order}: Ascent Date cell is neither empty nor a dated ascent link: ${JSON.stringify(last)}`);
      continue;
    }
    if (errors.length > 0) continue;

    rows.push({
      pb_order: order,
      pb_rank: rank,
      pb_id: pid,
      name,
      section_label: sectionLabel,
      pb_section: Number(PB_SECTION_RE.exec(sectionLabel)!.slice(1)[0]),
      elevation_raw: elevation,
      range,
      range_id: rangeId,
      prominence_raw: prominence,
      ascents: Number(ascents),
    });
    prevRank = rank;
    prevElev = elevation;
  }

  if (rows.length !== PB_EXPECTED_ROWS) {
    errors.push(`count drift: expected ${PB_EXPECTED_ROWS} overlay rows, got ${rows.length}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rows, dated };
}

/**
 * Cross-check that the overlay's 247 rows are the same peaks in the same
 * order as the lid=5051 list (row order, pid, name, section, elevation,
 * range, ascents). Called by the importer so a mismatched overlay snapshot
 * hard-fails before any crosswalk/completion resolution.
 */
export function overlayMatchesList(overlay: PbRow[], list: PbRow[]): PbErrors {
  const errors: PbErrors = [];
  if (overlay.length !== list.length) {
    errors.push(`overlay row count ${overlay.length} != lid=5051 row count ${list.length}`);
    return errors;
  }
  for (let i = 0; i < overlay.length; i += 1) {
    const a = overlay[i];
    const b = list[i];
    const same =
      a.pb_id === b.pb_id &&
      a.name === b.name &&
      a.section_label === b.section_label &&
      a.elevation_raw === b.elevation_raw &&
      a.range === b.range &&
      a.range_id === b.range_id &&
      a.prominence_raw === b.prominence_raw &&
      a.ascents === b.ascents;
    if (!same) errors.push(`row ${i + 1}: overlay row differs from lid=5051 row`);
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Crosswalk (frozen §2): explicit 1:1 SPS↔PB mapping, bijective.       */
/* ------------------------------------------------------------------ */

/**
 * Deterministic spelling normalizer for matching. Case-insensitive, collapses
 * SPS notation variants ("Mt", "Mtn", "Pk", "Pt", "#1", "(N)"/"(S)" suffixes,
 * " - suffix") to a comparable token set. Used ONLY to find candidates; the
 * committed crosswalk records both verbatim spellings plus an alias note.
 */
export function normalizeName(s: string): string {
  let t = s.replace(/\u2019/g, "'");
  t = t.replace(/\((S|N)\)/g, ' ');
  t = t.replace(/#/g, ' ');
  t = t.toLowerCase();
  t = t.replace(/\bmt\b/g, 'mount');
  t = t.replace(/\bmtn\b/g, 'mountain');
  t = t.replace(/\bpk\b/g, 'peak');
  t = t.replace(/\bpt\b/g, 'point');
  t = t.replace(/\s-\s.*$/, '');
  t = t.replace(/'/g, '');
  t = t.replace(/[^a-z]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/** Token-set equality with optional trailing-s singularization. */
export function tokensMatch(a: string, b: string): boolean {
  const A = new Set(normalizeName(a).split(' ').filter(Boolean));
  const B = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (A.size === B.size) {
    let eq = true;
    for (const t of A) if (!B.has(t)) { eq = false; break; }
    if (eq) return true;
  }
  const sing = (x: string): string => (x.length > 3 && x.endsWith('s') ? x.slice(0, -1) : x);
  const A2 = new Set([...A].map(sing));
  const B2 = new Set([...B].map(sing));
  if (A2.size !== B2.size) return false;
  for (const t of A2) if (!B2.has(t)) return false;
  return true;
}

export type CrosswalkResult =
  | { ok: true; entries: CrosswalkEntry[]; fallbackCount: number }
  | { ok: false; errors: PbErrors };

/**
 * Build the explicit SPS↔Peakbagger crosswalk.
 *
 * Algorithm (deterministic, no global name matching):
 *   1. Group SPS active rows and PB rows by section id (SPS section N ↔
 *      PB section NN). Counts must agree per section (bijective precondition
 *      verified empirically: every section's active-count equals the list's).
 *   2. Within a section, match by normalized name; the match MUST be unique
 *      on both sides (names are unique within each section of both sources).
 *   3. Residuals (one known pair: "Devil's Crag #1" ↔ "Devils Crags") fall
 *      back to token-set singularization; the fallback match MUST still be
 *      unique, and each fallback is recorded with a fallback note.
 *
 * Hard-fails on any non-bijective or ambiguous situation: this is the
 * contract's guard against name-only joins.
 */
export function buildCrosswalk(spsRows: SpsRow[], spsAreas: SpsArea[], listRows: PbRow[]): CrosswalkResult {
  const errors: PbErrors = [];
  const active = spsRows.filter((r) => !r.suspended);
  if (active.length !== PB_EXPECTED_ROWS) {
    errors.push(`SPS active row count ${active.length} != ${PB_EXPECTED_ROWS}`);
  }
  if (listRows.length !== PB_EXPECTED_ROWS) {
    errors.push(`lid=5051 row count ${listRows.length} != ${PB_EXPECTED_ROWS}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const spsBySection = new Map<number, SpsRow[]>();
  for (const r of active) {
    spsBySection.set(r.sps_section, [...(spsBySection.get(r.sps_section) ?? []), r]);
  }
  const pbBySection = new Map<number, PbRow[]>();
  for (const p of listRows) {
    pbBySection.set(p.pb_section, [...(pbBySection.get(p.pb_section) ?? []), p]);
  }

  const entries: CrosswalkEntry[] = [];
  let fallbackCount = 0;

  for (let sec = 1; sec <= PB_EXPECTED_SECTIONS; sec += 1) {
    const srows = spsBySection.get(sec) ?? [];
    const prows = pbBySection.get(sec) ?? [];
    const sArea = spsAreas.find((a) => a.section === sec)?.name ?? '';
    if (srows.length === 0) errors.push(`SPS section ${sec} has no active rows`);
    if (prows.length === 0) errors.push(`Peakbagger section ${sec} has no rows`);
    if (srows.length !== prows.length) {
      errors.push(`section ${sec}: SPS active count ${srows.length} != Peakbagger count ${prows.length} (area ${JSON.stringify(sArea)})`);
      continue;
    }

    const matchedSps = new Set<string>();
    const matchedPb = new Set<number>();
    const secEntries: CrosswalkEntry[] = [];

    // Pass 1: exact normalized-name match, must be unique on both sides.
    for (const p of prows) {
      const cands = srows.filter((r) => !matchedSps.has(r.id) && normalizeName(r.name) === normalizeName(p.name));
      if (cands.length === 1) {
        const r = cands[0];
        matchedSps.add(r.id);
        matchedPb.add(p.pb_order);
        secEntries.push(makeEntry(r, p, null, false));
      }
    }

    // Pass 2 (fallback): token-set singularization on the residuals.
    for (const p of prows) {
      if (matchedPb.has(p.pb_order)) continue;
      const cands = srows.filter((r) => !matchedSps.has(r.id) && tokensMatch(r.name, p.name));
      if (cands.length !== 1) {
        errors.push(`section ${sec}: Peakbagger ${JSON.stringify(p.name)} (pb_order ${p.pb_order}) has ${cands.length} SPS candidate(s); crosswalk must stay 1:1`);
        continue;
      }
      const r = cands[0];
      matchedSps.add(r.id);
      matchedPb.add(p.pb_order);
      fallbackCount += 1;
      secEntries.push(makeEntry(r, p, `fallback token match: SPS ${JSON.stringify(r.name)} ↔ PB ${JSON.stringify(p.name)}`, true));
    }

    for (const r of srows) {
      if (!matchedSps.has(r.id)) errors.push(`section ${sec}: SPS row ${JSON.stringify(r.name)} (${r.id}) unmatched`);
    }
    for (const p of prows) {
      if (!matchedPb.has(p.pb_order)) errors.push(`section ${sec}: Peakbagger row ${JSON.stringify(p.name)} (pb_order ${p.pb_order}) unmatched`);
    }

    entries.push(...secEntries);
  }

  if (entries.length !== PB_EXPECTED_ROWS) {
    errors.push(`crosswalk entry count ${entries.length} != ${PB_EXPECTED_ROWS}`);
  }
  if (new Set(entries.map((e) => e.sps_id)).size !== entries.length) {
    errors.push('crosswalk has duplicate sps_id entries');
  }
  if (new Set(entries.map((e) => e.pb_order)).size !== entries.length) {
    errors.push('crosswalk has duplicate pb_order entries');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries, fallbackCount };
}

function makeEntry(r: SpsRow, p: PbRow, aliasNote: string | null, isFallback: boolean): CrosswalkEntry {
  const note =
    r.name === p.name
      ? null
      : isFallback
        ? aliasNote
        : `spelling variant: SPS ${JSON.stringify(r.name)} ↔ PB ${JSON.stringify(p.name)}`;
  return {
    sps_id: r.id,
    pb_order: p.pb_order,
    pb_id: p.pb_id,
    sps_name: r.name,
    pb_name: p.name,
    alias_note: note,
  };
}

/* ------------------------------------------------------------------ */
/* Completions (frozen §5, §6).                                        */
/* ------------------------------------------------------------------ */

export type CompletionResult =
  | { ok: true; completions: Completion[] }
  | { ok: false; errors: PbErrors };

/**
 * Resolve the overlay's dated rows to canonical completions.
 *
 * Each dated row resolves through the crosswalk (pb_order → sps_id); the
 * suspended Pilot Knob (spk-1.1) maps to no active row and must never
 * appear. Hard-fails on unknown crosswalk references, duplicate (sps_id,
 * date) pairs, and any PROTOTYPE_DATE (design-mock sample date).
 */
export function resolveCompletions(dated: PbDated[], crosswalk: CrosswalkEntry[]): CompletionResult {
  const errors: PbErrors = [];
  const byOrder = new Map(crosswalk.map((e) => [e.pb_order, e]));
  const completions: Completion[] = [];
  const seen = new Set<string>();

  for (const d of dated) {
    const entry = byOrder.get(d.pb_order);
    if (!entry) {
      errors.push(`completion row pb_order ${d.pb_order} (${JSON.stringify(d.name)}) does not resolve through the crosswalk`);
      continue;
    }
    if (entry.sps_id === 'spk-1.1') {
      errors.push(`completion row pb_order ${d.pb_order} resolves to suspended Pilot Knob (spk-1.1), which maps to no active row`);
      continue;
    }
    if (PROTOTYPE_DATES.includes(d.date)) {
      errors.push(`completion for ${entry.sps_id} carries prototype/mock date ${d.date} (frozen §6: design-mock dates are prohibited)`);
      continue;
    }
    const key = `${entry.sps_id}\u0000${d.date}\u0000${d.day_suffix ?? ''}`;
    if (seen.has(key)) {
      errors.push(`duplicate completion for ${entry.sps_id} on ${d.date}${d.day_suffix ? ' ' + d.day_suffix : ''}`);
      continue;
    }
    seen.add(key);
    completions.push({
      sps_id: entry.sps_id,
      name: d.name,
      date: d.date,
      day_suffix: d.day_suffix,
      pb_ref: { pb_order: d.pb_order, pb_id: d.pb_id, ascent_id: d.ascent_id },
    });
  }

  completions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sps_id < b.sps_id ? -1 : 1));

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, completions };
}

/* ------------------------------------------------------------------ */
/* Deterministic serialization (pure functions of their input).        */
/* ------------------------------------------------------------------ */

export function listToJson(rows: PbRow[], parserVersion: string): string {
  const doc = {
    source_id: 'lid-5051',
    canonical_url: 'https://www.peakbagger.com/list/list.aspx?lid=5051',
    parser_version: parserVersion,
    note:
      'Peakbagger lid=5051 list, 247 active peaks in source order. Raw fields preserved verbatim; the list page exposes no coordinates or summit class, so none are carried. See data/manifest.json for provenance.',
    rows,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function crosswalkToJson(entries: CrosswalkEntry[], parserVersion: string): string {
  const doc: CrosswalkDoc = {
    version: 1,
    note:
      'Explicit 1:1 SPS↔Peakbagger mapping (frozen §2): every active SPS row of the 29th Edition is mapped to exactly one lid=5051 row by section id + unique in-section name match; N/S name collisions are distinguished by section id. Suspended Pilot Knob (spk-1.1) intentionally maps to nothing. All joins go through this file; name-only joins across sections are prohibited.',
    entries,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function completionsToJson(completions: Completion[], parserVersion: string): string {
  const doc: CompletionDoc = {
    source_id: 'cid-30050',
    canonical_url: 'https://www.peakbagger.com/list/list.aspx?lid=5051&cid=30050',
    parser_version: parserVersion,
    note:
      "Owner's public Peakbagger completion overlay: only ascent links actually present in the authorized 2026-08-22 snapshot. Dates and day-suffix letters are exactly as public; each record keeps its raw pb_order/pb_id/ascent_id provenance and resolves to a stable spk- id via data/crosswalk.json.",
    completions,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
