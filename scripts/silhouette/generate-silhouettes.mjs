#!/usr/bin/env node
/**
 * Deterministic 3DEP silhouette generator CLI (Pilot 07).
 *
 * Generates visible-skyline SVGs from USGS 3DEP 1/3 arc-second DEM data.
 *
 * Inputs:
 *   - Committed terrain sample: `data/silhouettes/<spk-id>/<spk-id>.bin`
 *     (little-endian float32, row-major, W->E columns, N->S rows).
 *   - Committed metadata sidecar: `data/silhouettes/<spk-id>/meta.json`
 *     (width, height, source checksums, provenance, peak location).
 *
 * Outputs:
 *   - `public/silhouettes/<spk-id>/<D>.svg` — exactly one outline SVG per
 *     pilot peak, at the selected direction D chosen from the preferred
 *     tile direction (data/silhouettes/preferred.json).
 *   - `data/silhouettes/manifest.json` — compact source manifest with
 *     checksums, renderer version, per-peak selected direction, and
 *     per-peak geometry summaries.
 *
 * Usage:
 *   node scripts/silhouette/generate-silhouettes.mjs            # generate all
 *   node scripts/silhouette/generate-silhouettes.mjs --check    # verify byte-reproducibility
 *   node scripts/silhouette/generate-silhouettes.mjs --dry-run  # print what would change
 *
 * Determinism: outputs are a pure function of (committed DEM bytes, meta.json,
 * renderer version, config). No wall-clock timestamps in output. No network.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// The TS engine is importable via Node's built-in TS type-stripping (Node 22.12+).
import {
  readTerrain,
  renderSilhouettes,
  renderSvg,
  artisticStyle,
  VIEWBOX_WIDTH,
  VIEWBOX_HEIGHT,
} from '../../src/data/silhouette.ts';

const RENDERER_VERSION = '1.0.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLES_DIR = path.join(ROOT, 'data', 'silhouettes');
const OUT_DIR = path.join(ROOT, 'public', 'silhouettes');
const MANIFEST_REL = 'data/silhouettes/manifest.json';
const PREFERRED_REL = 'data/silhouettes/preferred.json';

function fail(msg) {
  console.error(`[silhouette-gen] ERROR: ${msg}`);
  process.exit(1);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(abs) {
  return sha256(readFileSync(abs));
}

function loadMeta(peakId) {
  const metaPath = path.join(SAMPLES_DIR, peakId, `${peakId}.json`);
  if (!existsSync(metaPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (e) {
    fail(`invalid meta JSON at ${metaPath}: ${e.message}`);
  }
}

function loadSample(peakId, meta) {
  const binPath = path.join(SAMPLES_DIR, peakId, `${peakId}.bin`);
  if (!existsSync(binPath)) {
    fail(`missing terrain sample: ${binPath}`);
  }
  const bytes = readFileSync(binPath);
  // Verify checksum if recorded.
  if (meta.sample_sha256) {
    const actual = sha256(bytes);
    if (actual !== meta.sample_sha256) {
      fail(
        `checksum mismatch for ${peakId}.bin: expected ${meta.sample_sha256}, got ${actual}`,
      );
    }
  }
  return bytes;
}

function buildGrid(peakId, bytes, meta) {
  const width = meta.width;
  const height = meta.height;
  const expectedBytes = width * height * 4;
  if (bytes.length !== expectedBytes) {
    fail(
      `${peakId}.bin is ${bytes.length} bytes, expected ${expectedBytes} (${width}x${height} float32)`,
    );
  }
  return readTerrain(bytes, {
    width,
    height,
    sourceId: meta.source_id ?? `${peakId}-3dep`,
    peakId,
    sourceSha256: meta.sample_sha256 ?? null,
    nodata: meta.nodata ?? -9999,
  });
}

/**
 * Pilot 10 — load the curated preferred tile direction per peak from
 * data/silhouettes/preferred.json. Returns a map { peakId -> direction }.
 * Fails hard if the file is missing or any value is not a cardinal.
 */
