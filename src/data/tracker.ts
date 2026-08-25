/**
 * Pilot 06 — UI data layer for the split-flap tracker.
 *
 * Loads the committed canonical dataset (data/reconciled.json) and derives
 * everything the UI needs. All counts are DERIVED from the data — the 247
 * denominator is never a magic number in the UI. The 247 invariant from the
 * frozen data contract (docs/data-contract.md §1, §8) is re-asserted here so
 * a corrupt/stale dataset fails the build loudly instead of silently
 * rendering the wrong number.
 *
 * The JSON document is imported statically: Astro's bundler inlines it at
 * build time (works in the prerender phase), and in the node:test runtime
 * it is resolved by Node's JSON module loader. No fs I/O at module scope —
 * that path breaks the prerender build.
 */
import reconciledJson from '../../data/reconciled.json' with { type: 'json' };
import type { CanonicalPeak } from './reconcile.ts';
import { SPS_ACTIVE, SPS_SUSPENDED, SPS_TOTAL_ROWS } from '../constants.ts';
import silhouetteManifest from '../../data/silhouettes/manifest.json' with { type: 'json' };

export type Cardinal = 'N' | 'E' | 'S' | 'W';

/** A single committed silhouette asset entry (generator manifest shape). */
export interface SilhouetteEntry {
  peak_id: string;
  sample: { file: string; width: number; height: number };
  /** The manifest-selected outline direction for this peak. */
  selected_direction: Cardinal;
  svg: { path: string; sha256: string };
  elevations: { min_m: number; max_m: number };
}

/** The committed silhouette manifest (generator output). */
export const silhouetteManifestDoc: { manifest_version: number; peaks: SilhouetteEntry[] } =
  silhouetteManifest as { manifest_version: number; peaks: SilhouetteEntry[] };

/**
 * Map from canonical spk id -> { svg path, selected direction } for the
 * peaks that HAVE committed silhouette assets.
 *
 * Each entry exposes exactly the ONE manifest-selected outline (the
 * `selected_direction` svg asset the generator committed). This is the single
 * source of truth the UI uses to decide "show silhouette vs. neutral
 * placeholder" (frozen §6 / silhouettes.md: no fake ridges). The test suite
 * re-asserts this against the `public/silhouettes/` tree.
 */
export interface SilhouetteOutline {
  /** Relative path of the committed svg asset for the selected direction. */
  path: string;
  /** The manifest-selected direction this outline was rendered from. */
  direction: Cardinal;
}
export const silhouettesById: Map<string, SilhouetteOutline> = (() => {
  const m = new Map<string, SilhouetteOutline>();
  for (const entry of silhouetteManifestDoc.peaks) {
    m.set(entry.peak_id, {
      path: entry.svg.path,
      direction: entry.selected_direction,
    });
  }
  return m;
})();

/**
 * The canonical pilot-peak ids that carry silhouette assets. Derived from
 * the committed manifest, never hardcoded.
 */
export const PILOT_SILHOUETTE_IDS: string[] = [...silhouettesById.keys()].sort();

/**
 * True only for peaks with committed, terrain-derived silhouette assets.
 * Every other peak must render an honest neutral placeholder.
 */
export function hasSilhouette(spsId: string): boolean {
  return silhouettesById.has(spsId);
}

/** The reconciled document as committed to data/reconciled.json. */
export interface ReconciledDoc {
  source_id: string;
  edition: string;
  parser_version: string;
  note: string;
  counts: {
    sps_total: number;
    sps_active: number;
    sps_suspended: number;
    peakbagger_rows: number;
    crosswalk_entries: number;
    completions: number;
    canonical_active: number;
  };
  peaks: CanonicalPeak[];
}

/** The committed document, typed and cached for the UI layer. */
const doc: ReconciledDoc = reconciledJson as ReconciledDoc;

/** A peak grouped under its SPS area, in SPS document order. */
export interface PeakGroup {
  /** SPS section id (1..24). */
  section: number;
  /** SPS area name verbatim (uppercase, as printed in the source). */
  area: string;
  peaks: CanonicalPeak[];
}

/** Filter state for the board. */
export interface BoardFilters {
  /** Substring match against SPS and Peakbagger names (case-insensitive). */
  query?: string;
  /** SPS section id to restrict to, or null for all. */
  section: number | null;
  /** Which completion state to show. */
  status: 'all' | 'done' | 'todo';
}

/** A peak enriched with UI-facing labels and computed state. */
export interface DisplayPeak {
  sps_id: string;
  section: number;
  sps_seq: number;
  area: string;
  sps_name: string;
  pb_name: string;
  sps_elevation_raw: string;
  sps_class_raw: string;
  pb_elevation_raw: string;
  pb_range: string;
  /** 1-based SPS document position (stable, never changes). */
  displayOrder: number;
  /** Stable anchor id usable for deep links. */
  slug: string;
  done: boolean;
  completionDate: string | null;
  completionDaySuffix: string | null;
}

/** The 247 active peaks in SPS document order. */
export const peaks: CanonicalPeak[] = doc.peaks;

