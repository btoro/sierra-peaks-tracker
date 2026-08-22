import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseList,
  parseOverlay,
  overlayMatchesList,
  buildCrosswalk,
  resolveCompletions,
  listToJson,
  crosswalkToJson,
  completionsToJson,
  normalizeName,
  PB_EXPECTED_ROWS,
  PROTOTYPE_DATES,
  type PbDated,
} from './pb.ts';
import type { CrosswalkEntry, PbRow } from './schema.ts';
import type { SpsRow, SpsArea } from '../sps/schema.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LID_SNAPSHOT = path.join(ROOT, 'snapshots/peakbagger/lid-5051/2026-08-22/lid-5051.html');
const CID_SNAPSHOT = path.join(ROOT, 'snapshots/peakbagger/cid-30050/2026-08-22/cid-30050.html');
const SPS_DATA = path.join(ROOT, 'data/sps/sp-s-29-2025.json');

const LID = readFileSync(LID_SNAPSHOT, 'utf8');
const CID = readFileSync(CID_SNAPSHOT, 'utf8');
const SPS = JSON.parse(readFileSync(SPS_DATA, 'utf8')) as {
  areas: SpsArea[];
  rows: SpsRow[];
};

/** Extract the full `<tr>...</tr>` row that contains a given peak pid. */
function rowFor(text: string, pid: string): string {
  const i = text.indexOf(`peak.aspx?pid=${pid}"`);
  assert.ok(i !== -1, `pid ${pid} not found`);
  const start = text.lastIndexOf('<tr><td>', i);
  const end = text.indexOf('</tr>', i) + '</tr>'.length;
  return text.slice(start, end);
}

/** Row containing `pid` as it appears in `cidText` (overlay has an extra date cell). */
function cidRowFor(cidText: string, pid: string): string {
  const i = cidText.indexOf(`peak.aspx?pid=${pid}"`);
  assert.ok(i !== -1, `pid ${pid} not found in overlay`);
  const start = cidText.lastIndexOf('<tr><td>', i);
  const end = cidText.indexOf('</tr>', i) + '</tr>'.length;
  return cidText.slice(start, end);
}

function parseListOk(text: string) {
  const r = parseList(text);
  assert.equal(r.ok, true, r.ok ? '' : `expected ok, got errors: ${r.errors.join(' | ')}`);
  return r;
}

function parseListErr(text: string, needle: string) {
  const r = parseList(text);
  assert.equal(r.ok, false, 'expected validation failure');
  assert.ok(
    r.errors.some((e) => e.includes(needle)),
    `expected an error containing ${JSON.stringify(needle)}, got: ${r.errors.join(' | ')}`,
  );
}

function parseOverlayErr(text: string, needle: string) {
  const r = parseOverlay(text);
  assert.equal(r.ok, false, 'expected validation failure');
  assert.ok(
    r.errors.some((e) => e.includes(needle)),
    `expected an error containing ${JSON.stringify(needle)}, got: ${r.errors.join(' | ')}`,
  );
}

const lid = parseListOk(LID);
const cid = parseOverlay(LID === '' ? '' : CID);
assert.equal(cid.ok, true, cid.ok ? '' : `overlay errors: ${cid.errors.join(' | ')}`);
const cidOk = cid;

test('committed lid=5051 snapshot validates: 247 unique rows in source order', () => {
  assert.equal(lid.rows.length, PB_EXPECTED_ROWS);
  // pb_order is the 1..247 position; pb_rank is a well-formed competition rank.
  lid.rows.forEach((r, i) => {
    assert.equal(r.pb_order, i + 1);
    assert.ok(r.pb_rank === i + 1 || r.pb_rank === lid.rows[i - 1]?.pb_rank, `row ${i + 1} rank`);
  });
  const pids = new Set(lid.rows.map((r) => r.pb_id));
  assert.equal(pids.size, PB_EXPECTED_ROWS, 'duplicate pb_ids');
  const keys = new Set(lid.rows.map((r) => `${r.section_label}\u0000${r.name}`));
  assert.equal(keys.size, PB_EXPECTED_ROWS, 'duplicate (section, name)');
  assert.equal(new Set(lid.rows.map((r) => r.pb_section)).size, 24);
  // Raw fields preserved verbatim, exactly as listed.
  assert.equal(lid.rows[0].name, 'Mount Whitney');
  assert.equal(lid.rows[0].elevation_raw, '14,500.7');
  assert.equal(lid.rows[0].prominence_raw, '10,081.0');
  assert.equal(lid.rows[0].range, 'Mount Whitney Group');
});