function loadPreferred(peakIds) {
  const p = path.join(SAMPLES_DIR, 'preferred.json');
  if (!existsSync(p)) fail(`missing preferred direction file: ${p}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`invalid JSON in ${p}: ${e.message}`);
  }
  const map = {};
  for (const id of peakIds) {
    const v = doc.peak_id_map ? doc.peak_id_map[id] : doc[id];
    if (!['N', 'E', 'S', 'W'].includes(v)) {
      fail(`preferred.json: ${id} has non-cardinal preferred direction "${v}"`);
    }
    map[id] = v;
  }
  return map;
}

/** Generate one selected outline SVG for a single pilot peak.
 *  Direction comes from preferred.json (selected tile direction). */
function generatePeak(peakId, selectedDirection) {
  const meta = loadMeta(peakId);
  if (!meta) {
    fail(`no meta.json for ${peakId} at ${path.join(SAMPLES_DIR, peakId, `${peakId}.json`)}`);
  }
  const bytes = loadSample(peakId, meta);
  const grid = buildGrid(peakId, bytes, meta);
  const result = renderSilhouettes(grid, { rendererVersion: RENDERER_VERSION });
  const svgText = renderSvg(result, selectedDirection);
  return { meta, result, svgText, direction: selectedDirection };
}

function buildManifest(peakIds, peakData) {
  const entries = peakIds.map((id) => {
    const { meta, svgText } = peakData[id];
    // Per-peak elevation range: the actual min/max of the entire committed
    // .bin sample (all 4096 float32 cells), per the acceptance contract.
    // Read directly from the committed bytes so the manifest can only ever
    // reflect what is actually on disk.
    const binPath = path.join(SAMPLES_DIR, id, `${id}.bin`);
    const binBytes = readFileSync(binPath);
    const f32 = new Float32Array(binBytes.buffer, binBytes.byteOffset, binBytes.byteLength / 4);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < f32.length; i++) {
      const v = f32[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const elevations = { min_m: mn, max_m: mx };
    const svg = {
      path: `public/silhouettes/${id}/${peakData[id].direction}.svg`,
      sha256: sha256(Buffer.from(peakData[id].svgText)),
    };
    return {
      peak_id: id,
      peak_name: meta.peak_name ?? id,
      selected_direction: peakData[id].direction,
      algorithm_version: RENDERER_VERSION,
      sample: {
        file: `data/silhouettes/${id}/${id}.bin`,
        sha256: meta.sample_sha256 ?? null,
        width: meta.width,
        height: meta.height,
        source: meta.source ?? 'USGS 3DEP 1/3 arc-second',
        source_sha256: meta.source_sha256 ?? null,
        retrieved_at: meta.retrieved_at ?? null,
        retrieval_method: meta.retrieval_method ?? null,
        observer_lat: meta.observer_lat ?? null,
        observer_lon: meta.observer_lon ?? null,
        observer_elevation: meta.observer_elevation ?? null,
      },
      renderer_version: RENDERER_VERSION,
      svg,
      elevations,
    };
  });

  return {
    manifest_version: 1,
    renderer_version: RENDERER_VERSION,
    note: 'Generated silhouette assets. Geometry is deterministic from committed 3DEP terrain samples. Styling is a fixed versioned palette. See docs/silhouettes.md.',
    peaks: entries,
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.size > 1) fail(`unsupported combination of flags: ${[...args].join(' ')}`);
  const mode = args.has('--dry-run') ? 'dry-run' : args.has('--check') ? 'check' : 'generate';

  // Discover peaks from data/silhouettes/<id>/<id>.bin
  if (!existsSync(SAMPLES_DIR)) {
    console.log('[silhouette-gen] No terrain samples in data/silhouettes/ — nothing to generate.');
    return;
  }
  const peakIds = readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (peakIds.length === 0) {
    console.log('[silhouette-gen] No peak directories in data/silhouettes/ — nothing to generate.');
    return;
  }

  // Selected (preferred) tile direction per pilot peak.
  const selected = loadPreferred(peakIds);

  const peakData = {};
  for (const id of peakIds) {
    console.log(`[silhouette-gen] generating ${id} (${selected[id]})…`);
    peakData[id] = generatePeak(id, selected[id]);
  }

  const manifest = buildManifest(peakIds, peakData);
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';

  const outputs = [];
  for (const id of peakIds) {
    outputs.push([`public/silhouettes/${id}/${peakData[id].direction}.svg`, peakData[id].svgText]);
  }
  outputs.push([MANIFEST_REL, manifestText]);

  if (mode === 'generate') {
    for (const [rel, text] of outputs) {
      const abs = path.join(ROOT, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      console.log(`  wrote ${rel} sha256 ${sha256(Buffer.from(text))}`);
    }
    return;
  }

  // dry-run / check: compare against existing files
  let anyChange = false;
  for (const [rel, text] of outputs) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) {
      console.log(`  ${mode}: would CREATE ${rel}`);
      anyChange = true;
    } else {
      const existing = readFileSync(abs, 'utf8');
      if (existing === text) {
        console.log(`  ${mode}: ${rel} is up to date`);
      } else {
        anyChange = true;
        console.log(`  ${mode}: ${rel} would CHANGE`);
        // Print a short diff
        const oldLines = existing.split('\n');
        const newLines = text.split('\n');
        for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
          const o = oldLines[i];
          const n = newLines[i];
          if (o !== n) {
            if (o !== undefined) console.log(`    - ${o.slice(0, 120)}`);
            if (n !== undefined) console.log(`    + ${n.slice(0, 120)}`);
          }
        }
      }
    }
  }
  if (mode === 'check' && anyChange) {
    fail('committed silhouette outputs do not reproduce (drift detected)');
  }
}

main();
