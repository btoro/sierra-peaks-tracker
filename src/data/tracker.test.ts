import test from 'node:test';
import assert from 'node:assert/strict';
import {
  peaks,
  summary,
  groups,
  assertInvariants,
  applyFilters,
  toDisplayPeaks,
  slugify,
  classLabel,
  COMPASS_VIEWS,
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

test('applyFilters: query is case-insensitive across both name spellings', () => {
  const dp = toDisplayPeaks();
  const found = applyFilters(dp, { section: null, status: 'all', query: 'whitney' });
  assert.ok(found.length > 0);
  assert.ok(found.some((p) => p.sps_name === 'MT WHITNEY'));
  // peakbagger-spelling hit that differs from the SPS name
  const smith = applyFilters(dp, { section: null, status: 'all', query: 'smith mtn' });
  assert.ok(smith.length >= 1);
});

test('applyFilters: section and status filters', () => {
  const dp = toDisplayPeaks();
  const sec1 = applyFilters(dp, { section: 1, status: 'all' });
  assert.ok(sec1.length >= 1);
  for (const p of sec1) assert.equal(p.section, 1);
  const done = applyFilters(dp, { section: null, status: 'done' });
  assert.equal(done.length, 30);
  for (const p of done) assert.equal(p.done, true);
  const todo = applyFilters(dp, { section: null, status: 'todo' });
  assert.equal(todo.length, 217);
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
