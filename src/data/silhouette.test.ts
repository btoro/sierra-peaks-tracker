import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

test('orientation: a western spike shows in E/W views; N/S max is uniform', () => {
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
  // Look EAST from the west. Col 0 (nearest) = 7000, col 4 (farthest) = 6000.
  // The nearer 7000 occludes the 6000 behind it.
  const g2 = grid(5, 1, (r, c) => (c === 0 ? 7000 : c === 4 ? 6000 : 1000));
  assert.equal(projectView(g2, 'E')[0], 7000, 'nearer taller peak occludes the ridge behind it');
  // And a farther peak that is tall enough to survive the distance decay still
  // shows (covered by the "nearer-weighted max" test below).
});

test('occlusion: nearer-weighted max — a nearer ridge can hide a farther one that is not tall enough to exceed it after decay', () => {
  // Look EAST from the west (5 cols, 1 row). Col 0 = 5000 (nearest),
  // col 4 = 6000 (farthest). 6000 * 0.8^4 = 6000 * 0.4096 = 2457.6.
  // 5000 * 0.8^0 = 5000 > 2457.6, so the nearer 5000 occludes the 6000.
  const g = grid(5, 1, (r, c) => (c === 0 ? 5000 : c === 4 ? 6000 : 1000));
  assert.equal(projectView(g, 'E')[0], 5000, 'nearer ridge occludes a not-tall-enough farther peak');

  // Now make the far peak tall enough to exceed the decayed nearer one:
  // 12000 * 0.8^4 = 4915.2 > 5000? No. 13000 * 0.8^4 = 5324.8 > 5000. Yes.
  const g2 = grid(5, 1, (r, c) => (c === 0 ? 5000 : c === 4 ? 13000 : 1000));
  assert.equal(projectView(g2, 'E')[0], 13000, 'a sufficiently tall farther peak still shows through');
});

test('occlusion: N and S are order-dependent (nearer-weighted max is not commutative)', () => {
  // 4 cols x 2 rows. Row 0 (north) = 2000, row 1 (south) = 8000.
  // N looks from the south: nearest row = 1 (8000), then row 0 (2000).
  // apparent: 8000*1=8000 vs 2000*0.8=1600. Winner: 8000.
  // S looks from the north: nearest row = 0 (2000), then row 1 (8000).
  // apparent: 2000*1=2000 vs 8000*0.8=6400. Winner: 8000.
  // Both report 8000, but for different reasons (different winners).
  // To show N≠S we need a case where the decayed winner differs:
  // Row 0 = 5000, row 1 = 4000.
  // N (from south): 4000*1=4000 vs 5000*0.8=4000. Tie -> 4000 (first seen, i=0).
  // S (from north): 5000*1=5000 vs 4000*0.8=3200. Winner: 5000.
  const g = grid(4, 2, (r, c) => (r === 0 ? 5000 : 4000));
  const n = projectView(g, 'N');
  const s = projectView(g, 'S');
  assert.equal(n[0], 4000, 'N: nearer (south) 4000 wins the tie at i=0');
  assert.equal(s[0], 5000, 'S: nearer (north) 5000 wins outright');
  assert.notDeepEqual(n, s, 'N and S must differ under order-dependent projection');
});

test('occlusion: E and W are order-dependent on real terrain', () => {
  // Synthetic terrain with a clear asymmetry: a tall cell in col 0 and a
  // moderately tall cell in col 4, with lower cells between.
  // 6 cols x 2 rows.
  //   col:  0     1     2     3     4     5
  // row0: 7000  1000  1000  1000  5000  1000
  // row1: 1000  1000  1000  1000  6000  1000
  const g = grid(6, 2, (r, c) =>
    c === 0 && r === 0 ? 7000 :
    c === 4 && r === 0 ? 5000 :
    c === 4 && r === 1 ? 6000 : 1000
  );
  const e = projectView(g, 'E'); // observer west, walks col 0→5
  const w = projectView(g, 'W'); // observer east, walks col 5→0
  // E, row 0: 7000 (i=0) vs 5000*0.8^4=2048 → 7000 wins.
  // W, row 0: 1000(i=0) vs 5000*0.8^1=4000 vs 7000*0.8^4=1433.6 → 5000 wins.
  assert.equal(e[0], 7000, 'E: western 7000 occludes the 5000 behind it');
  assert.equal(w[0], 5000, 'W: the 5000 is nearer to the east observer than the 7000');
  assert.notDeepEqual(e, w, 'E and W must differ under order-dependent projection');
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

// ---------------------------------------------------------------------------
// Manifest elevation contract (Pilot 10)
// ---------------------------------------------------------------------------

/**
 * Recompute the manifest elevation contract for a committed .bin sample:
 * min_m / max_m must equal the actual min/max of the whole sample grid,
 * matching what generate-silhouettes.mjs writes to data/silhouettes/manifest.json.
 */
function sampleElevations(bytes: Uint8Array, meta: { width: number; height: number }): { min_m: number; max_m: number } {
  const buf = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const n = meta.width * meta.height;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { min_m: mn, max_m: mx };
}

test('manifest contract: elevations equal the committed .bin sample min/max for every pilot peak', () => {
  // Read every committed sample and assert the manifest elevations match the
  // actual min/max of the .bin sample grid. The generator emits elevations
  // from this same rule, so any future drift fails here.
  const root = path.resolve(process.cwd(), 'data', 'silhouettes');
  const ids = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.ok(ids.length > 0, 'expected at least one committed sample');

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
    peaks: { peak_id: string; elevations: { min_m: number; max_m: number } }[];
  };
  const manifestMap = new Map(manifest.peaks.map((p) => [p.peak_id, p.elevations]));

  for (const id of ids) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, id, `${id}.json`), 'utf8')) as {
      width: number; height: number;
    };
    const bytes = fs.readFileSync(path.join(root, id, `${id}.bin`));
    const { min_m, max_m } = sampleElevations(bytes, meta);
    const recorded = manifestMap.get(id);
    assert.ok(recorded, `${id}: missing from manifest`);
    assert.ok(Number.isFinite(recorded.min_m), `${id}: manifest min_m not finite`);
    assert.ok(Number.isFinite(recorded.max_m), `${id}: manifest max_m not finite`);
    assert.ok(Math.abs(recorded.min_m - min_m) < 0.01, `${id}: min_m mismatch: manifest=${recorded.min_m} actual=${min_m}`);
    assert.ok(Math.abs(recorded.max_m - max_m) < 0.01, `${id}: max_m mismatch: manifest=${recorded.max_m} actual=${max_m}`);
  }
});
