import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseTsv, summary, toJson, SPS_EXPECTED_ROWS } from './sps.ts';
import { SPS_SOURCE_ID } from './schema.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SNAPSHOT_PATH = path.join(
  ROOT,
  'snapshots/sierraclub/sp-s-29-2025/sps-list-29th-2025.tsv',
);

const TSV = readFileSync(SNAPSHOT_PATH, 'utf8');

function parseOk(text: string) {
  const r = parseTsv(text);
  assert.equal(r.ok, true, r.ok ? '' : `expected ok, got errors: ${r.errors.join(' | ')}`);
  return r;
}

function parseErr(text: string, needle: string) {
  const r = parseTsv(text);
  assert.equal(r.ok, false, 'expected validation failure');
  assert.ok(
    r.errors.some((e) => e.includes(needle)),
    `expected an error containing ${JSON.stringify(needle)}, got: ${r.errors.join(' | ')}`,
  );
}

test('committed SPS snapshot validates: 248 rows, 247 active, 1 suspended, 24 areas', () => {
  const r = parseOk(TSV);
  assert.equal(r.rows.length, SPS_EXPECTED_ROWS);
  assert.equal(summary(r).areas, 24);
  assert.equal(summary(r).active, 247);
  assert.equal(summary(r).suspended, 1);
});

test('canonical ids are spk-<section>.<seq> and unique', () => {
  const r = parseOk(TSV);
  const ids = new Set<string>();
  for (const row of r.rows) {
    const expected = `spk-${row.sps_section}.${row.sps_seq}`;
    assert.equal(row.id, expected);
    assert.ok(!ids.has(row.id), `duplicate id ${row.id}`);
    ids.add(row.id);
  }
  assert.equal(ids.size, SPS_EXPECTED_ROWS);
});

test('source section and document order are preserved (contiguous 1..24; 1..n per section)', () => {
  const r = parseOk(TSV);
  assert.deepEqual(
    r.areas.map((a) => a.section),
    Array.from({ length: 24 }, (_, i) => i + 1),
  );
  const bySection = new Map<number, number[]>();
  for (const row of r.rows) {
    bySection.set(row.sps_section, [...(bySection.get(row.sps_section) ?? []), row.sps_seq]);
  }
  for (const [section, seqs] of bySection) {
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), `section ${section}`);
  }
});

test('raw fields are preserved unchanged from the TSV snapshot', () => {
  const r = parseOk(TSV);
  const lines = TSV.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('@AREA'));
  assert.equal(r.rows.length, lines.length);
  const areaName = new Map(r.areas.map((a) => [a.section, a.name]));
  for (const [i, row] of r.rows.entries()) {
    const [id, name, elev, cls, utm, maps, em, mn, sus] = lines[i].split('\t');
    assert.equal(row.name, name, `row ${id} name`);
    assert.equal(row.elevation_raw, elev, `row ${id} elevation_raw`);
    assert.equal(row.class_raw, cls, `row ${id} class_raw`);
    assert.equal(row.utm_raw, utm === '-' ? '' : utm, `row ${id} utm_raw`);
    assert.equal(row.maps_raw, maps === '-' ? '' : maps, `row ${id} maps_raw`);
    assert.equal(row.emblem, em === '1', `row ${id} emblem`);
    assert.equal(row.mountaineer, mn === '1', `row ${id} mountaineer`);
    assert.equal(row.suspended, sus === '1', `row ${id} suspended`);
    assert.equal(row.area, areaName.get(row.sps_section), `row ${id} area name`);
  }
});

test('fixture anchors: suspended Pilot Knob at 1.1; Mount Emerson class "3" at 16.2', () => {
  const r = parseOk(TSV);
  const pk = r.rows.find((row) => row.sps_section === 1 && row.sps_seq === 1);
  assert.ok(pk, 'Pilot Knob row at 1.1');
  assert.equal(pk.name, 'Pilot Knob (S)');
  assert.equal(pk.suspended, true);
  assert.equal(pk.id, 'spk-1.1');
  const em = r.rows.find((row) => row.sps_section === 16 && row.sps_seq === 2);
  assert.ok(em, 'Mount Emerson row at 16.2');
  assert.equal(em.name, 'Mt Emerson');
  assert.equal(em.class_raw, '3');
  assert.equal(em.suspended, false);
});

test('duplicate SPS section ids are rejected', () => {
  parseErr(TSV + '@AREA\t9\tDUP AREA\n', 'duplicate SPS section id 9');
});

test('missing sections are rejected (count drift on areas)', () => {
  const lines = TSV.split('\n');
  const filtered = lines.filter((l) => !l.startsWith('@AREA\t13\t') && !l.startsWith('13.'));
  parseErr(filtered.join('\n'), 'missing SPS section 13');
});

