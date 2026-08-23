/**
 * Pilot 05 — Canonical dataset reconciliation.
 *
 * This module is the authoritative cross-check for the whole tracker:
 * it reconciles the three committed normalized sources against the frozen
 * contract (docs/data-contract.md §2, §5, §8) and emits a single canonical
 * active dataset of exactly 247 peaks, each carrying BOTH orderings (SPS
 * section/seq and Peakbagger order) plus the owner's public completion when
 * one exists.
 *
 * Inputs (all committed, all previously validated by their own importers):
 *   data/sps/sp-s-29-2025.json    248 SPS rows (247 active + 1 suspended)
 *   data/peakbagger/lid-5051.json 247 active Peakbagger rows
 *   data/peakbagger/cid-30050.json 30 public completions
 *   data/crosswalk.json           explicit 1:1 SPS↔PB mapping (247 entries)
 *
 * The crosswalk is the ONLY join path. Name-only joins are prohibited
 * (frozen §2). Every acceptance criterion of Pilot 05 is enforced here as
 * a hard-fail:
 *   - exactly 247 active app records,
 *   - the suspended Pilot Knob (spk-1.1) retained in source but excluded
 *     from the active dataset,
 *   - every active Peakbagger row maps exactly once,
 *   - every completion resolves to an active canonical id,
 *   - N/S collisions (Sawtooth, Morgan, Stanford, Pyramid, Pilot Knob) are
 *     distinguished by section id,
 *   - no duplicates, no missing canonical rows, no unknown completion
 *     references, no prototype (design-mock) dates.
 *
 * The module exposes pure functions so tests can exercise the happy path
 * and every rejection class without touching the committed data files.
 */
import type { SpsRow, SpsArea } from './sps/schema.ts';
import type { PbRow, Completion, CrosswalkEntry } from './peakbagger/schema.ts';
import { PROTOTYPE_DATES } from './peakbagger/pb.ts';

/** One canonical active peak record — SPS + Peakbagger + completion merged. */
export interface CanonicalPeak {
  /** Stable canonical id, e.g. `spk-4.7` (frozen §2). */
  sps_id: string;
  /** SPS section id. */
  sps_section: number;
  /** 1-based within-section SPS row index. */
  sps_seq: number;
  /** SPS area name verbatim. */
  area: string;
  /** SPS name verbatim. */
  sps_name: string;
  /** SPS elevation exactly as printed. */
  sps_elevation_raw: string;
  /** SPS raw class notation exactly as printed (never normalized). */
  sps_class_raw: string;
  /** Peakbagger name verbatim. */
  pb_name: string;
  /** 1-based lid=5051 source-order index. */
  pb_order: number;
  /** Peakbagger internal peak id. */
  pb_id: string;
  /** Peakbagger elevation exactly as listed. */
  pb_elevation_raw: string;
  /** Peakbagger range name exactly as listed. */
  pb_range: string;
  /**
   * The owner's public completion from cid=30050, or null when the owner
   * has not logged a public ascent for this peak.
   */
  completion:
    | { date: string; day_suffix: string | null; ascent_id: string }
    | null;
}

export type ReconcileErrors = string[];

export type ReconcileResult =
  | { ok: true; peaks: CanonicalPeak[]; counts: ReconcileCounts; collisionFamilies: Record<string, string[]> }
  | { ok: false; errors: ReconcileErrors };

export interface ReconcileCounts {
  sps_total: number;
  sps_active: number;
  sps_suspended: number;
  peakbagger_rows: number;
  crosswalk_entries: number;
  completions: number;
  canonical_active: number;
}

/**
 * The five N/S collision families that the task requires to be handled
 * explicitly. Each lists the SPS names that share the common root and that
 * must resolve to DISTINCT canonical ids by section id (never by name).
 */
export const COLLISION_FAMILIES: Record<string, string[]> = {
  Sawtooth: ['Sawtooth Peak (N)', 'Sawtooth Peak (S)'],
  Morgan: ['Mt Morgan (N)', 'Mt Morgan (S)'],
  Stanford: ['Mt Stanford (N)', 'Mt Stanford (S)'],
  Pyramid: ['Pyramid Peak (N)', 'Pyramid Peak (S)'],
  'Pilot Knob': ['Pilot Knob (S)'],
};

export interface ReconcileInput {
  spsRows: SpsRow[];
  spsAreas: SpsArea[];
  lidRows: PbRow[];
  cidCompletions: Completion[];
  crosswalk: CrosswalkEntry[];
}

