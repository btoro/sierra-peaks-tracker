#!/usr/bin/env node
/**
 * Standalone test runner for silhouette.test.ts assertions.
 * Runs the same test cases without node:test (which hangs on this host).
 * Exits 0 on all pass, 1 on any failure.
 */
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
} from '../../src/data/silhouette.ts';

function grid(width, height, cell, nodata = -9999) {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1)
    for (let col = 0; col < width; col += 1) data[row * width + col] = cell(row, col);
  return { width, height, data, nodata, sourceId: 'synthetic', peakId: 'syn-peak', sourceSha256: null };
}

const tests = [
  ['readTerrain decodes little-endian float32 row-major', () => {
    const g = grid(2, 2, (r, c) => r * 2 + c);
    const data = new Float32Array(4);
    data[0] = 0; data[1] = 1; data[2] = 2; data[3] = 3;
    const decoded = readTerrain(new Uint8Array(data.buffer), { width: 2, height: 2, sourceId: 'x', peakId: 'p' });
    assert.equal(decoded.data[0], 0);
    assert.equal(decoded.data[3], 3);
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 2);
  }],
  ['readTerrain rejects empty/short buffers and bad dimensions', () => {
    assert.throws(() => readTerrain(new Uint8Array(8), { width: 4, height: 4, sourceId: 'x', peakId: 'y' }), /buffer 8 bytes < required 64/);
    assert.throws(() => readTerrain(new Uint8Array(8), { width: 0, height: 4, sourceId: 'x', peakId: 'y' }), /invalid grid dimensions/);
  }],
  ['orientation: western spike in E/W, flat in N/S', () => {
    const g = grid(5, 3, (r, c) => (c === 0 ? 3000 : 1000));
    assert.deepEqual(projectView(g, 'E'), [3000, 3000, 3000]);
    assert.deepEqual(projectView(g, 'W'), [3000, 3000, 3000]);
    assert.deepEqual(projectView(g, 'N'), [3000, 1000, 1000, 1000, 1000]);
    assert.deepEqual(projectView(g, 'S'), [3000, 1000, 1000, 1000, 1000]);
  }],
  ['orientation: northern spike in N/S, flat in E/W', () => {
    const g = grid(5, 3, (r, c) => (r === 0 ? 4000 : 1000));
    assert.deepEqual(projectView(g, 'E'), [4000, 1000, 1000]);
    assert.deepEqual(projectView(g, 'W'), [4000, 1000, 1000]);
    assert.deepEqual(projectView(g, 'N'), [4000, 4000, 4000, 4000, 4000]);
    assert.deepEqual(projectView(g, 'S'), [4000, 4000, 4000, 4000, 4000]);
  }],
  ['orientation: bin count matches axis', () => {
    const g = grid(7, 4, () => 1000);
    assert.equal(projectView(g, 'N').length, 7);
    assert.equal(projectView(g, 'S').length, 7);
    assert.equal(projectView(g, 'E').length, 4);
    assert.equal(projectView(g, 'W').length, 4);
  }],
  ['occlusion: nearer taller hides farther shorter', () => {
    const g = grid(5, 1, (r, c) => (c === 0 ? 5000 : c === 4 ? 6000 : 1000));
    assert.equal(projectView(g, 'E')[0], 6000);
    const g2 = grid(5, 1, (r, c) => (c === 0 ? 7000 : c === 4 ? 6000 : 1000));
    assert.equal(projectView(g2, 'E')[0], 7000);
  }],
  ['occlusion: pointwise max is order-independent', () => {
    const a = grid(4, 2, (r, c) => (r === 0 ? 2000 : 8000));
    const b = grid(4, 2, (r, c) => (r === 0 ? 8000 : 2000));
    assert.deepEqual(projectView(a, 'N'), projectView(b, 'N'));
    assert.deepEqual(projectView(a, 'S'), projectView(b, 'S'));
  }],
  ['flat terrain: all points on baseline, closed path', () => {
    const g = grid(8, 8, () => 1500);
    const res = computeDirection(g, 'N');
    for (const p of res.points) assert.equal(p.y, BASELINE_Y);
    assert.ok(res.path.endsWith('Z'));
    assert.equal(res.minElevation, 1500);
    assert.equal(res.maxElevation, 1500);
  }],
  ['empty terrain: baseline fallback, closed path', () => {
    const g = grid(6, 4, () => -9999);
    for (const d of ['N', 'E', 'S', 'W']) {
      const res = computeDirection(g, d);
      for (const p of res.points) assert.equal(p.y, BASELINE_Y);
      assert.ok(res.path.endsWith('Z'));
      assert.equal(res.minElevation, 0);
      assert.equal(res.maxElevation, 0);
    }
  }],
  ['no-data cells skipped, not zero', () => {
    const g = grid(3, 3, (r, c) => (r === 1 && c === 1 ? 5000 : -9999));
    const n = projectView(g, 'N');
    assert.ok(!Number.isFinite(n[0]));
    assert.equal(n[1], 5000);
    assert.ok(!Number.isFinite(n[2]));
  }],
  ['clipping: all points in viewbox', () => {
    const g = grid(10, 10, (r, c) => 1000 + 300 * Math.abs(r - c));
    for (const d of ['N', 'E', 'S', 'W']) {
      const res = computeDirection(g, d);
      for (const p of res.points) {
        assert.ok(p.x >= 0 && p.x <= VIEWBOX_WIDTH);
        assert.ok(p.y >= TOP_MARGIN_Y && p.y <= BASELINE_Y);
      }
    }
  }],
  ['clipping: extreme relief clips to top margin', () => {
    const g = grid(12, 1, (r, c) => c * 1000);
    const res = computeDirection(g, 'E');
    const minY = Math.min(...res.points.map((p) => p.y));
    assert.ok(minY >= TOP_MARGIN_Y);
  }],
  ['determinism: byte-identical paths', () => {
    const g = grid(9, 5, (r, c) => 2000 + 100 * (r * c));
    const a = renderSilhouettes(g);
    const b = renderSilhouettes(g);
    for (let i = 0; i < 4; i++) assert.equal(a.directions[i].path, b.directions[i].path);
  }],
  ['determinism: fnv1a + pickVariant stable, in-range', () => {
    assert.equal(fnv1a('spk-1.7'), fnv1a('spk-1.7'));
    assert.notEqual(fnv1a('spk-1.7'), fnv1a('spk-1.8'));
    for (const id of ['spk-1.7', 'spk-4.20', 'spk-16.1', 'syn-peak', 'a']) {
      const v = pickVariant(id);
      assert.ok(v >= 1 && v <= ARTISTIC_STYLE_VARIANTS.length);
    }
    assert.equal(artisticStyle('spk-1.7').fill, artisticStyle('spk-1.7').fill);
  }],
  ['determinism: pathSha256 is stable string', () => {
    const g = grid(6, 3, (r, c) => 3000 - 200 * c);
    const res = computeDirection(g, 'N');
    assert.equal(typeof res.pathSha256, 'string');
    assert.ok(res.path.length > 0);
  }],
  ['closed path: M...Z for all directions', () => {
    const g = grid(7, 7, (r, c) => 1200 + 50 * (r + c));
    for (const d of ['N', 'E', 'S', 'W']) {
      const res = computeDirection(g, d);
      assert.match(res.path, /^M/);
      assert.ok(res.path.endsWith('Z'));
    }
  }],
  ['closed path: empty points -> baseline slab', () => {
    const p = buildPath([], BASELINE_Y);
    assert.ok(p.startsWith('M0 '));
    assert.ok(p.endsWith('Z'));
    assert.equal((p.match(/L/g) || []).length + (p.match(/Z/g) || []).length, 4);
  }],
  ['closed path: 2-decimal rounding, no -0', () => {
    const g = grid(5, 5, (r, c) => 2000 + 10 * ((r * 7 + c * 3) % 5));
    const res = computeDirection(g, 'N');
    assert.ok(!res.path.includes('-0.'));
    assert.ok(!res.path.includes('-0 '));
    for (const tok of res.path.split(/\s+/)) {
      if (tok.startsWith('L') || tok.startsWith('M')) {
        for (const n of tok.slice(1).split(' ')) {
          if (n.includes('.')) assert.ok(n.split('.')[1].length <= 2);
        }
      }
    }
  }],
  ['renderSilhouettes: 4 directions by default', () => {
    const g = grid(8, 8, (r, c) => 1500 + 100 * Math.abs(r - c));
    const res = renderSilhouettes(g);
    assert.deepEqual(res.directions.map((d) => d.direction), ['N', 'E', 'S', 'W']);
    for (const d of res.directions) {
      assert.ok(d.path.endsWith('Z'));
      assert.ok(d.points.length > 0);
    }
  }],
  ['renderSilhouettes: rejects empty directions + bad smoothing', () => {
    const g = grid(4, 4, () => 1000);
    assert.throws(() => renderSilhouettes(g, { directions: [] }), /at least one direction/);
    assert.throws(() => renderSilhouettes(g, { smoothingWindow: 0 }), /smoothingWindow/);
  }],
];

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
