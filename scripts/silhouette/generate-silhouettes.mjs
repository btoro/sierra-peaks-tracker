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
 *   - `public/silhouettes/<spk-id>/<D>.svg` for D in N, E, S, W
 *   - `data/silhouettes/manifest.json` — compact source manifest with
 *     checksums, renderer version, and per-peak geometry summaries.
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
/**
 * Pilot 10 — per-peak preferred tile direction, recorded SEPARATELY from the
 * four canonical N/E/S/W assets (Pilot 09 review, recommendation 5). It is
 * curated review data, not engine output: the generator embeds it into the
 * manifest and fails if the file is missing or malformed, so it cannot drift
 * silently. It does NOT alter any generated SVG.
 */
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
 * Pilot 10 — true min/max elevation (m) of a committed DEM crop, computed
 * directly from the committed sample bytes (little-endian float32), skipping
 * the nodata sentinel. This is what the manifest `elevations` block should
 * record: the actual terrain range the silhouette was derived from. (The old
 * manifest populated this from the per-direction skyline min/max, which is the
 * normalized *render* range, not the DEM range — see Pilot 09 review,
 * defect 3.)
 */
function demMinMax(bytes, nodata) {
  // Re-decode the raw sample bytes so the range reflects exactly what is
  // committed on disk, independent of any in-memory Float32Array view.
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  let min = Infinity;
  let max = -Infinity;
  let finite = 0;
  for (let i = 0; i < f.length; i += 1) {
    const v = f[i];
    if (!Number.isFinite(v) || v === nodata) continue;
    finite += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (finite === 0) return { min_m: null, max_m: null, cells: 0 };
  const r2 = (n) => Math.round(n * 100) / 100;
  return { min_m: r2(min), max_m: r2(max), cells: finite };
}

/**
 * Pilot 10 — load the curated preferred tile direction per peak from
 * data/silhouettes/preferred.json. Returns a map { peak_id -> direction }.
 * Fails hard if the file is missing or any value is not a cardinal, so the
 * preferred direction can never be silently wrong.
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

/** Generate all four SVGs for a single peak. Returns { svgTexts, result, grid }. */
function generatePeak(peakId) {
  const meta = loadMeta(peakId);
  if (!meta) {
    fail(`no meta.json for ${peakId} at ${path.join(SAMPLES_DIR, peakId, `${peakId}.json`)}`);
  }
  const bytes = loadSample(peakId, meta);
  const grid = buildGrid(peakId, bytes, meta);
  const result = renderSilhouettes(grid, { rendererVersion: RENDERER_VERSION });

  const svgTexts = {};
  for (const d of result.directions) {
    svgTexts[d.direction] = renderSvg(result, d.direction);
  }
  return { meta, result, bytes, nodata: meta.nodata ?? -9999, svgTexts };
}

function buildManifest(peakIds, peakData, preferred) {
  const entries = peakIds.map((id) => {
    const { meta, result, bytes, nodata, svgTexts } = peakData[id];
    const svgs = {};
    for (const d of result.directions) {
      svgs[d.direction] = {
        path: `public/silhouettes/${id}/${d.direction}.svg`,
        sha256: sha256(Buffer.from(peakData[id].svgTexts[d.direction])),
      };
    }
    const dem = demMinMax(bytes, nodata);
    return {
      peak_id: id,
      peak_name: meta.peak_name ?? id,
      preferred_direction: preferred[id],
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
      svg: svgs,
      // True elevation range of the committed DEM crop (Pilot 10 fix, Pilot 09
      // defect 3): the terrain actually sampled, not the per-direction skyline
      // normalization range.
      elevations: {
        min_m: dem.min_m,
        max_m: dem.max_m,
        cells: dem.cells,
      },
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

  const peakData = {};
  for (const id of peakIds) {
    console.log(`[silhouette-gen] generating ${id}…`);
    peakData[id] = generatePeak(id);
  }

  const preferred = loadPreferred(peakIds);
  const manifest = buildManifest(peakIds, peakData, preferred);
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';

  const outputs = [];
  for (const id of peakIds) {
    for (const [dir, text] of Object.entries(peakData[id].svgTexts)) {
      outputs.push([`public/silhouettes/${id}/${dir}.svg`, text]);
    }
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
