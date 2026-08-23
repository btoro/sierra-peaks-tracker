/**
 * Deterministic 3DEP silhouette engine (Pilot 07).
 *
 * This module is a PURE function of (terrain sample, config, parameters). It
 * never touches the filesystem, the network, or the wall clock. Given the
 * same inputs it always emits byte-identical SVG, which is what makes the
 * generated assets reproducible and CI-checkable (frozen §5 "deterministic
 * reproduction").
 *
 * Pipeline (docs/silhouettes.md):
 *   1. readTerrain   — decode a compact little-endian float32 terrain sample
 *                      (a rectangular DEM crop, row-major) into a typed grid.
 *   2. projectView   — for each cardinal direction, walk the grid column/row
 *                      sight lines from the observer outward and keep the
 *                      NEARER-WEIGHTED maximum elevation per horizontal bin.
 *                      Apparent elevation decays with sight distance
 *                      (SIGHT_DECAY per step), so a nearer ridge can occlude a
 *                      farther one even when the farther cell is taller. The
 *                      walk is order-dependent (observer-near first), so N/S
 *                      and E/W skylines are genuinely distinct views. Pure
 *                      local projected coordinates; no external runtime
 *                      references.
 *   3. normalize     — rescale elevations into SVG units. Normalization is
 *                      pinned to the sample's own min/max so the geometry is
 *                      a deterministic function of the terrain alone.
 *   4. smooth        — deterministic uniform box smoothing (integer kernel
 *                      width, fixed endpoints). No randomness, no iteration
 *                      until convergence.
 *   5. buildPath     — emit a CLOSED, valid SVG path (…Z) with coordinates
 *                      rounded to a fixed precision so the bytes are stable.
 *   6. renderSvg     — wrap the closed path in a fixed viewbox.
 *
 * Separation of concerns (frozen contract, docs/silhouettes.md §6):
 *   - terrain-derived geometry = the path (deterministic from the DEM).
 *   - deterministic artistic styling = the fill/stroke/opacity/viewbox chosen
 *     by `artisticStyle()` (a fixed, versioned palette). Styling never feeds
 *     back into geometry; geometry never carries a wall-clock timestamp.
 */

export const VIEWBOX_WIDTH = 1200;
export const VIEWBOX_HEIGHT = 400;
/** Baseline the skyline sits on (SVG y grows downward, so this is near the
 *  bottom of the viewbox, leaving a small margin above for the ridge). */
export const BASELINE_Y = 360;
/**
 * Per-step sight-line falloff factor for the nearer-weighted occlusion
 * projection (see `projectView`). Each step of distance from the observer
 * multiplies a cell's apparent elevation by this factor, so a nearer ridge
 * can occlude a farther one even when the farther cell is taller. The factor
 * is a fixed, versioned engine constant: deterministic, terrain-independent.
 */
export const SIGHT_DECAY = 0.8;
/** Vertical margin reserved above the ridge (viewbox top). */
export const TOP_MARGIN_Y = 30;
/** Elevation coordinate rounding precision (fixed => stable bytes). */
export const PATH_PRECISION = 2;

export type CardinalDirection = 'N' | 'E' | 'S' | 'W';
export const CARDINALS: readonly CardinalDirection[] = ['N', 'E', 'S', 'W'];

/**
 * Observer direction -> the terrain axis the silhouette samples.
 *
 * - 'N': observer looks NORTH. The skyline is a nearer-weighted maximum over
 *   each east-west bin, walking the rows that stand closest to the observer
 *   first (rows with the largest row index are nearest).
 * - 'S': the mirror of 'N' (smallest row index nearest).
 * - 'E': the nearer-weighted maximum of each north-south bin, walking the
 *   columns nearest the observer first (smallest column index nearest).
 * - 'W': the mirror of 'E' (largest column index nearest).
 *
 * Occlusion model (nearer-weighted): the visible skyline is the pointwise max
 * of `elevation * SIGHT_DECAY^distance` along each sight line, where distance
 * is the cell's step index from the observer. Because the weighting decays
 * with distance, the walk is order-dependent: N/S and E/W pairs are no longer
 * commutative, so each cardinal direction yields its own terrain-derived
 * profile. A nearer, tall ridge can now occlude a farther peak; a distant
 * peak still shows when it rises high enough that its decayed apparent
 * elevation exceeds every nearer cell.
 */

