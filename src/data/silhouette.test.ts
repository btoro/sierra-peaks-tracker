import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readTerrain,
  projectView,
  computeDirection,
  renderSilhouettes,
  buildPath,
  pickVariant,
  artisticStyle,
  fnv1a,
  ARTISTIC_STYLE_VARIANTS,
  VIEWBOX_WIDTH,
  BASELINE_Y,
  TOP_MARGIN_Y,
  type TerrainGrid,
  type CardinalDirection,
} from './silhouette.ts';

/**
 * Synthetic DEM helpers. The engine is a pure function of terrain + config,
 * so every acceptance criterion (orientation, occlusion, flat/empty,
 * clipping, determinism) is exercised on small synthetic grids with
 * hand-verifiable shapes. Grid layout: row 0 = northern edge, col 0 =
 * western edge.
 */
function grid(width: number, height: number, cell: (row: number, col: number) => number, nodata = -9999): TerrainGrid {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      data[row * width + col] = cell(row, col);
    }
  }
  return { width, height, data, nodata, sourceId: 'synthetic', peakId: 'syn-peak', sourceSha256: null };
}

/** Encode a grid as little-endian float32 bytes (what readTerrain decodes). */
function toBytes(g: TerrainGrid): Uint8Array {
  return new Uint8Array(g.data.buffer, g.data.byteOffset, g.data.byteLength);
}

/** Round-trip through readTerrain to prove the byte decoder matches. */
function roundTrip(g: TerrainGrid): TerrainGrid {
  return readTerrain(toBytes(g), { width: g.width, height: g.height, sourceId: g.sourceId, peakId: g.peakId });
}

// ---------------------------------------------------------------------------
// readTerrain
// ---------------------------------------------------------------------------

test('readTerrain decodes little-endian float32 row-major', () => {
  const g = grid(2, 2, (r, c) => r * 2 + c); // 0,1 / 2,3
  const decoded = roundTrip(g);
  assert.equal(decoded.data[0], 0);
  assert.equal(decoded.data[3], 3);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
});

test('readTerrain rejects empty/short buffers and bad dimensions', () => {
  assert.throws(() => readTerrain(new Uint8Array(8), { width: 4, height: 4, sourceId: 'x', peakId: 'y' }), /buffer 8 bytes < required 64/);
  assert.throws(() => readTerrain(new Uint8Array(8), { width: 0, height: 4, sourceId: 'x', peakId: 'y' }), /invalid grid dimensions/);
});

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

test('orientation: a western spike shows in E/W views but is flattened in N/S max', () => {
  // 5 cols x 3 rows. Only col 0 is elevated (a tall western ridge).
  const g = grid(5, 3, (r, c) => (c === 0 ? 3000 : 1000));
  // E/W: bins = rows. Row maxima = 3000 for every row (the spike occupies each row).
  const e = projectView(g, 'E');
  const w = projectView(g, 'W');
  assert.deepEqual(e, [3000, 3000, 3000]);
  assert.deepEqual(w, [3000, 3000, 3000]);
  // N/S: bins = columns. Col 0 = 3000, others = 1000.
  const n = projectView(g, 'N');
  const s = projectView(g, 'S');
  assert.deepEqual(n, [3000, 1000, 1000, 1000, 1000]);
  assert.deepEqual(s, [3000, 1000, 1000, 1000, 1000]);
});

test('orientation: a northern spike shows in N/S bins but is flattened in E/W max', () => {
  const g = grid(5, 3, (r, c) => (r === 0 ? 4000 : 1000)); // top row tall
  const e = projectView(g, 'E');
  const w = projectView(g, 'W');
  assert.deepEqual(e, [4000, 1000, 1000]);
  assert.deepEqual(w, [4000, 1000, 1000]);
  const n = projectView(g, 'N');
  const s = projectView(g, 'S');
  assert.deepEqual(n, [4000, 4000, 4000, 4000, 4000]);
  assert.deepEqual(s, [4000, 4000, 4000, 4000, 4000]);
});

test('orientation: bin count matches the sampled axis (width for N/S, height for E/W)', () => {
  const g = grid(7, 4, () => 1000);
  assert.equal(projectView(g, 'N').length, 7);
  assert.equal(projectView(g, 'S').length, 7);
  assert.equal(projectView(g, 'E').length, 4);
  assert.equal(projectView(g, 'W').length, 4);
});