/**
 * Reconcile the committed sources into the canonical active dataset.
 *
 * Pure function of its inputs. Returns `{ ok: false, errors }` on ANY
 * contract violation; the caller (CLI / CI) hard-fails on a non-ok result.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const errors: ReconcileErrors = [];
  const { spsRows, spsAreas, lidRows, cidCompletions, crosswalk } = input;

  // ---- 1. Frozen count invariants --------------------------------------
  const spsTotal = spsRows.length;
  const spsSuspended = spsRows.filter((r) => r.suspended);
  const spsActiveRows = spsRows.filter((r) => !r.suspended);
  if (spsTotal !== 248) errors.push(`SPS total row count ${spsTotal} != 248`);
  if (spsSuspended.length !== 1) errors.push(`SPS suspended count ${spsSuspended.length} != 1`);
  if (spsActiveRows.length !== 247) errors.push(`SPS active row count ${spsActiveRows.length} != 247`);
  if (spsAreas.length !== 24) errors.push(`SPS area count ${spsAreas.length} != 24`);
  if (lidRows.length !== 247) errors.push(`Peakbagger lid=5051 row count ${lidRows.length} != 247`);
  if (crosswalk.length !== 247) errors.push(`crosswalk entry count ${crosswalk.length} != 247`);

  // Suspended row must be Pilot Knob at section 1.1.
  if (spsSuspended.length === 1) {
    const pk = spsSuspended[0];
    if (pk.sps_section !== 1 || pk.sps_seq !== 1 || !pk.name.startsWith('Pilot Knob')) {
      errors.push(`suspended row must be Pilot Knob at SPS 1.1, got ${pk.id} (${JSON.stringify(pk.name)})`);
    }
  }

  // ---- 2. Crosswalk integrity (duplicates + coverage) ------------------
  const spsIdSet = new Set<string>();
  const pbOrderSet = new Set<number>();
  const pbIdSet = new Set<string>();
  for (const e of crosswalk) {
    if (spsIdSet.has(e.sps_id)) errors.push(`crosswalk duplicate sps_id ${e.sps_id}`);
    spsIdSet.add(e.sps_id);
    if (pbOrderSet.has(e.pb_order)) errors.push(`crosswalk duplicate pb_order ${e.pb_order}`);
    pbOrderSet.add(e.pb_order);
    if (pbIdSet.has(e.pb_id)) errors.push(`crosswalk duplicate pb_id ${e.pb_id}`);
    pbIdSet.add(e.pb_id);
    if (e.sps_id === 'spk-1.1') errors.push('crosswalk maps suspended Pilot Knob (spk-1.1) to an active row');
  }
  // Every active SPS row must be covered exactly once by the crosswalk.
  for (const r of spsActiveRows) {
    if (!spsIdSet.has(r.id)) errors.push(`missing canonical crosswalk row for SPS ${r.id} (${JSON.stringify(r.name)})`);
  }
  // Every active Peakbagger row must be covered exactly once.
  for (const p of lidRows) {
    if (!pbOrderSet.has(p.pb_order)) errors.push(`crosswalk missing Peakbagger row pb_order ${p.pb_order} (${JSON.stringify(p.name)})`);
  }

  // ---- 3. N/S collision families resolve by section id ------------------
  const collisionFamilies: Record<string, string[]> = {};
  for (const [family, names] of Object.entries(COLLISION_FAMILIES)) {
    const ids: string[] = [];
    for (const name of names) {
      const entry = crosswalk.find((e) => e.sps_name === name);
      const row = spsActiveRows.find((r) => r.name === name) ?? spsSuspended.find((r) => r.name === name);
      if (!row) {
        errors.push(`collision family ${JSON.stringify(family)}: SPS row ${JSON.stringify(name)} not found in source`);
        continue;
      }
      // A suspended member (Pilot Knob) must NOT appear in the crosswalk.
      if (row.suspended) {
        if (entry) errors.push(`collision family ${JSON.stringify(family)}: suspended ${row.id} must not map to an active row`);
        continue;
      }
      if (!entry) {
        errors.push(`collision family ${JSON.stringify(family)}: ${JSON.stringify(name)} (${row.id}) not mapped in crosswalk`);
        continue;
      }
      if (entry.sps_id !== row.id) {
        errors.push(`collision family ${JSON.stringify(family)}: ${JSON.stringify(name)} crosswalk points to ${entry.sps_id}, expected ${row.id}`);
      }
      ids.push(entry.sps_id);
    }
    collisionFamilies[family] = ids;
    if (new Set(ids).size !== ids.length) {
      errors.push(`collision family ${JSON.stringify(family)}: members resolved to duplicate canonical ids (${ids.join(', ')})`);
    }
  }

  // ---- 4. Completion reconciliation -------------------------------------
  const activeIdSet = new Set(spsActiveRows.map((r) => r.id));
  const byOrder = new Map(crosswalk.map((e) => [e.pb_order, e]));
  const seenCompletion = new Set<string>();
  const completionsBySps = new Map<string, Completion>();
  for (const c of cidCompletions) {
    if (!activeIdSet.has(c.sps_id)) {
      errors.push(`completion for ${c.sps_id} (${JSON.stringify(c.name)}) does not reference an active canonical id`);
      continue;
    }
    const entry = byOrder.get(c.pb_ref.pb_order);
    if (!entry) {
      errors.push(`completion for ${c.sps_id} has unknown crosswalk reference pb_order ${c.pb_ref.pb_order}`);
      continue;
    }
    if (entry.sps_id !== c.sps_id) {
      errors.push(`completion for ${c.sps_id} has crosswalk mismatch: pb_order ${c.pb_ref.pb_order} -> ${entry.sps_id}`);
      continue;
    }
    if (entry.pb_id !== c.pb_ref.pb_id) {
      errors.push(`completion for ${c.sps_id} has pb_id mismatch (${entry.pb_id} vs ${c.pb_ref.pb_id})`);
    }
    if (PROTOTYPE_DATES.includes(c.date)) {
      errors.push(`completion for ${c.sps_id} carries prototype/mock date ${c.date} (frozen §6: design-mock dates are prohibited)`);
      continue;
    }
    const key = `${c.sps_id}\u0000${c.date}\u0000${c.day_suffix ?? ''}`;
    if (seenCompletion.has(key)) {
      errors.push(`duplicate completion for ${c.sps_id} on ${c.date}${c.day_suffix ? ' ' + c.day_suffix : ''}`);
      continue;
    }
    seenCompletion.add(key);
    completionsBySps.set(c.sps_id, c);
  }

  // ---- 5. Assemble the canonical active dataset (247) ------------------
  // Join SPS active rows to Peakbagger rows via the crosswalk (the ONLY path).
  const lidByOrder = new Map(lidRows.map((p) => [p.pb_order, p]));
  const peaks: CanonicalPeak[] = [];
  for (const r of spsActiveRows) {
    const entry = crosswalk.find((e) => e.sps_id === r.id);
    if (!entry) {
      // Already reported in step 2; skip so we don't double-report.
      continue;
    }
    const pb = lidByOrder.get(entry.pb_order);
    if (!pb) {
      errors.push(`canonical build: crosswalk ${r.id} -> pb_order ${entry.pb_order} has no Peakbagger row`);
      continue;
    }
    const comp = completionsBySps.get(r.id) ?? null;
    peaks.push({
      sps_id: r.id,
      sps_section: r.sps_section,
      sps_seq: r.sps_seq,
      area: r.area,
      sps_name: r.name,
      sps_elevation_raw: r.elevation_raw,
      sps_class_raw: r.class_raw,
      pb_name: pb.name,
      pb_order: entry.pb_order,
      pb_id: entry.pb_id,
      pb_elevation_raw: pb.elevation_raw,
      pb_range: pb.range,
      completion: comp ? { date: comp.date, day_suffix: comp.day_suffix, ascent_id: comp.pb_ref.ascent_id } : null,
    });
  }
  if (peaks.length !== 247) {
    errors.push(`canonical active dataset size ${peaks.length} != 247`);
  }
  // Duplicate canonical ids in the assembled dataset.
  const assembledIds = new Set<string>();
  for (const p of peaks) {
    if (assembledIds.has(p.sps_id)) errors.push(`canonical dataset has duplicate id ${p.sps_id}`);
    assembledIds.add(p.sps_id);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    peaks,
    counts: {
      sps_total: spsTotal,
      sps_active: spsActiveRows.length,
      sps_suspended: spsSuspended.length,
      peakbagger_rows: lidRows.length,
      crosswalk_entries: crosswalk.length,
      completions: cidCompletions.length,
      canonical_active: peaks.length,
    },
    collisionFamilies,
  };
}

/**
 * Deterministic JSON text for the canonical active dataset (data/reconciled.json).
 * Pure function of its input (2-space indent, fixed key order, trailing newline).
 */
export function reconcileToJson(result: Extract<ReconcileResult, { ok: true }>, parserVersion: string): string {
  const doc = {
    source_id: 'reconciled-canonical',
    edition: 'SPS 29th Edition (Jan 2025) × Peakbagger lid=5051 @2026-08-22',
    parser_version: parserVersion,
    note: 'Authoritative canonical active dataset: 247 peaks, each carrying both SPS and Peakbagger orderings, joined ONLY through data/crosswalk.json. Suspended Pilot Knob (spk-1.1) excluded. Completion = owner public ascent from cid=30050 when present. See docs/reconciliation-report.md.',
    counts: result.counts,
    peaks: result.peaks,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
