#!/usr/bin/env node
/**
 * Deterministic Peakbagger importer CLI (Pilot 04).
 *
 * Reads the two vendored, authorized local snapshots
 *   snapshots/peakbagger/lid-5051/2026-08-22/lid-5051.html
 *   snapshots/peakbagger/cid-30050/2026-08-22/cid-30050.html
 * verifies them against data/manifest.json (checksums + expected counts),
 * parses + hard-validates them (frozen contract, docs/data-contract.md §2/§5),
 * and emits the three normalized data files:
 *   data/peakbagger/lid-5051.json    (247 rows, source order)
 *   data/crosswalk.json              (247 explicit 1:1 SPS↔PB entries)
 *   data/peakbagger/cid-30050.json   (only real public completions)
 *
 * Usage:
 *   node scripts/peakbagger/import-pb.mjs            # import (write all three)
 *   node scripts/peakbagger/import-pb.mjs --dry-run  # verify + print diffs, write nothing
 *   node scripts/peakbagger/import-pb.mjs --check    # verify; exit 1 if committed data would drift
 *
 * Determinism: each output is a pure function of (snapshot bytes, SPS
 * normalized rows, parser version). CI/refresh runs --check so committed data
 * that the importer cannot reproduce byte-for-byte fails the build
 * (frozen §5, step 4).
 *
 * This is an offline tool: it never fetches anything from the network. The
 * SPS side is read from the committed data/sps/sp-s-29-2025.json (Pilot 03
 * output); its own drift gate is `pnpm check:sps`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  parseList,
  parseOverlay,
  overlayMatchesList,
  buildCrosswalk,
  resolveCompletions,
  listToJson,
  crosswalkToJson,
  completionsToJson,
} from '../../src/data/peakbagger/pb.ts';

const PARSER_VERSION = '1.0.0';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LID_SNAPSHOT_REL = 'snapshots/peakbagger/lid-5051/2026-08-22/lid-5051.html';
const CID_SNAPSHOT_REL = 'snapshots/peakbagger/cid-30050/2026-08-22/cid-30050.html';
const MANIFEST_REL = 'data/manifest.json';
const SPS_DATA_REL = 'data/sps/sp-s-29-2025.json';
const LID_OUTPUT_REL = 'data/peakbagger/lid-5051.json';
const XWALK_OUTPUT_REL = 'data/crosswalk.json';
const CID_OUTPUT_REL = 'data/peakbagger/cid-30050.json';

function fail(message) {
  console.error(`Peakbagger import FAILED: ${message}`);
  process.exit(1);
}

function sha256OfFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function verifySnapshot(manifest, sourceKey, relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) fail(`missing vendored snapshot: ${relPath}`);
  const sha = sha256OfFile(abs);
  const expected = manifest?.sources?.peakbagger?.[sourceKey]?.files?.[relPath]?.sha256;
  if (!expected) fail(`manifest missing sha256 for ${relPath}`);
  if (expected !== sha) {
    fail(
      `checksum drift: ${relPath}\n  manifest: ${expected}\n  actual:   ${sha}`,
    );
  }
  return readFileSync(abs, 'utf8');
}

function checkCounts(manifest, sourceKey, checks) {
  const expected = manifest?.sources?.peakbagger?.[sourceKey]?.expected_counts;
  if (!expected) fail(`manifest missing expected_counts for ${sourceKey}`);
  const drift = checks
    .filter(Boolean)
    .map(([label, got, want]) =>
      got !== want ? `${sourceKey} count drift: ${label} ${got} != ${want}` : null,
    )
    .filter(Boolean);
  if (drift.length > 0) fail(drift.join('; '));
}

/** Minimal unified diff for human review of --dry-run / --check output. */
function unifiedDiff(a, b, maxLines = 400) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out = [];
  const max = Math.max(al.length, bl.length);
  let changed = 0;
  for (let i = 0; i < max; i += 1) {
    const la = al[i];
    const lb = bl[i];
    if (la === lb) {
      out.push(` ${la ?? ''}`);
      continue;
    }
    changed += 1;
    if (la !== undefined) out.push(`-${la}`);
    if (lb !== undefined) out.push(`+${lb}`);
  }
  if (out.length > maxLines) {
    out.push(`... (${out.length - maxLines} more diff lines)`);
    out.length = maxLines;
  }
  if (changed === 0) out.push('(no changes)');
  return out.join('\n');
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.size > 1) fail(`unsupported combination of flags: ${[...args].join(' ')}`);
  const mode = args.has('--dry-run') ? 'dry-run' : args.has('--check') ? 'check' : 'import';

  // ---- 1. Load manifest (provenance + expected checksums/counts)
  const manifestAbs = path.join(ROOT, MANIFEST_REL);
  if (!existsSync(manifestAbs)) fail(`missing manifest: ${MANIFEST_REL}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestAbs, 'utf8'));
  } catch (err) {
    fail(`manifest is not valid JSON: ${err.message}`);
  }

  // ---- 2. Load + checksum both vendored snapshots
  const lidText = verifySnapshot(manifest, 'lid-5051', LID_SNAPSHOT_REL);
  const cidText = verifySnapshot(manifest, 'cid-30050', CID_SNAPSHOT_REL);

  // ---- 3. Load the committed SPS normalized rows (Pilot 03 output)
  const spsAbs = path.join(ROOT, SPS_DATA_REL);
  if (!existsSync(spsAbs)) fail(`missing SPS normalized data: ${SPS_DATA_REL} (run Pilot 03 first)`);
  let spsDoc;
  try {
    spsDoc = JSON.parse(readFileSync(spsAbs, 'utf8'));
  } catch (err) {
    fail(`SPS data is not valid JSON: ${err.message}`);
  }
  if (spsDoc?.source?.source_id !== 'sp-s-29-2025') {
    fail(`SPS data source_id mismatch (got ${JSON.stringify(spsDoc?.source?.source_id)}); the crosswalk is pinned to the 29th Edition`);
  }
  if (spsDoc?.rows?.length !== 248) fail(`SPS data row count ${spsDoc?.rows?.length} != 248`);

  // ---- 4. Parse + hard-validate both snapshots (frozen §5)
  const lid = parseList(lidText);
  if (!lid.ok) fail(`lid=5051 snapshot failed validation:\n${lid.errors.map((e) => `  - ${e}`).join('\n')}`);
  const cid = parseOverlay(cidText);
  if (!cid.ok) fail(`cid=30050 snapshot failed validation:\n${cid.errors.map((e) => `  - ${e}`).join('\n')}`);
  const overlayDrift = overlayMatchesList(cid.rows, lid.rows);
  if (overlayDrift.length > 0) {
    fail(`cid=30050 overlay is not the same 247 rows as lid=5051:\n${overlayDrift.map((e) => `  - ${e}`).join('\n')}`);
  }

  checkCounts(manifest, 'lid-5051', [
    ['total', lid.rows.length, 247],
  ]);
  checkCounts(manifest, 'cid-30050', [
    ['total', cid.rows.length, 247],
    ['completions', cid.dated.length, manifest?.sources?.peakbagger?.['cid-30050']?.expected_counts?.completions ?? 0],
  ]);

  // ---- 5. Crosswalk (frozen §2) + completion resolution (frozen §5)
  const xwalk = buildCrosswalk(spsDoc.rows, spsDoc.areas, lid.rows);
  if (!xwalk.ok) {
    fail(`crosswalk build failed:\n${xwalk.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  const completions = resolveCompletions(cid.dated, xwalk.entries);
  if (!completions.ok) {
    fail(`completion resolution failed:\n${completions.errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  // ---- 6. Deterministic outputs
  const lidOut = listToJson(lid.rows, PARSER_VERSION);
  const xwalkOut = crosswalkToJson(xwalk.entries, PARSER_VERSION);
  const cidOut = completionsToJson(completions.completions, PARSER_VERSION);

  console.log(`[pb-import ${mode}] peakbagger parser v${PARSER_VERSION}`);
  console.log(`  ${LID_SNAPSHOT_REL} sha256 ${sha256OfFile(path.join(ROOT, LID_SNAPSHOT_REL))} (matches manifest)`);
  console.log(`  ${CID_SNAPSHOT_REL} sha256 ${sha256OfFile(path.join(ROOT, CID_SNAPSHOT_REL))} (matches manifest)`);
  console.log(`  lid rows=${lid.rows.length} sections=${new Set(lid.rows.map((r) => r.pb_section)).size} (tied ranks: ${lid.rows.filter((r, i) => r.pb_rank !== i + 1).length} row(s))`);
  console.log(`  overlay rows=${cid.rows.length} dated=${cid.dated.length} crosswalk=${xwalk.entries.length} (fallback matches: ${xwalk.fallbackCount}) completions=${completions.completions.length}`);

  const outputs = [
    [LID_OUTPUT_REL, lidOut],
    [XWALK_OUTPUT_REL, xwalkOut],
    [CID_OUTPUT_REL, cidOut],
  ];

  if (mode === 'import') {
    for (const [rel, out] of outputs) {
      const abs = path.join(ROOT, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, out);
      console.log(`  wrote ${rel} sha256 ${createHash('sha256').update(out).digest('hex')}`);
    }
    return;
  }

  let anyChange = false;
  for (const [rel, out] of outputs) {
    const existing = existsSync(path.join(ROOT, rel)) ? readFileSync(path.join(ROOT, rel), 'utf8') : null;
    if (existing === null) {
      console.log(`  ${mode}: would CREATE ${rel} — nothing written`);
      anyChange = true;
    } else if (existing === out) {
      console.log(`  ${mode}: ${rel} is up to date (reproduces byte-for-byte) — nothing written`);
    } else {
      anyChange = true;
      console.log(`  ${mode}: ${rel} would CHANGE — nothing written:\n`);
      console.log(unifiedDiff(existing, out));
    }
  }
  if (mode === 'check' && anyChange) {
    fail('committed Peakbagger data does not reproduce from the committed snapshots (drift)');
  }
}

main();