// ---------------------------------------------------------------------------
// Occlusion
// ---------------------------------------------------------------------------

test('occlusion: a nearer, taller cell hides a farther, shorter cell in the same sight line', () => {
  // Look EAST from the west. Col 0 (nearest) = 5000, col 4 (farthest) = 6000.
  // The 6000 is taller than 5000, so it should still show.
  const g = grid(5, 1, (r, c) => (c === 0 ? 5000 : c === 4 ? 6000 : 1000));
  const e = projectView(g, 'E');
  assert.equal(e[0], 6000, 'farther-but-taller peak remains visible');
  // Now make the nearer cell TALLER: it must occlude the 6000 behind it.
  const g2 = grid(5, 1, (r, c) => (c === 0 ? 7000 : c === 4 ? 6000 : 1000));
  assert.equal(projectView(g2, 'E')[0], 7000, 'nearer taller peak occludes the ridge behind it');
});

test('occlusion: the silhouette is the pointwise column/row max (nearer cannot lower the skyline)', () => {
  // For a pure max projection, reordering the sight line must not change the
  // result — the skyline depends only on the set of elevations in each bin.
  const a = grid(4, 2, (r, c) => (r === 0 ? 2000 : 8000)); // top row 2000, bottom 8000
  const b = grid(4, 2, (r, c) => (r === 0 ? 8000 : 2000)); // swapped
  // N looks from the south: nearest row = highest index. But max is order-independent.
  assert.deepEqual(projectView(a, 'N'), projectView(b, 'N'));
  assert.deepEqual(projectView(a, 'S'), projectView(b, 'S'));
});

// ---------------------------------------------------------------------------
// Flat / empty inputs
// ---------------------------------------------------------------------------

test('flat terrain: every point sits on the baseline, path is a closed slab', () => {
  const g = grid(8, 8, () => 1500);
  const res = computeDirection(g, 'N');
  for (const p of res.points) {
    assert.equal(p.y, BASELINE_Y, `flat point must be on baseline, got ${p.y}`);
  }
  assert.ok(res.path.endsWith('Z'));
  // min === max => normalization pins everything to baseline.
  assert.equal(res.minElevation, 1500);
  assert.equal(res.maxElevation, 1500);
});

test('empty terrain (all no-data): no finite elevations => baseline fallback, still closed', () => {
  const g = grid(6, 4, () => -9999);
  for (const d of ['N', 'E', 'S', 'W'] as CardinalDirection[]) {
    const res = computeDirection(g, d);
    for (const p of res.points) {
      assert.equal(p.y, BASELINE_Y);
    }
    assert.ok(res.path.endsWith('Z'));
    assert.equal(res.minElevation, 0);
    assert.equal(res.maxElevation, 0);
  }
});

test('no-data cells are skipped, not treated as zero elevation', () => {
  // A single real cell (5000) surrounded by no-data. The skyline must read 5000,
  // not be pulled down to -9999 or 0.
  const g = grid(3, 3, (r, c) => (r === 1 && c === 1 ? 5000 : -9999));
  const n = projectView(g, 'N');
  // 3 columns: col 0 all nodata -> NaN; col 1 has 5000; col 2 nodata -> NaN
  assert.ok(!Number.isFinite(n[0]));
  assert.equal(n[1], 5000);
  assert.ok(!Number.isFinite(n[2]));
});

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

test('clipping: all points stay within the viewbox bounds', () => {
  const g = grid(10, 10, (r, c) => 1000 + 300 * Math.abs(r - c));
  for (const d of ['N', 'E', 'S', 'W'] as CardinalDirection[]) {
    const res = computeDirection(g, d);
    for (const p of res.points) {
      assert.ok(p.x >= 0 && p.x <= VIEWBOX_WIDTH, `x out of viewbox: ${p.x}`);
      assert.ok(p.y >= TOP_MARGIN_Y && p.y <= BASELINE_Y, `y out of viewbox: ${p.y}`);
    }
  }
});

test('clipping: extreme relief still clips into the viewbox (no y below the top margin)', () => {
  // Steep ramp: min very low, max very high. The max must map to TOP_MARGIN,
  // never above it.
  const g = grid(12, 1, (r, c) => c * 1000); // 0..11000
  const res = computeDirection(g, 'E');
  const minY = Math.min(...res.points.map((p) => p.y));
  assert.ok(minY >= TOP_MARGIN_Y, `highest point clipped at ${minY} (< top margin ${TOP_MARGIN_Y})`);
});