/** Progress summary derived entirely from committed data. */
export const summary: {
  total: number;
  done: number;
  remaining: number;
  percent: number;
} = (() => {
  const total = peaks.length;
  const done = peaks.filter((p) => p.completion !== null).length;
  const remaining = total - done;
  const percent = total === 0 ? 0 : Math.round((done / total) * 1000) / 10;
  return { total, done, remaining, percent };
})();

/** The 24 SPS areas in document order, each with its peaks. */
export const groups: PeakGroup[] = buildGroups(peaks);

/**
 * The frozen invariants re-asserted at build time. Any drift (a new edition
 * of SPS, a padded dataset, a reconciler bug) fails `astro check`/build
 * immediately instead of rendering a subtly wrong denominator.
 */
export function assertInvariants(data: CanonicalPeak[] = peaks): string[] {
  const errors: string[] = [];
  if (data.length !== SPS_ACTIVE) {
    errors.push(`active peak count ${data.length} != ${SPS_ACTIVE}`);
  }
  if (doc.counts.canonical_active !== SPS_ACTIVE) {
    errors.push(
      `reconciled count ${doc.counts.canonical_active} != ${SPS_ACTIVE} (denominator drift)`,
    );
  }
  if (doc.counts.sps_active !== SPS_ACTIVE || doc.counts.sps_suspended !== SPS_SUSPENDED ||
      doc.counts.sps_total !== SPS_TOTAL_ROWS) {
    errors.push('SPS source counts no longer match the frozen contract');
  }
  const ids = new Set<string>();
  for (const p of data) {
    if (ids.has(p.sps_id)) errors.push(`duplicate canonical id ${p.sps_id}`);
    ids.add(p.sps_id);
  }
  return errors;
}

export function buildGroups(data: CanonicalPeak[]): PeakGroup[] {
  const map = new Map<number, PeakGroup>();
  for (const p of data) {
    let g = map.get(p.sps_section);
    if (!g) {
      g = { section: p.sps_section, area: p.area, peaks: [] };
      map.set(p.sps_section, g);
    }
    g.peaks.push(p);
  }
  return [...map.values()].sort((a, b) => a.section - b.section);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function toDisplayPeaks(data: CanonicalPeak[] = peaks): DisplayPeak[] {
  return data.map((p, i) => ({
    sps_id: p.sps_id,
    section: p.sps_section,
    sps_seq: p.sps_seq,
    area: p.area,
    sps_name: p.sps_name,
    pb_name: p.pb_name,
    sps_elevation_raw: p.sps_elevation_raw,
    sps_class_raw: p.sps_class_raw,
    pb_elevation_raw: p.pb_elevation_raw,
    pb_range: p.pb_range,
    displayOrder: i + 1,
    slug: slugify(p.sps_name),
    done: p.completion !== null,
    completionDate: p.completion ? p.completion.date : null,
    completionDaySuffix: p.completion ? p.completion.day_suffix : null,
  }));
}

export function applyFilters(peaks: DisplayPeak[], f: BoardFilters): DisplayPeak[] {
  const q = (f.query ?? '').trim().toLowerCase();
  return peaks.filter((p) => {
    if (f.section !== null && p.section !== f.section) return false;
    if (f.status === 'done' && !p.done) return false;
    if (f.status === 'todo' && p.done) return false;
    if (q) {
      const hay = `${p.sps_name} ${p.pb_name} ${p.area} ${p.sps_id} ${p.pb_range}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Human-readable climbing-class label without altering the raw notation. */
export function classLabel(raw: string): string {
  if (!raw) return '—';
  return raw;
}

/**
 * Compass view labels for the peak detail page. The SPS 29th Edition source
 * and the Peakbagger lid=5051 snapshot expose NO per-face view geometry (the
 * contract preserves "coordinates where the snapshot exposes them" — it does
 * not). These are neutral placeholder labels only; the committed silhouette
 * path for a peak is the single manifest-selected outline in
 * `silhouettesById`, not a per-face N/E/S/W set (frozen §6 /
 * silhouettes.md: no fake silhouettes). No invented angles, coordinates, or
 * ridge geometry appear here.
 */
export interface CompassView {
  key: 'N' | 'E' | 'S' | 'W';
  label: string;
  description: string;
}

export const COMPASS_VIEWS: CompassView[] = [
  { key: 'N', label: 'North view', description: 'Placeholder orientation — no view geometry is published for this peak in the current dataset. A real per-face view (angle, approach notes, or terrain profile) will appear here when a licensed geometry source is added; nothing is invented in the meantime.' },
  { key: 'E', label: 'East view', description: 'Placeholder orientation — no view geometry is published for this peak in the current dataset. A real per-face view (angle, approach notes, or terrain profile) will appear here when a licensed geometry source is added; nothing is invented in the meantime.' },
  { key: 'S', label: 'South view', description: 'Placeholder orientation — no view geometry is published for this peak in the current dataset. A real per-face view (angle, approach notes, or terrain profile) will appear here when a licensed geometry source is added; nothing is invented in the meantime.' },
  { key: 'W', label: 'West view', description: 'Placeholder orientation — no view geometry is published for this peak in the current dataset. A real per-face view (angle, approach notes, or terrain profile) will appear here when a licensed geometry source is added; nothing is invented in the meantime.' },
];

export { doc as reconciledDoc };