export interface TerrainGrid {
  /** Number of columns (x / east-west cells). */
  width: number;
  /** Number of rows (y / north-south cells). */
  height: number;
  /**
   * Elevation (metres) in row-major order: `data[row * width + col]`.
   * `row` 0 is the northern edge, `col` 0 the western edge.
   */
  data: Float32Array;
  /** No-data sentinel (meters); the 3DEP nodata value. */
  nodata: number;
  /** Deterministic source label recorded in the manifest (e.g. a DEM crop id). */
  sourceId: string;
  /** Stable id of the peak the sample is centered on (e.g. `spk-1.7`). */
  peakId: string;
  /** Deterministic source checksum (sha256 of the sample bytes), if known. */
  sourceSha256: string | null;
}

export interface SilhouetteConfig {
  /** Number of horizontal samples the skyline is reduced to. */
  sampleCount: number;
  /** Uniform box-kernel width for smoothing (odd integers keep symmetry). */
  smoothingWindow: number;
  /** Observer directions to render. */
  directions: readonly CardinalDirection[];
  /** Renderer version, recorded in the manifest for reproducibility. */
  rendererVersion: string;
}

export const DEFAULT_CONFIG: SilhouetteConfig = {
  sampleCount: 240,
  smoothingWindow: 3,
  directions: CARDINALS,
  rendererVersion: '1.0.0',
};

export interface SkylinePoint {
  /** Horizontal position in SVG units [0, VIEWBOX_WIDTH]. */
  x: number;
  /** Elevation in SVG units (smaller y = higher). */
  y: number;
}

export interface DirectionResult {
  direction: CardinalDirection;
  points: SkylinePoint[];
  /** Closed, valid SVG path (ends with Z). */
  path: string;
  /** Deterministic sha256 of the closed path string. */
  pathSha256: string;
  /** Minimum terrain elevation used for normalization (metres). */
  minElevation: number;
  /** Maximum terrain elevation used for normalization (metres). */
  maxElevation: number;
}

export interface SilhouetteResult {
  peakId: string;
  sourceId: string;
  rendererVersion: string;
  directions: DirectionResult[];
}

/**
 * Deterministic artistic style (Pilot 07 "styling separation"). Fixed,
 * versioned palette + stroke; no randomness, no wall clock. Styling is chosen
 * ONLY from the peak id (a stable hash) so the same peak always renders the
 * same art treatment, independent of terrain.
 */
export interface ArtisticStyle {
  fill: string;
  stroke: string;
  fillOpacity: number;
  /** 1-based style variant chosen deterministically from the peak id. */
  variant: number;
}

export const ARTISTIC_STYLE_VARIANTS: readonly ArtisticStyle[] = [
  { fill: '#1f2a44', stroke: '#0e1526', fillOpacity: 1, variant: 1 },
  { fill: '#243247', stroke: '#0e1526', fillOpacity: 1, variant: 2 },
  { fill: '#1c2b3a', stroke: '#0b1620', fillOpacity: 1, variant: 3 },
  { fill: '#20263a', stroke: '#101426', fillOpacity: 1, variant: 4 },
];

/** Simple deterministic string hash (FNV-1a, 32-bit) -> stable variant. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic 1-based artistic variant for a peak id (stable across runs). */
export function pickVariant(peakId: string): number {
  const n = ARTISTIC_STYLE_VARIANTS.length;
  return (fnv1a(peakId) % n) + 1;
}