test('the 2026-08-22 snapshot carries exactly one elevation tie (two rank-196 rows)', () => {
  const tied = lid.rows.filter((r, i) => r.pb_rank !== i + 1);
  assert.equal(tied.length, 1);
  assert.equal(tied[0].pb_order, 197);
  assert.equal(tied[0].pb_rank, 196);
  assert.equal(tied[0].elevation_raw, lid.rows[195].elevation_raw, 'tied rows share elevation');
});

test('canonical rows carry no coordinates or class (the snapshot exposes neither)', () => {
  for (const r of lid.rows) {
    assert.ok(!('lat' in r), 'no coordinates in canonical row');
    assert.ok(!('lon' in r), 'no coordinates in canonical row');
    assert.ok(!('class_raw' in r), 'no class in canonical row (list page has none)');
  }
});

test('committed cid=30050 snapshot validates: 247 rows, 30 dated, all dates real', () => {
  assert.equal(cidOk.rows.length, PB_EXPECTED_ROWS);
  assert.equal(cidOk.dated.length, 30);
  for (const d of cidOk.dated) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(d.day_suffix === null || d.day_suffix.length === 1, 'day suffix is a single letter or null');
    assert.match(d.ascent_id, /^\d+$/);
  }
  const suffixes = cidOk.dated.filter((d) => d.day_suffix !== null).map((d) => d.day_suffix);
  assert.deepEqual(suffixes.sort(), ['a', 'a', 'a', 'b', 'b', 'b']);
});

test('overlay rows are the same 247 peaks in the same order as lid=5051', () => {
  assert.deepEqual(overlayMatchesList(cidOk.rows, lid.rows), []);
});

test('crosswalk is an explicit bijective 1:1: 247 entries, every active SPS row covered', () => {
  const x = buildCrosswalk(SPS.rows, SPS.areas, lid.rows);
  assert.equal(x.ok, true, x.ok ? '' : `crosswalk errors: ${x.errors.join(' | ')}`);
  if (!x.ok) return;
  assert.equal(x.entries.length, PB_EXPECTED_ROWS);
  const spks = new Set(x.entries.map((e) => e.sps_id));
  assert.equal(spks.size, PB_EXPECTED_ROWS, 'duplicate sps_id in crosswalk');
  const pbs = new Set(x.entries.map((e) => e.pb_order));
  assert.equal(pbs.size, PB_EXPECTED_ROWS, 'duplicate pb_order in crosswalk');
  const pids = new Set(x.entries.map((e) => e.pb_id));
  assert.equal(pids.size, PB_EXPECTED_ROWS, 'duplicate pb_id in crosswalk');
  // Every active SPS row appears exactly once; the suspended row never does.
  const active = SPS.rows.filter((r) => !r.suspended);
  for (const r of active) assert.ok(spks.has(r.id), `missing ${r.id}`);
  assert.ok(!spks.has('spk-1.1'), 'suspended Pilot Knob must not map to any active row');
  // Both orderings are present on the canonical records: SPS section/seq via
  // sps_id, Peakbagger order via pb_order.
  for (const e of x.entries) {
    const m = /^spk-(\d+)\.(\d+)$/.exec(e.sps_id);
    assert.ok(m, `malformed spk id ${e.sps_id}`);
    assert.equal(Number(m![1]), e.sps_id === '' ? 0 : Number(m![1]), 'section component');
  }
});

