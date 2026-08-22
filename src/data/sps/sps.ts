/**
 * Deterministic importer + hard-fail validator for the vendored SPS 29th
 * Edition (January 2025) TSV snapshot.
 *
 * Input : snapshots/sierraclub/sp-s-29-2025/sps-list-29th-2025.tsv
 * Output: a normalized SPS source dataset (data/sps/sp-s-29-2025.json) with
 *         exactly 248 rows: 247 active + 1 suspended (Pilot Knob, 1.1).
 *
 * Faithfulness rules (frozen, docs/data-contract.md §4):
 *   * Per row, UNCHANGED from source: sps_section, sps_seq, name,
 *     elevation_raw, class_raw, utm_raw, maps_raw, emblem, mountaineer,
 *     suspended.
 *   * Stable canonical id `spk-<section>.<seq>` assigned once (frozen §2).
 *
 * The module exposes pure functions so tests can exercise both the happy
 * path and every rejection class without touching the committed data files.
 */
import { SPS_SOURCE_ID } from './schema.ts';
import type { SpsArea, SpsRow } from './schema.ts';

/** Validation errors are strings; a non-empty list means the snapshot is unusable. */
export type SpsErrors = string[];

/** Result of parseTsv: either parsed data (errors empty) or a list of errors. */
export type SpsParseResult =
  | { ok: true; areas: SpsArea[]; rows: SpsRow[] }
  | { ok: false; errors: SpsErrors };

/** Row counts pinned by the frozen data contract. */
export const SPS_EXPECTED_ROWS = 248;
export const SPS_EXPECTED_ACTIVE = 247;
export const SPS_EXPECTED_SUSPENDED = 1;
export const SPS_EXPECTED_SECTIONS = 24;

/** Shape of the `@AREA <section> <name>` marker rows. */
const AREA_RE = /^@AREA\t(\d+)\t(.+)$/;
/** Shape of a data row id: `<section>.<seq>`. */
const ROW_ID_RE = /^(\d+)\.(\d+)$/;
/** Elevation exactly as printed: 4–5 digits, optional trailing "+". */
const ELEVATION_RE = /^\d{4,5}\+?$/;
/**
 * Raw class notation exactly as printed: digits and dots, optional "s" +
 * number (e.g. "2s3"), optional trailing "+". Deliberately NOT normalizing.
 */
const CLASS_RE = /^(\d+(\.\d+)?)(s\d+)?\+?$/;
/** UTM 6-figure coordinate as printed. */
const UTM_RE = /^\d{6}$/;
/**
 * Map references as printed: a list of map names and compass hints, e.g.
 * "Mt Kaweah^ Triple Divide Pk(W)" or "Mt Henry( S);SW". Punctuation as
 * observed in the source; no tabs/newlines.
 */
const MAPS_RE = /^[A-Za-z0-9@.\-()^; ]+$/;
/**
 * Peak name as printed (sans emblem/mountaineer markers): letters, digits,
 * spaces and the punctuation observed in the source ("(", ")", "&", "'",
 * "’", "#", "."). Rejects tabs/newlines/whitespace-only by construction.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ()&’#.]*$/;

/**
 * Parse + validate the SPS TSV snapshot text.
 *
 * Hard-fails (returns `ok: false` with the full error list) on:
 *   * duplicate SPS section ids,
 *   * malformed rows (wrong field count, bad id/area shape, out-of-range
 *     section or seq, non-contiguous seq within a section),
 *   * count drift (≠ 248 rows, wrong area count, wrong suspended count),
 *   * malformed raw fields (elevation/class/utm/maps/name that do not match
 *     the source's printed forms),
 *   * inconsistent or out-of-place flags (suspended outside section 1.1,
 *     emblem+mountaineer simultaneously),
 *   * missing frozen fixture anchors (Pilot Knob suspended row; Mount
 *     Emerson class "3").
 */
