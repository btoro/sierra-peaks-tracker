import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  reconcile,
  reconcileToJson,
  COLLISION_FAMILIES,
  type ReconcileInput,
  type CanonicalPeak,
} from './reconcile.ts';
import type { SpsRow, SpsArea } from './sps/schema.ts';
import type { PbRow, Completion, CrosswalkEntry } from './peakbagger/schema.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPS = JSON.parse(readFileSync(path.join(ROOT, 'data/sps/sp-s-29-2025.json'), 'utf8')) as {
  areas: SpsArea[];
  rows: SpsRow[];
};
const LID = JSON.parse(readFileSync(path.join(ROOT, 'data/peakbagger/lid-5051.json'), 'utf8')) as { rows: PbRow[] };
const CID = JSON.parse(readFileSync(path.join(ROOT, 'data/peakbagger/cid-30050.json'), 'utf8')) as {
  completions: Completion[];
};
const XW = JSON.parse(readFileSync(path.join(ROOT, 'data/crosswalk.json'), 'utf8')) as { entries: CrosswalkEntry[] };

function buildInput(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    spsRows: SPS.rows,
    spsAreas: SPS.areas,
    lidRows: LID.rows,
    cidCompletions: CID.completions,
    crosswalk: XW.entries,
    ...overrides,
  };
}

const ok = reconcile(buildInput());
assert.equal(ok.ok, true, ok.ok ? '' : `expected happy-path ok, got errors: ${ok.errors.join(' | ')}`);
const happy = ok;

test('reconciles to exactly 247 active canonical peaks', () => {
  assert.equal(happy.counts.canonical_active, 247);
  assert.equal(happy.peaks.length, 247);
});

test('retains the suspended Pilot Knob in source but excludes it from the active dataset', () => {
  assert.equal(happy.counts.sps_total, 248);
  assert.equal(happy.counts.sps_active, 247);
  assert.equal(happy.counts.sps_suspended, 1);
  const pk = SPS.rows.find((r) => r.suspended)!;
  assert.equal(pk.id, 'spk-1.1');
  assert.ok(pk.name.startsWith('Pilot Knob'));
  // The suspended row must NOT appear in the canonical dataset.
  assert.ok(!happy.peaks.some((p) => p.sps_id === 'spk-1.1'));
});

test('every active Peakbagger row maps exactly once into the canonical dataset', () => {
  const pbOrders = happy.peaks.map((p) => p.pb_order);
  assert.equal(new Set(pbOrders).size, 247, 'duplicate pb_order in canonical dataset');
  // The canonical dataset must carry every active lid row.
  const lidSet = new Set(LID.rows.map((r) => r.pb_order));
  const canonSet = new Set(pbOrders);
  for (const o of lidSet) assert.ok(canonSet.has(o), `canonical dataset missing Peakbagger row pb_order ${o}`);
});

test('every canonical peak carries both SPS and Peakbagger orderings', () => {
  for (const p of happy.peaks) {
    assert.match(p.sps_id, /^spk-\d+\.\d+$/);
    assert.equal(p.sps_section, Number(p.sps_id.slice(4).split('.')[0]));
    assert.equal(p.sps_seq, Number(p.sps_id.slice(4).split('.')[1]));
    assert.ok(p.pb_order >= 1 && p.pb_order <= 247);
    assert.ok(p.pb_id.length > 0);
    assert.ok(p.sps_name.length > 0 && p.pb_name.length > 0);
  }
});

test('every completion resolves to an active canonical id and appears on exactly one peak', () => {
  const completed = happy.peaks.filter((p) => p.completion !== null);
  assert.equal(completed.length, happy.counts.completions, 'completion count mismatch');
  const completedIds = new Set(completed.map((p) => p.sps_id));
  assert.equal(completedIds.size, completed.length, 'a peak carries two completions');
  for (const p of completed) {
    assert.notEqual(p.sps_id, 'spk-1.1', 'suspended row must never carry a completion');
    assert.match(p.completion!.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.completion!.ascent_id.length > 0);
  }
});

