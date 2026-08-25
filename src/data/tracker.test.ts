import test from 'node:test';
import assert from 'node:assert/strict';
import {
  peaks,
  summary,
  groups,
  assertInvariants,
  toDisplayPeaks,
  slugify,
  classLabel,
  COMPASS_VIEWS,
  silhouettesById,
  PILOT_SILHOUETTE_IDS,
  hasSilhouette,
  silhouetteManifestDoc,
} from './tracker.ts';

test('canonical dataset holds exactly 247 active peaks (never padded to 273)', () => {
  assert.equal(peaks.length, 247);
  assert.notEqual(peaks.length, 273);
});

test('frozen invariants hold on the committed reconciled dataset', () => {
  assert.deepEqual(assertInvariants(), []);
});

test('suspended Pilot Knob (spk-1.1) is excluded from the active dataset', () => {
  assert.ok(!peaks.some((p) => p.sps_id === 'spk-1.1'));
});

test('progress summary is derived from the data, not hardcoded', () => {
  assert.equal(summary.total, 247);
  assert.equal(summary.done, peaks.filter((p) => p.completion).length);
  assert.equal(summary.remaining, summary.total - summary.done);
  // 30 completions committed -> 30/247 ≈ 12.1%
  assert.equal(summary.done, 30);
  assert.equal(summary.percent, 12.1);
});

test('groups reconstruct the 24 SPS areas in document order with stable peaks', () => {
  assert.equal(groups.length, 24);
  const totalInGroups = groups.reduce((n, g) => n + g.peaks.length, 0);
  assert.equal(totalInGroups, 247);
  const sections = groups.map((g) => g.section);
  assert.deepEqual(sections, [...sections].sort((a, b) => a - b));
  // First group is Southern Sierra starting at spk-1.2 (Pilot Knob suspended).
  assert.equal(groups[0].section, 1);
  assert.equal(groups[0].area, 'SOUTHERN SIERRA');
  assert.equal(groups[0].peaks[0].sps_id, 'spk-1.2');
});

test('display peaks carry stable slugs and completion state', () => {
  const dp = toDisplayPeaks();
  assert.equal(dp.length, 247);
  const owens = dp.find((p) => p.sps_id === 'spk-1.2');
  assert.ok(owens, 'spk-1.2 should exist');
  assert.equal(owens!.done, true);
  assert.equal(owens!.completionDate, '2022-04-18');
  assert.equal(owens!.completionDaySuffix, null);
  const needle = dp.find((p) => p.sps_id === 'spk-1.3');
  assert.ok(needle, 'spk-1.3 should exist');
  assert.equal(needle!.done, false);
  assert.equal(needle!.completionDate, null);
  // slugs are unique and non-empty
  const slugs = new Set(dp.map((p) => p.slug));
  assert.equal(slugs.size, 247);
  for (const s of slugs) assert.ok(s.length > 0);
});

test('slugify handles SPS notation variants', () => {
  assert.equal(slugify("Devil's Crag #1"), 'devils-crag-1');
  assert.equal(slugify('Sawtooth Peak (N)'), 'sawtooth-peak-n');
  assert.equal(slugify('MT WHITNEY'), 'mt-whitney');
});

test('classLabel preserves raw notation', () => {
  assert.equal(classLabel('2s3'), '2s3');
  assert.equal(classLabel('5.4'), '5.4');
  assert.equal(classLabel(''), '—');
});

test('compass views are N/E/S/W placeholders with no invented geometry', () => {
  assert.deepEqual(COMPASS_VIEWS.map((v) => v.key), ['N', 'E', 'S', 'W']);
  for (const v of COMPASS_VIEWS) {
    assert.equal(typeof v.label, 'string');
    assert.ok(v.label.length > 0);
    // No fabricated coordinates/angles: description is honest placeholder text.
    assert.ok(v.description.includes('no view geometry'));
  }
});

// ---- Pilot 11: silhouette integration tests ----

test('silhouettesById contains exactly the 8 pilot peaks', () => {
  assert.equal(PILOT_SILHOUETTE_IDS.length, 8);
  assert.equal(silhouettesById.size, 8);
  for (const id of PILOT_SILHOUETTE_IDS) {
    assert.ok(hasSilhouette(id), `expected silhouette for ${id}`);
  }
});

test('non-pilot peaks never have silhouettes (frozen §6)', () => {
  const pilotSet = new Set(PILOT_SILHOUETTE_IDS);
  for (const p of peaks) {
    if (!pilotSet.has(p.sps_id)) {
      assert.ok(!hasSilhouette(p.sps_id), `unexpected silhouette for ${p.sps_id}`);
    }
  }
});

test('every silhouette peak exposes the ONE manifest-selected outline', () => {
  for (const [id, entry] of silhouettesById) {
    assert.ok(['N', 'E', 'S', 'W'].includes(entry.direction), `non-cardinal direction for ${id}`);
    assert.equal(typeof entry.path, 'string');
    assert.ok(entry.path.startsWith('public/silhouettes/'), `bad svg path for ${id} (${entry.direction})`);
    // Exactly one outline per peak — no per-face N/E/S/W set.
    assert.deepEqual(Object.keys(entry).sort(), ['direction', 'path']);
  }
});

test('manifest entries all reference peaks that exist in the canonical 247', () => {
  const ids = new Set(peaks.map(p => p.sps_id));
  for (const entry of silhouetteManifestDoc.peaks) {
    assert.ok(ids.has(entry.peak_id), `manifest peak ${entry.peak_id} not in canonical dataset`);
  }
});