export function parseTsv(text: string): SpsParseResult {
  const errors: SpsErrors = [];
  const areas: SpsArea[] = [];
  const rows: SpsRow[] = [];

  const sectionNames = new Map<number, string>();
  const seenAreas = new Set<number>();
  const seenIds = new Set<string>();
  const seqsBySection = new Map<number, number[]>();

  const lines = text.split('\n');
  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;

    const am = AREA_RE.exec(line);
    if (am) {
      const section = Number(am[1]);
      const name = am[2].trim();
      if (!/^[A-Z0-9 .&'\u2019\-]+$/.test(name) || name.length === 0) {
        errors.push(`line ${lineNo}: malformed @AREA name: ${JSON.stringify(name)}`);
        continue;
      }
      if (seenAreas.has(section)) {
        errors.push(`line ${lineNo}: duplicate SPS section id ${section} (name ${JSON.stringify(name)})`);
        continue;
      }
      if (section < 1 || section > SPS_EXPECTED_SECTIONS) {
        errors.push(`line ${lineNo}: @AREA section ${section} outside 1..${SPS_EXPECTED_SECTIONS}`);
        continue;
      }
      seenAreas.add(section);
      sectionNames.set(section, name);
      areas.push({ section, name });
      continue;
    }

    // Data row: 9 tab-separated fields.
    const fields = line.split('\t');
    if (fields.length !== 9) {
      errors.push(`line ${lineNo}: malformed row — expected 9 tab-separated fields, got ${fields.length}`);
      continue;
    }
    const [idTok, name, elevation, cls, utm, maps, em, mn, sus] = fields;

    const rm = ROW_ID_RE.exec(idTok);
    if (!rm) {
      errors.push(`line ${lineNo}: malformed row id ${JSON.stringify(idTok)} (expected "<section>.<seq>")`);
      continue;
    }
    const section = Number(rm[1]);
    const seq = Number(rm[2]);
    if (!seenAreas.has(section)) {
      errors.push(`line ${lineNo}: row ${idTok} references undeclared SPS section ${section}`);
      continue;
    }
    if (section < 1 || section > SPS_EXPECTED_SECTIONS) {
      errors.push(`line ${lineNo}: row ${idTok} section ${section} outside 1..${SPS_EXPECTED_SECTIONS}`);
      continue;
    }
    if (seq < 1) {
      errors.push(`line ${lineNo}: row ${idTok} seq ${seq} must be >= 1`);
      continue;
    }
    const spkId = `spk-${idTok}`;
    if (seenIds.has(spkId)) {
      errors.push(`line ${lineNo}: duplicate SPS row id ${JSON.stringify(idTok)}`);
      continue;
    }
    seenIds.add(spkId);

    const flags: Array<[string, string]> = [
      ['emblem', em],
      ['mountaineer', mn],
      ['suspended', sus],
    ];
    let flagOk = true;
    for (const [label, value] of flags) {
      if (value !== '0' && value !== '1') {
        errors.push(`line ${lineNo}: row ${idTok} ${label} flag must be "0" or "1", got ${JSON.stringify(value)}`);
        flagOk = false;
      }
    }
    if (!flagOk) continue;
    if (em === '1' && mn === '1') {
      errors.push(`line ${lineNo}: row ${idTok} has both emblem and mountaineer flags`);
      continue;
    }
    if (sus === '1' && (section !== 1 || seq !== 1)) {
      errors.push(`line ${lineNo}: row ${idTok} is suspended outside SPS section 1.1`);
      continue;
    }

    if (name.length === 0 || !NAME_RE.test(name)) {
      errors.push(`line ${lineNo}: row ${idTok} malformed name ${JSON.stringify(name)}`);
      continue;
    }
    if (!ELEVATION_RE.test(elevation)) {
      errors.push(`line ${lineNo}: row ${idTok} malformed elevation_raw ${JSON.stringify(elevation)}`);
      continue;
    }
    if (!CLASS_RE.test(cls)) {
      errors.push(`line ${lineNo}: row ${idTok} malformed class_raw ${JSON.stringify(cls)}`);
      continue;
    }
    if (utm !== '-' && !UTM_RE.test(utm)) {
      errors.push(`line ${lineNo}: row ${idTok} malformed utm_raw ${JSON.stringify(utm)}`);
      continue;
    }
    if (maps !== '-' && !MAPS_RE.test(maps)) {
      errors.push(`line ${lineNo}: row ${idTok} malformed maps_raw ${JSON.stringify(maps)}`);
      continue;
    }

    const suspended = sus === '1';
    seqsBySection.set(section, [...(seqsBySection.get(section) ?? []), seq]);

    rows.push({
      id: spkId,
      sps_section: section,
      sps_seq: seq,
      area: sectionNames.get(section) ?? '',
      name,
      elevation_raw: elevation,
      class_raw: cls,
      utm_raw: utm === '-' ? '' : utm,
      maps_raw: maps === '-' ? '' : maps,
      emblem: em === '1',
      mountaineer: mn === '1',
      suspended,
    });
  }

  // Section coverage: every section must be declared.
  for (let section = 1; section <= SPS_EXPECTED_SECTIONS; section += 1) {
    if (!seenAreas.has(section)) {
      errors.push(`missing SPS section ${section}`);
    }
  }

  // Count drift.
  const suspended = rows.filter((r) => r.suspended);
  const active = rows.length - suspended.length;
  if (rows.length !== SPS_EXPECTED_ROWS) {
    errors.push(`count drift: expected ${SPS_EXPECTED_ROWS} SPS rows, got ${rows.length}`);
  }
  if (suspended.length !== SPS_EXPECTED_SUSPENDED) {
    errors.push(`suspended count drift: expected ${SPS_EXPECTED_SUSPENDED}, got ${suspended.length}`);
  }
  if (active !== SPS_EXPECTED_ACTIVE) {
    errors.push(`active count drift: expected ${SPS_EXPECTED_ACTIVE}, got ${active}`);
  }
  if (areas.length !== SPS_EXPECTED_SECTIONS) {
    errors.push(`area count drift: expected ${SPS_EXPECTED_SECTIONS} @AREA sections, got ${areas.length}`);
  }

  // Within-section seq must be contiguous 1..n in document order.
  for (const [section, seqs] of seqsBySection) {
    const expected = seqs.map((_, i) => i + 1);
    if (JSON.stringify(seqs) !== JSON.stringify(expected)) {
      errors.push(`section ${section}: seq not contiguous in document order (${seqs.join(', ')})`);
    }
  }

  // Frozen fixture anchors (docs/data-contract.md §8).
  const pk = rows.find((r) => r.sps_section === 1 && r.sps_seq === 1);
  if (!pk || !pk.suspended || !pk.name.startsWith('Pilot Knob')) {
    errors.push('fixture anchor missing: Pilot Knob must be the suspended row at SPS section 1.1');
  }
  const em = rows.find((r) => r.name === 'Mt Emerson' && r.sps_section === 16 && r.sps_seq === 2);
  if (!em || em.class_raw !== '3') {
    errors.push('fixture anchor missing: Mount Emerson must be SPS 16.2 with class_raw "3"');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, areas, rows };
}

