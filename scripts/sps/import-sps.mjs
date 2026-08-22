#!/usr/bin/env node
/**
 * Deterministic SPS importer CLI (Pilot 03).
 *
 * Reads the vendored TSV snapshot
 *   snapshots/sierraclub/sp-s-29-2025/sps-list-29th-2025.tsv
 * verifies it against data/manifest.json (checksum + expected counts),
 * parses + hard-validates it (frozen contract, docs/data-contract.md §4),
 * and emits the normalized dataset
 *   data/sps/sp-s-29-2025.json  (248 rows: 247 active + 1 suspended)
 *
 * Usage:
 *   node scripts/sps/import-sps.mjs            # import (write normalized JSON)
 *   node scripts/sps/import-sps.mjs --dry-run  # verify + print summary/diff, write nothing
 *   node scripts/sps/import-sps.mjs --check    # verify; exit 1 if committed data would drift
 *
 * Determinism: output is a pure function of (TSV bytes, parser version).
 * CI runs --check so a committed data file that the importer cannot
 * reproduce byte-for-byte fails the build (frozen §5, step 4).
 *
 * This is an offline tool: it never fetches anything from the network.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseTsv, summary, toJson } from '../../src/data/sps/sps.ts';

const PARSER_VERSION = '1.0.0';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT_REL = 'snapshots/sierraclub/sp-s-29-2025/sps-list-29th-2025.tsv';
const MANIFEST_REL = 'data/manifest.json';
const OUTPUT_REL = 'data/sps/sp-s-29-2025.json';

function fail(message) {
  console.error(`SPS import FAILED: ${message}`);
  process.exitCode = 1;
  process.exit(1);
}

function sha256OfFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
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
  const spsSource = manifest?.sources?.sierraclub?.['sp-s-29-2025'] ?? null;
  if (!spsSource) fail(`manifest missing sources.sierraclub["sp-s-29-2025"]`);

  // ---- 2. Load + checksum the vendored TSV snapshot
  const snapshotAbs = path.join(ROOT, SNAPSHOT_REL);
  if (!existsSync(snapshotAbs)) fail(`missing vendored snapshot: ${SNAPSHOT_REL}`);
  const snapshotSha = sha256OfFile(snapshotAbs);
  const expectedFile = spsSource?.files?.[SNAPSHOT_REL];
  if (!expectedFile?.sha256) fail(`manifest missing sha256 for ${SNAPSHOT_REL}`);
  if (expectedFile.sha256 !== snapshotSha) {
    fail(
      `checksum drift: ${SNAPSHOT_REL}\n` +
        `  manifest: ${expectedFile.sha256}\n` +
        `  actual:   ${snapshotSha}`,
    );
  }
  const tsvText = readFileSync(snapshotAbs, 'utf8');

  // ---- 3. Parse + hard-validate (frozen contract §4)
  const parsed = parseTsv(tsvText);
  if (!parsed.ok) {
    fail(`snapshot failed validation:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  const counts = spsSource?.expected_counts;
  if (!counts) fail('manifest missing expected_counts for the SPS source');
  const s = summary(parsed);
  const drift = [
    counts.total !== s.rows && `total ${s.rows} != ${counts.total}`,
    counts.active !== s.active && `active ${s.active} != ${counts.active}`,
    counts.suspended !== s.suspended && `suspended ${s.suspended} != ${counts.suspended}`,
    counts.sections !== s.areas && `sections ${s.areas} != ${counts.sections}`,
  ].filter(Boolean);
  if (drift.length > 0) {
    fail(`manifest count drift vs parsed snapshot: ${drift.join('; ')}`);
  }

  // ---- 4. Deterministic output
  const outText = toJson(parsed, PARSER_VERSION);
  const outSha = createHash('sha256').update(outText).digest('hex');

  const existing = existsSync(path.join(ROOT, OUTPUT_REL))
    ? readFileSync(path.join(ROOT, OUTPUT_REL), 'utf8')
    : null;

  console.log(`[sps-import ${mode}] sp-s-29-2025 parser v${PARSER_VERSION}`);
  console.log(
    `  snapshot ${SNAPSHOT_REL} sha256 ${snapshotSha} (matches manifest)`,
  );
  console.log(
    `  rows=${s.rows} (active=${s.active} suspended=${s.suspended}) areas=${s.areas} ` +
      `emblem=${s.emblem} mountaineer=${s.mountaineer} utm=${s.utm}`,
  );

  if (mode === 'import') {
    const outAbs = path.join(ROOT, OUTPUT_REL);
    mkdirSync(path.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, outText);
    console.log(`  wrote ${OUTPUT_REL} sha256 ${outSha}`);
    return;
  }

  if (existing === null) {
    console.log(`  ${mode}: would CREATE ${OUTPUT_REL} (sha256 ${outSha}) — nothing written`);
  } else if (existing === outText) {
    console.log(`  ${mode}: ${OUTPUT_REL} is up to date (reproduces byte-for-byte) — nothing written`);
  } else {
    const diffLines = unifiedDiff(existing, outText);
    console.log(`  ${mode}: ${OUTPUT_REL} would CHANGE — nothing written:\n`);
    console.log(diffLines);
    if (mode === 'check') {
      fail('committed normalized data does not reproduce from the committed snapshot (drift)');
    }
  }
}

/** Minimal unified diff for human review of --dry-run / --check output. */
function unifiedDiff(a, b, maxLines = 200) {
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

main();