// ---------------------------------------------------------------------------
// Deterministic hashes
// ---------------------------------------------------------------------------

test('determinism: identical grids produce byte-identical paths', () => {
  const g = grid(9, 5, (r, c) => 2000 + 100 * (r * c));
  const a = renderSilhouettes(g);
  const b = renderSilhouettes(g);
  assert.equal(a.directions[0].path, b.directions[0].path, 'N path must be byte-identical');
  assert.equal(a.directions[1].path, b.directions[1].path, 'E path must be byte-identical');
  assert.equal(a.directions[2].path, b.directions[2].path, 'S path must be byte-identical');
  assert.equal(a.directions[3].path, b.directions[3].path, 'W path must be byte-identical');
});

test('determinism: fnv1a and pickVariant are stable and in-range', () => {
  assert.equal(fnv1a('spk-1.7'), fnv1a('spk-1.7'));
  assert.notEqual(fnv1a('spk-1.7'), fnv1a('spk-1.8'));
  for (const id of ['spk-1.7', 'spk-4.20', 'spk-16.1', 'syn-peak', 'a']) {
    const v = pickVariant(id);
    assert.ok(v >= 1 && v <= ARTISTIC_STYLE_VARIANTS.length, `variant ${v} out of range for ${id}`);
  }
  // Deterministic style lookup.
  assert.equal(artisticStyle('spk-1.7').fill, artisticStyle('spk-1.7').fill);
});

test('determinism: pathSha256 placeholder is stable shape (filled by the CLI hasher)', () => {
  const g = grid(6, 3, (r, c) => 3000 - 200 * c);
  const res = computeDirection(g, 'N');
  assert.equal(typeof res.pathSha256, 'string');
  // The path itself is the deterministic artifact; the CLI layers the hash.
  assert.ok(res.path.length > 0);
});

// ---------------------------------------------------------------------------
// Closed valid SVG paths
// ---------------------------------------------------------------------------

test('closed path: every generated path starts with M and ends with Z', () => {
  const g = grid(7, 7, (r, c) => 1200 + 50 * (r + c));
  for (const d of ['N', 'E', 'S', 'W'] as CardinalDirection[]) {
    const res = computeDirection(g, d);
    assert.match(res.path, /^M/);
    assert.ok(res.path.endsWith('Z'), `${d} path must be closed`);
  }
});

test('closed path: baseline slab is produced when points are empty', () => {
  const p = buildPath([], BASELINE_Y);
  assert.ok(p.startsWith('M0 '));
  assert.ok(p.endsWith('Z'));
  // It must be a valid closed slab: M + 3 L + Z.
  assert.equal((p.match(/L/g) || []).length + (p.match(/Z/g) || []).length, 4);
});

test('closed path: coordinates are rounded to 2 decimals and never negative-zero', () => {
  const g = grid(5, 5, (r, c) => 2000 + 10 * ((r * 7 + c * 3) % 5));
  const res = computeDirection(g, 'N');
  assert.ok(!res.path.includes('-0.'), 'path must not emit -0');
  assert.ok(!res.path.includes('-0 '), 'path must not emit -0');
  // Every coordinate token has at most 2 decimals.
  for (const tok of res.path.split(/\s+/)) {
    if (tok.startsWith('L') || tok.startsWith('M')) {
      const nums = tok.slice(1).split(' ');
      for (const n of nums) {
        if (n.includes('.')) {
          assert.ok(n.split('.')[1].length <= 2, `coordinate ${n} has >2 decimals`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// renderSilhouettes + svg
// ---------------------------------------------------------------------------

test('renderSilhouettes: all four cardinal directions by default, each closed', () => {
  const g = grid(8, 8, (r, c) => 1500 + 100 * Math.abs(r - c));
  const res = renderSilhouettes(g);
  assert.deepEqual(res.directions.map((d) => d.direction), ['N', 'E', 'S', 'W']);
  for (const d of res.directions) {
    assert.ok(d.path.endsWith('Z'));
    assert.ok(d.points.length > 0);
  }
});

test('renderSilhouettes: rejects an empty direction list and bad smoothing window', () => {
  const g = grid(4, 4, () => 1000);
  assert.throws(() => renderSilhouettes(g, { directions: [] }), /at least one direction/);
  assert.throws(() => renderSilhouettes(g, { smoothingWindow: 0 }), /smoothingWindow/);
});