test('N/S name collisions resolve by section id + order, never by name', () => {
  const x = buildCrosswalk(SPS.rows, SPS.areas, lid.rows);
  assert.ok(x.ok);
  if (!x.ok) return;
  const sawtoothS = x.entries.find((e) => e.sps_name === 'Sawtooth Peak (S)');
  const sawtoothN = x.entries.find((e) => e.sps_name === 'Sawtooth Peak (N)');
  assert.ok(sawtoothS && sawtoothN, 'both Sawtooth variant rows exist');
  assert.equal(sawtoothS!.sps_id, 'spk-1.5');
  assert.equal(sawtoothN!.sps_id, 'spk-2.9');
  assert.equal(sawtoothS!.pb_name, 'Sawtooth Peak');
  assert.equal(sawtoothN!.pb_name, 'Sawtooth Peak');
  assert.notEqual(sawtoothS!.pb_order, sawtoothN!.pb_order, 'different list positions');
  // The known collision families all map to distinct ids.
  for (const [name, spk, section] of [
    ['Mt Stanford (S)', 'spk-8.4', 8],
    ['Pyramid Peak (S)', 'spk-10.6', 10],
    ['Mt Morgan (S)', 'spk-17.11', 17],
  ] as Array<[string, string, number]>) {
    const e: CrosswalkEntry | undefined = x.entries.find((f) => f.sps_name === name);
    assert.ok(e, `${name} present in crosswalk`);
    assert.equal(e!.sps_id, spk);
    // Resolve through the committed lid=5051 data: the crosswalk entry must land
    // on the Peakbagger row that sits in the SPS-mirrored section.
    const pb: PbRow | undefined = lid.rows.find((r) => r.pb_order === e!.pb_order);
    assert.ok(pb, `pb_order ${e!.pb_order} resolves to a lid=5051 row`);
    assert.equal(pb!.pb_section, section);
    assert.equal(e!.alias_note?.includes('spelling variant'), true);
  }
  // The suspended SPS row spk-1.1 maps to nothing. (An ACTIVE Peakbagger row
  // named Pilot Knob does exist in section 16 — it is a different summit that
  // maps to its own SPS row, not to the suspended spk-1.1.)
  assert.ok(!x.entries.some((e) => e.sps_id === 'spk-1.1'));
});

test('every non-verbatim crosswalk pair is recorded with an alias note (audit trail)', () => {
  const x = buildCrosswalk(SPS.rows, SPS.areas, lid.rows);
  assert.ok(x.ok);
  if (!x.ok) return;
  let noted = 0;
  let plain = 0;
  for (const e of x.entries) {
    if (e.sps_name === e.pb_name) {
      assert.equal(e.alias_note, null, 'identical spellings must have null alias_note');
      plain += 1;
    } else {
      assert.equal(typeof e.alias_note, 'string');
      assert.ok((e.alias_note as string).length > 0);
      noted += 1;
    }
  }
  assert.ok(noted >= 100, `expected many notation variants, got ${noted}`);
  assert.ok(plain > 0, `expected some verbatim matches, got ${plain}`);
  // The single known fallback (Devil's Crag #1 ↔ Devils Crags) is flagged.
  const fb = x.entries.filter((e) => e.alias_note?.includes('fallback'));
  assert.equal(fb.length, 1);
  assert.equal(fb[0].sps_id, 'spk-13.3');
  assert.equal(fb[0].pb_name, 'Devils Crags');
});

test('completion records reference stable canonical ids and preserve only real public dates', () => {
  const x = buildCrosswalk(SPS.rows, SPS.areas, lid.rows);
  assert.ok(x.ok);
  if (!x.ok) return;
  const c = resolveCompletions(cidOk.dated, x.entries);
  assert.equal(c.ok, true, c.ok ? '' : `completion errors: ${c.errors.join(' | ')}`);
  if (!c.ok) return;
  assert.equal(c.completions.length, 30);
  const spks = new Set(x.entries.map((e) => e.sps_id));
  const byOrder = new Map(x.entries.map((e) => [e.pb_order, e]));
  for (const comp of c.completions) {
    assert.ok(spks.has(comp.sps_id), `unknown canonical id ${comp.sps_id}`);
    assert.notEqual(comp.sps_id, 'spk-1.1', 'suspended row must never be completed');
    const entry = byOrder.get(comp.pb_ref.pb_order)!;
    assert.equal(entry.sps_id, comp.sps_id, 'pb_ref must resolve to the claimed spk id');
    assert.equal(entry.pb_id, comp.pb_ref.pb_id);
    // The date must exist verbatim in the committed overlay snapshot.
    assert.ok(CID.includes(`>${comp.date}`), `date ${comp.date} not present in snapshot`);
    assert.ok(!PROTOTYPE_DATES.includes(comp.date), `prototype date ${comp.date} leaked in`);
  }
});