test('duplicate row ids are rejected', () => {
  const lines = TSV.split('\n');
  const dupIdx = lines.findIndex((l) => l.startsWith('4.7\t'));
  const dup = lines.slice();
  dup.splice(dupIdx + 1, 0, lines[dupIdx]);
  parseErr(dup.join('\n'), 'duplicate SPS row id "4.7"');
});

test('non-contiguous within-section seq is rejected', () => {
  const lines = TSV.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('1.5\t'));
  lines.splice(idx, 1); // drop 1.5 -> seqs 1..4,6,7..10 -> a gap
  parseErr(lines.join('\n'), 'seq not contiguous');
});

test('malformed rows are rejected: field count, id shape, elevation, class, UTM', () => {
  const mk = (row: string) => TSV.replace('4.7\tMT WHITNEY\t14491\t1\t-\tMount Whitney^ Mt Langley^ (E)\t1\t0\t0', row);

  parseErr(mk('4.7\tMT WHITNEY\t14491\t1\t-\tmaps\t1\t0'), 'expected 9 tab-separated fields');
  parseErr(mk('x.7\tMT WHITNEY\t14491\t1\t-\tmaps\t1\t0\t0'), 'malformed row id');
  parseErr(mk('99.7\tMT WHITNEY\t14491\t1\t-\tmaps\t1\t0\t0'), 'undeclared SPS section 99');
  parseErr(mk('4.7\tMT WHITNEY\t144\t1\t-\tmaps\t1\t0\t0'), 'malformed elevation_raw');
  parseErr(mk('4.7\tMT WHITNEY\t14491\t5.4x\t-\tmaps\t1\t0\t0'), 'malformed class_raw');
  parseErr(mk('4.7\tMT WHITNEY\t14491\t1\t01234\tmaps\t1\t0\t0'), 'malformed utm_raw');
  parseErr(mk('4.7\tMT WHITNEY\t14491\t1\t-\tmaps\t2\t0\t0'), 'flag must be "0" or "1"');
});

test('suspended flag outside section 1.1 is rejected', () => {
  parseErr(
    TSV.replace('2.1\tKern Peak\t11510\t1\t-\tKern Peak Casa Vieja Mdws (S)\t0\t0\t0',
      '2.1\tKern Peak\t11510\t1\t-\tKern Peak Casa Vieja Mdws (S)\t0\t0\t1'),
    'suspended outside SPS section 1.1',
  );
});

test('emblem + mountaineer simultaneously is rejected', () => {
  parseErr(
    TSV.replace('2.1\tKern Peak\t11510\t1\t-\tKern Peak Casa Vieja Mdws (S)\t0\t0\t0',
      '2.1\tKern Peak\t11510\t1\t-\tKern Peak Casa Vieja Mdws (S)\t1\t1\t0'),
    'both emblem and mountaineer',
  );
});

test('fixture drift is rejected: Emerson not class 3; Pilot Knob not suspended', () => {
  parseErr(
    TSV.replace('16.2\tMt Emerson\t13204\t3\t534229\tMt Darwin Mt Thompson (E)\t0\t0\t0',
      '16.2\tMt Emerson\t13204\t2\t534229\tMt Darwin Mt Thompson (E)\t0\t0\t0'),
    'Mount Emerson must be SPS 16.2 with class_raw "3"',
  );
  parseErr(
    TSV.replace('1.1\tPilot Knob (S)\t6200+\t2\t-\tOnyx\t0\t0\t1',
      '1.1\tPilot Knob (S)\t6200+\t2\t-\tOnyx\t0\t0\t0'),
    'Pilot Knob must be the suspended row at SPS section 1.1',
  );
});

test('row count drift is rejected (one row removed)', () => {
  const lines = TSV.split('\n');
  lines.splice(lines.findIndex((l) => l.startsWith('24.9\t')), 1);
  parseErr(lines.join('\n'), 'count drift: expected 248 SPS rows');
});

test('toJson is deterministic and round-trips through parseTsv', () => {
  const r = parseOk(TSV);
  const a = toJson(r, '1.0.0');
  const b = toJson(parseOk(TSV), '1.0.0');
  assert.equal(a, b, 'byte-for-byte deterministic output');
  const doc = JSON.parse(a);
  assert.equal(doc.source.source_id, SPS_SOURCE_ID);
  assert.equal(doc.source.parser_version, '1.0.0');
  assert.equal(doc.rows.length, SPS_EXPECTED_ROWS);
  assert.equal(doc.areas.length, 24);
  // The suspended row is retained in the source dataset (not dropped).
  assert.equal(doc.rows.filter((row: { suspended: boolean }) => row.suspended).length, 1);
});