/** Deterministic artistic style for a peak id. */
export function artisticStyle(peakId: string): ArtisticStyle {
  const variant = pickVariant(peakId);
  const idx = variant - 1;
  return ARTISTIC_STYLE_VARIANTS[idx] ?? ARTISTIC_STYLE_VARIANTS[0];
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Fixed-precision rounding so SVG coordinates are byte-stable. */
function round2(n: number): number {
  return Math.round(n * 10 ** PATH_PRECISION) / 10 ** PATH_PRECISION;
}

function formatCoord(n: number): string {
  const r = round2(n);
  // Avoid "-0" in the emitted path.
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Decode a little-endian float32 byte buffer (a compact DEM crop, row-major)
 * into a TerrainGrid. Throws on empty/short buffers.
 */
export function readTerrain(
  bytes: Uint8Array | ArrayBuffer,
  meta: {
    width: number;
    height: number;
    sourceId: string;
    peakId: string;
    sourceSha256?: string;
    nodata?: number;
  },
): TerrainGrid {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  const byteLength = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.byteLength;
  const required = meta.width * meta.height * 4;
  if (meta.width < 1 || meta.height < 1) {
    throw new Error(`readTerrain: invalid grid dimensions ${meta.width}x${meta.height}`);
  }
  if (byteLength < required) {
    throw new Error(
      `readTerrain: buffer ${byteLength} bytes < required ${required} for ${meta.width}x${meta.height}`,
    );
  }
  const data = new Float32Array(buf, 0, meta.width * meta.height);
  return {
    width: meta.width,
    height: meta.height,
    data,
    nodata: meta.nodata ?? -9999,
    sourceId: meta.sourceId,
    peakId: meta.peakId,
    sourceSha256: meta.sourceSha256 ?? null,
  };
}

function isValid(cell: number, nodata: number): boolean {
  return Number.isFinite(cell) && cell !== nodata;
}

/**
 * Walk the grid for a cardinal direction and return the visible skyline as
 * raw elevation samples (metres), one per horizontal bin. The projection is
 * order-dependent (near-to-far) using a nearer-weighted max:
 *
 *   apparent(cell, i) = elevation * SIGHT_DECAY^i   (i = step from observer)
 *
 * where i = 0 is the observer-nearest cell along that sight line. Each bin
 * reports the maximum apparent elevation converted back to metres
 * (apparent / decay^i), so the reported value is still a true elevation but
 * the *winner* is biased toward nearer cells. This makes N ≠ S and E ≠ W on
 * real terrain while remaining a deterministic, terrain-derived function.
 *
 * Nodata cells are skipped (they never occlude).
 */
export function projectView(grid: TerrainGrid, direction: CardinalDirection): number[] {
  const { width, height, data, nodata } = grid;
  const out: number[] = [];

  if (direction === 'N' || direction === 'S') {
    // East-west bins: bin index = column. Sight line runs north-south.
    // 'N': observer to the south looking north => southern rows (high index)
    // are nearest. 'S': northern rows (low index) nearest.
    for (let col = 0; col < width; col += 1) {
      let bestApparent = -Infinity;
      let bestElev = NaN;
      let bestDist = 0;
      for (let i = 0; i < height; i++) {
        const row = direction === 'N' ? height - 1 - i : i;
        const cell = data[row * width + col];
        if (!isValid(cell, nodata)) continue;
        const apparent = cell * Math.pow(SIGHT_DECAY, i);
        if (apparent > bestApparent) {
          bestApparent = apparent;
          bestElev = cell;
          bestDist = i;
        }
      }
      out.push(Number.isFinite(bestApparent) ? bestElev : NaN);
    }
  } else {
    // North-south bins: bin index = row. Sight line runs east-west.
    // 'E': observer to the west looking east => western columns (low index)
    // are nearest. 'W': eastern columns (high index) nearest.
    for (let row = 0; row < height; row += 1) {
      let bestApparent = -Infinity;
      let bestElev = NaN;
      let bestDist = 0;
      for (let i = 0; i < width; i++) {
        const col = direction === 'E' ? i : width - 1 - i;
        const cell = data[row * width + col];
        if (!isValid(cell, nodata)) continue;
        const apparent = cell * Math.pow(SIGHT_DECAY, i);
        if (apparent > bestApparent) {
          bestApparent = apparent;
          bestElev = cell;
          bestDist = i;
        }
      }
      out.push(Number.isFinite(bestApparent) ? bestElev : NaN);
    }
  }
  return out;
}

/** Rescale a skyline (metres) into SVG y units over a pinned min/max. */
function normalizeToY(
  elevations: number[],
  minElev: number,
  maxElev: number,
  baselineY: number,
  topY: number,
): number[] {
  const span = maxElev - minElev;
  const range = baselineY - topY;
  if (span <= 0) {
    // Flat: all points sit on the baseline.
    return elevations.map(() => round2(baselineY));
  }
  return elevations.map((e) => {
    if (!Number.isFinite(e)) return round2(baselineY);
    const t = (e - minElev) / span; // 0..1
    const y = baselineY - t * range;
    return round2(y);
  });
}

/** Deterministic uniform box smoothing (fixed window, clamped ends). */
function smoothBox(values: number[], windowSize: number): number[] {
  const w = windowSize;
  if (w < 1 || values.length === 0) return values.slice();
  const half = Math.floor(w / 2);
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let n = 0;
    for (let k = -half; k <= half; k += 1) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      const v = values[j];
      if (Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    out[i] = n > 0 ? sum / n : values[i];
  }
  return out;
}

/** Build a closed SVG path from (x, y) points. */
export function buildPath(points: SkylinePoint[], baselineY: number): string {
  if (points.length === 0) {
    // Degenerate: a flat closed slab.
    return `M0 ${formatCoord(baselineY)} L${VIEWBOX_WIDTH} ${formatCoord(
      baselineY,
    )} L${VIEWBOX_WIDTH} ${formatCoord(BASELINE_Y)} L0 ${formatCoord(BASELINE_Y)} Z`;
  }
  const parts: string[] = [];
  parts.push(`M0 ${formatCoord(baselineY)}`);
  // Left edge up to the first sample.
  parts.push(`L${formatCoord(points[0].x)} ${formatCoord(points[0].y)}`);
  for (let i = 1; i < points.length; i += 1) {
    parts.push(`L${formatCoord(points[i].x)} ${formatCoord(points[i].y)}`);
  }
  // Right edge down to baseline, then close along the baseline.
  parts.push(`L${VIEWBOX_WIDTH} ${formatCoord(baselineY)}`);
  parts.push(`L${VIEWBOX_WIDTH} ${formatCoord(BASELINE_Y)}`);
  parts.push(`L0 ${formatCoord(BASELINE_Y)}`);
  parts.push('Z');
  return parts.join(' ');
}

function minMax(values: number[]): { min: number; max: number; finite: number } {
  let min = Infinity;
  let max = -Infinity;
  let finite = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    finite += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (finite === 0) return { min: 0, max: 0, finite: 0 };
  return { min, max, finite };
}

/**
 * Compute the visible skyline for one direction and render it to SVG coords.
 */
export function computeDirection(
  grid: TerrainGrid,
  direction: CardinalDirection,
  smoothingWindow: number = DEFAULT_CONFIG.smoothingWindow,
): DirectionResult {
  const rawElevations = projectView(grid, direction);
  const { min, max } = minMax(rawElevations);
  const minElev = Number.isFinite(min) ? min : 0;
  const maxElev = Number.isFinite(max) ? max : (Number.isFinite(min) ? min : 0);

  // Bins: width for N/S, height for E/W. Map those bins across the viewbox width.
  const binCount = rawElevations.length;
  const xStep = VIEWBOX_WIDTH / binCount;

  const yValues = normalizeToY(rawElevations, minElev, maxElev, BASELINE_Y, TOP_MARGIN_Y);
  const smoothed = smoothBox(yValues, smoothingWindow);

  const points: SkylinePoint[] = [];
  for (let i = 0; i < smoothed.length; i += 1) {
    const x = i === binCount - 1 ? VIEWBOX_WIDTH : round2(i * xStep);
    const y = clamp(smoothed[i], TOP_MARGIN_Y, BASELINE_Y);
    points.push({ x: round2(x), y: round2(y) });
  }

  const path = buildPath(points, BASELINE_Y);
  return {
    direction,
    points,
    path,
    pathSha256: '', // filled in by renderSilhouettes after hashing
    minElevation: round2(minElev),
    maxElevation: round2(maxElev),
  };
}

/**
 * Render all requested directions for a peak into closed, valid SVG paths.
 * Pure and deterministic: same grid + config => byte-identical paths.
 */
export function renderSilhouettes(
  grid: TerrainGrid,
  config: Partial<SilhouetteConfig> = {},
): SilhouetteResult {
  const cfg: SilhouetteConfig = {
    sampleCount: config.sampleCount ?? DEFAULT_CONFIG.sampleCount,
    smoothingWindow: config.smoothingWindow ?? DEFAULT_CONFIG.smoothingWindow,
    directions: config.directions ?? CARDINALS,
    rendererVersion: config.rendererVersion ?? DEFAULT_CONFIG.rendererVersion,
  };
  if (cfg.smoothingWindow < 1) {
    throw new Error('renderSilhouettes: smoothingWindow must be >= 1');
  }
  if (cfg.directions.length === 0) {
    throw new Error('renderSilhouettes: at least one direction is required');
  }
  const directions = cfg.directions.map((d) => computeDirection(grid, d, cfg.smoothingWindow));
  return {
    peakId: grid.peakId,
    sourceId: grid.sourceId,
    rendererVersion: cfg.rendererVersion,
    directions,
  };
}

/** Wrap a closed path in a fixed, versioned viewbox. */
export function renderSvg(
  result: SilhouetteResult,
  direction: CardinalDirection,
  style: ArtisticStyle = artisticStyle(result.peakId),
): string {
  const dir = result.directions.find((d) => d.direction === direction);
  if (!dir) {
    throw new Error(`renderSvg: direction ${direction} not present in result`);
  }
  const dAttr = dir.path;
  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}" role="img" aria-label="Silhouette of ${result.peakId} from ${direction}">`,
  );
  lines.push(
    `  <path d="${dAttr}" fill="${style.fill}" fill-opacity="${style.fillOpacity}" stroke="${style.stroke}" stroke-width="1.5" stroke-linejoin="round"/>`,
  );
  lines.push('</svg>');
  return lines.join('\n');
}