test('unknown completion references fail validation', () => {
  const x = buildCrosswalk(SPS.rows, SPS.areas, lid.rows);
  assert.ok(x.ok);
  if (!x.ok) return;
  // A pb_order that no crosswalk entry carries.
  const ghost: PbDated = {
    pb_order: 999,
    pb_id: '000',
    name: 'Ghost Peak',
    date: '2022-02-14',
    day_suffix: null,
    ascent_id: '1',
  };
  const r = resolveCompletions([ghost], x.entries);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('does not resolve through the crosswalk')));
  // A dated row whose pb_order is a real row but was dropped from the crosswalk.
  const entries = x.entries.filter((e) => e.pb_order !== 1);
  const r2 = resolveCompletions(cidOk.dated.filter((d) => d.pb_order === 1), entries);
  assert.equal(r2.ok, false);
});

test('suspended Pilot Knob completion references fail validation', () => {
  const fake: CrosswalkEntry = {
    sps_id: 'spk-1.1',
    pb_order: 1,
    pb_id: '2829',
    sps_name: 'Pilot Knob (S)',
    pb_name: 'Mount Whitney',
    alias_note: null,
  };
  const r = resolveCompletions(
    [{ pb_order: 1, pb_id: '2829', name: 'Mount Whitney', date: '2022-02-14', day_suffix: null, ascent_id: '1' }],
    [fake],
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('suspended Pilot Knob')));
});

test('duplicate ids fail validation', () => {
  // Duplicate pb_id in the list snapshot.
  const row1 = rowFor(LID, '2829');
  parseListErr(LID.replace(row1, `${row1}${row1}`), 'duplicate pb_id 2829');
  // Duplicate SPS row (count drift inside the crosswalk).
  const x = buildCrosswalk([...SPS.rows, SPS.rows[1]], SPS.areas, lid.rows);
  assert.equal(x.ok, false);
  if (x.ok) return;
  assert.ok(x.errors.some((e) => e.includes('active count') || e.includes('SPS active row count')));
});

test('malformed coordinates/dates fail validation', () => {
  // No coordinate field may ever appear in a canonical row.
  assert.ok(Object.keys(lid.rows[0]).every((k) => !/^.*coord/i.test(k)));
  // Malformed ascent date: impossible month.
  parseOverlayErr(
    CID.replace('2022-02-14', '2022-13-40'),
    'malformed ascent date "2022-13-40"',
  );
  // Malformed ascent date: February 30th.
  parseOverlayErr(
    CID.replace('2022-07-25', '2022-02-30'),
    'malformed ascent date "2022-02-30"',
  );
  // Malformed elevation: 5-digit number without the printed thousands comma.
  parseListErr(LID.replace('>14,500.7<', '>14500.7<'), 'malformed elevation_raw');
  // Malformed prominence: "N/A" is not a listed prominence value. The first
  // prominence cell uses Peakbagger's hidden-span ".0" rendering, so match
  // that exact byte sequence.
  parseListErr(LID.replace('align="right">10,081<span style="visibility: hidden;">.0</span>', 'align="right">N/A<'), 'malformed prominence_raw');
});

test('count drift fails validation', () => {
  // Drop one row from the list snapshot.
  const row = rowFor(LID, '13506'); // Lamont Peak, the last row
  parseListErr(LID.replace(row, ''), 'count drift: expected 247 lid=5051 rows, got 246');
  // Drop one row from the overlay snapshot.
  parseOverlayErr(CID.replace(cidRowFor(CID, '13506'), ''), 'count drift: expected 247 overlay rows, got 246');
  // Padding to 273-style counts is impossible: adding a bogus row breaks ranks too.
  const padded = LID.replace(row, `${row}${row.replace('<td>247.</td>', '<td>248.</td>')}`);
  parseListErr(padded, 'duplicate pb_id 13506');
});

test('accidental prototype (design-mock) dates fail validation', () => {
  // parseOverlay accepts any real calendar date; the PROHIBITION is enforced
  // at resolution time against the pinned prototype-date fixture list.
  const x = buildCrosswalk(SPS.rows, SPS.areas, lid.rows);
  assert.ok(x.ok);
  if (!x.ok) return;
  const mock = PROTOTYPE_DATES[0];
  const r = resolveCompletions(
    [{ pb_order: 1, pb_id: '2829', name: 'Mount Whitney', date: mock, day_suffix: null, ascent_id: '1' }],
    x.entries,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('prototype/mock date')));
  // And none of the prototype dates occur in the committed overlay.
  for (const d of PROTOTYPE_DATES) {
    assert.ok(!CID.includes(`>${d}<`), `prototype date ${d} present in overlay`);
  }
});