/**
 * Deterministic one-line summary of a valid snapshot, used by the CLI
 * (including --dry-run) and by tests.
 */
export function summary(result: Extract<SpsParseResult, { ok: true }>): {
  areas: number;
  rows: number;
  active: number;
  suspended: number;
  emblem: number;
  mountaineer: number;
  utm: number;
} {
  const { rows } = result;
  return {
    areas: result.areas.length,
    rows: rows.length,
    active: rows.reduce((n, r) => n + (r.suspended ? 0 : 1), 0),
    suspended: rows.reduce((n, r) => n + (r.suspended ? 1 : 0), 0),
    emblem: rows.reduce((n, r) => n + (r.emblem ? 1 : 0), 0),
    mountaineer: rows.reduce((n, r) => n + (r.mountaineer ? 1 : 0), 0),
    utm: rows.reduce((n, r) => n + (r.utm_raw !== '' ? 1 : 0), 0),
  };
}

/**
 * Serialize a valid parse result to the deterministic JSON text stored in
 * data/sps/sp-s-29-2025.json (2-space indent, fixed key order, trailing
 * newline). Pure function of its input.
 */
export function toJson(result: Extract<SpsParseResult, { ok: true }>, parserVersion: string): string {
  const doc = {
    source: SPS_SOURCE_HEADER(parserVersion),
    areas: result.areas,
    rows: result.rows,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function SPS_SOURCE_HEADER(parserVersion: string) {
  return {
    source_id: SPS_SOURCE_ID,
    edition: '29th',
    released: 'January 2025',
    parser_version: parserVersion,
    note: 'Sierra Club "Sierra Peaks & Sums" (SPS). Copyrighted source; extracted data fields only, no PDF redistribution. See data/manifest.json for provenance.',
  };
}