test('N/S collision families resolve to distinct canonical ids by section (not name)', () => {
  // Sawtooth: N in section 2, S in section 1 — both active, both mapped, distinct ids.
  const sawtooth = happy.collisionFamilies['Sawtooth'];
  assert.equal(sawtooth.length, 2);
  assert.equal(new Set(sawtooth).size, 2, 'Sawtooth N/S must be distinct ids');
  for (const id of sawtooth) {
    const p = happy.peaks.find((x) => x.sps_id === id);
    assert.ok(p, `Sawtooth member ${id} missing from dataset`);
  }
  // Morgan: N (section 9) active + S (section 17) active.
  const morgan = happy.collisionFamilies['Morgan'];
  assert.equal(morgan.length, 2);
  assert.equal(new Set(morgan).size, 2);
  // Stanford: N + S active.
  const stanford = happy.collisionFamilies['Stanford'];
  assert.equal(stanford.length, 2);
  assert.equal(new Set(stanford).size, 2);
  // Pyramid: N + S active.
  const pyramid = happy.collisionFamilies['Pyramid'];
  assert.equal(pyramid.length, 2);
  assert.equal(new Set(pyramid).size, 2);
  // Pilot Knob: the suspended SPS row maps to nothing (0 active members).
  const pilot = happy.collisionFamilies['Pilot Knob'];
  assert.equal(pilot.length, 0, 'suspended Pilot Knob must contribute no active canonical id');
});

test('a distinct active Peakbagger "Pilot Knob" row exists and is NOT confused with the suspended SPS row', () => {
  // There is an ACTIVE Peakbagger row named "Pilot Knob" in section 16.
  const activePk = LID.rows.find((r) => r.name === 'Pilot Knob' && r.pb_section === 16);
  assert.ok(activePk, 'active Peakbagger Pilot Knob row expected in section 16');
  // It must map to a DIFFERENT active SPS row, never spk-1.1.
  const entry = XW.entries.find((e) => e.pb_order === activePk!.pb_order)!;
  assert.ok(entry, 'crosswalk entry for active Peakbagger Pilot Knob');
  assert.notEqual(entry.sps_id, 'spk-1.1', 'active Peakbagger Pilot Knob must not map to suspended SPS 1.1');
  const canon = happy.peaks.find((p) => p.sps_id === entry.sps_id)!;
  assert.ok(canon, `active Peakbagger Pilot Knob resolves to canonical ${entry.sps_id}`);
});

test('rejection: duplicate crosswalk sps_id fails', () => {
  const dup = [
    ...XW.entries,
    { ...XW.entries[0], sps_id: XW.entries[0].sps_id, pb_order: 999, pb_id: '0' },
  ];
  const r = reconcile(buildInput({ crosswalk: dup }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('duplicate sps_id')));
});

test('rejection: missing canonical crosswalk row fails', () => {
  const dropped = XW.entries.filter((e) => e.sps_id !== 'spk-1.2');
  const r = reconcile(buildInput({ crosswalk: dropped }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('missing canonical crosswalk row') || e.includes('!= 247')));
});

test('rejection: unknown completion reference (non-active sps_id) fails', () => {
  const bad: Completion = {
    sps_id: 'spk-999.1',
    name: 'Ghost Peak',
    date: '2022-01-01',
    day_suffix: null,
    pb_ref: { pb_order: 1, pb_id: '2829', ascent_id: '1' },
  };
  const r = reconcile(buildInput({ cidCompletions: [bad] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('does not reference an active canonical id') || e.includes('unknown crosswalk reference')));
});

test('rejection: a completion that resolves to the suspended Pilot Knob fails', () => {
  // Force a crosswalk entry mapping some pb_order to the suspended spk-1.1.
  const entry = XW.entries[0];
  const crosswalk = XW.entries.map((e) => (e.pb_order === entry.pb_order ? { ...e, sps_id: 'spk-1.1' } : e));
  const comp: Completion = {
    sps_id: 'spk-1.1',
    name: 'Pilot Knob',
    date: '2022-01-01',
    day_suffix: null,
    pb_ref: { pb_order: entry.pb_order, pb_id: entry.pb_id, ascent_id: '1' },
  };
  const r = reconcile(buildInput({ crosswalk, cidCompletions: [comp] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('suspended Pilot Knob') || e.includes('spk-1.1')));
});

test('rejection: prototype (design-mock) date fails', () => {
  // Take a real completion and overwrite its date with a known mock date.
  const base = CID.completions[0];
  const bad: Completion = { ...base, date: '2017-05-27' };
  const r = reconcile(buildInput({ cidCompletions: [bad] }));
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes('prototype') || e.includes('2017-05-27')),
    `expected a prototype-date rejection, got: ${r.errors.join(' | ')}`,
  );
});

test('rejection: count drift (peakbagger 246 rows) fails', () => {
  const r = reconcile(buildInput({ lidRows: LID.rows.slice(0, 246) }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Peakbagger lid=5051 row count 246')));
});

test('serialization is deterministic', () => {
  const a = reconcileToJson(happy, '1.0.0');
  const b = reconcileToJson(happy, '1.0.0');
  assert.equal(a, b);
  const parsed = JSON.parse(a) as { peaks: CanonicalPeak[]; counts: { canonical_active: number } };
  assert.equal(parsed.counts.canonical_active, 247);
  assert.equal(parsed.peaks.length, 247);
});