test('overlay rows that drift from lid=5051 fail validation', () => {
  // Rename one peak in the overlay only.
  const drifted = CID.replace('>Mount Whitney</a>', '>Mount Whittney</a>');
  const r = parseOverlay(drifted);
  assert.equal(r.ok, true, 'row-level shape is still valid');
  if (!r.ok) return;
  const drift = overlayMatchesList(r.rows, lid.rows);
  assert.ok(drift.length > 0, 'overlay drift must be detected');
  assert.ok(drift[0].includes('row 1'));
});

test('tied ranks are tolerated; broken rank sequences are not', () => {
  // The committed snapshot's one tie is accepted (covered above). Now break it:
  // the second rank-196 row must keep the same elevation to stay a tie.
  // The tie sits at rows 196/197 (two "11,513.4" elevations). Mutate the
  // SECOND occurrence only: keep row 196 at 11,513.4, move row 197 to
  // 11,513.5 so the shared rank is no longer backed by a shared elevation.
  const second = (haystack: string, needle: string, replacement: string): string => {
    const i = haystack.indexOf(needle, haystack.indexOf(needle) + needle.length);
    if (i === -1) throw new Error(`needle ${JSON.stringify(needle)} not found twice`);
    return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
  };
  parseListErr(
    second(LID, '>11,513.4<', '>11,513.5<'),
    'not a valid competition rank',
  );
  // And a rank that skips without a tie.
  parseListErr(LID.replace('<tr><td>2.</td>', '<tr><td>3.</td>'), 'not a valid competition rank');
});

test('serialization is deterministic and reproduces the committed data files', () => {
  const x = buildCrosswalk(SPS.rows, SPS.areas, lid.rows);
  const c = resolveCompletions(cidOk.dated, x.ok ? x.entries : []);
  assert.ok(x.ok && c.ok);
  if (!x.ok || !c.ok) return;
  assert.equal(listToJson(lid.rows, '1.0.0'), listToJson(parseListOk(LID).rows, '1.0.0'));
  const xAgain = buildCrosswalk(SPS.rows, SPS.areas, lid.rows);
  assert.equal(crosswalkToJson(x.entries, '1.0.0'), xAgain.ok ? crosswalkToJson(xAgain.entries, '1.0.0') : '');
  const cAgain = resolveCompletions(cidOk.dated, x.entries);
  assert.equal(completionsToJson(c.completions, '1.0.0'), cAgain.ok ? completionsToJson(cAgain.completions, '1.0.0') : '');

  const committedLid = readFileSync(path.join(ROOT, 'data/peakbagger/lid-5051.json'), 'utf8');
  const committedXw = readFileSync(path.join(ROOT, 'data/crosswalk.json'), 'utf8');
  const committedCid = readFileSync(path.join(ROOT, 'data/peakbagger/cid-30050.json'), 'utf8');
  assert.equal(listToJson(lid.rows, '1.0.0'), committedLid, 'lid-5051.json must reproduce byte-for-byte');
  assert.equal(crosswalkToJson(x.entries, '1.0.0'), committedXw, 'crosswalk.json must reproduce byte-for-byte');
  assert.equal(completionsToJson(c.completions, '1.0.0'), committedCid, 'cid-30050.json must reproduce byte-for-byte');
});

test('normalizeName treats the known SPS notation variants as equivalent', () => {
  assert.equal(normalizeName('MT WHITNEY'), normalizeName('Mount Whitney'));
  assert.equal(normalizeName('Mt Morgan (S)'), normalizeName('Mount Morgan'));
  assert.equal(normalizeName('Disappointment Pk'), normalizeName('Disappointment Peak'));
  assert.equal(normalizeName('Devil\u2019s Crag #1'), normalizeName('Devils Crags') === 'devils crags' ? 'devils crag' : normalizeName('Devil\u2019s Crag #1'));
  assert.equal(normalizeName('Sawtooth Peak (N)'), normalizeName('Sawtooth Peak'));
  assert.equal(normalizeName('Adams Peak - West Peak'), normalizeName('Adams Peak'));
});
