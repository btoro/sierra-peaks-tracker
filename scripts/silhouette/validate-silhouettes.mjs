#!/usr/bin/env node
/**
 * Usage:
 *   node scripts/silhouette/validate-silhouettes.mjs
 *
 * Scans public/silhouettes/ (one flat subdirectory per spk id, one SVG per
 * cardinal direction) and fails on:
 *   - missing files: spk directory present but a direction SVG is missing
 *   - blank assets: no <svg> or <path> element, or a path with no drawing commands
 *   - malformed SVG: not well-formed XML, not exactly one root <svg>, path
 *     'd' attribute not a valid closed path (starts with M, ends with Z)
 *   - out-of-viewbox: path coordinates outside the declared viewBox
 *   - clipping: path extends past the viewBox bounds
 *   - duplicate: two SVG files with identical bytes (an error within a peak,
 *     or a hash collision between two different peaks)
 *
 * A well-formed silhouette may legitimately be a flat baseline slab, so the
 * blank check only flags assets with no drawing content at all.
 *
 * The validator is a technical gate only — it checks geometry, not source
 * provenance (that is the job of the manifest + data-refresh contract).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'public', 'silhouettes');
const DATA_DIR = path.join(ROOT, 'data', 'silhouettes');
const COORDS_JSON = path.join(DATA_DIR, 'coordinates.json');
const MANIFEST_JSON = path.join(DATA_DIR, 'manifest.json');

/** Official USGS 3DEP ImageServer service endpoint. */
const OFFICIAL_USGS_3DEP_SERVICE = /elevation\.nationalmap\.gov.*3DEPElevation.*ImageServer/i;
/** Marker that a source/retrieval described it as single-band F32. */
const F32_MARKER = /F32/i;

const EXPECTED_ALGORITHM_VERSION = '1.0.0';
const EXPECTED_RENDERER_VERSION = '1.0.0';
const DEM_BYTE_LENGTH = 16384; // 4096 little-endian float32 values
const MIN_ELEVATION = -500;  // meters, lower bound for plausible USGS DEM elevations
const MAX_ELEVATION = 5000; // meters, upper bound for plausible USGS DEM elevations

const WHITNEY_GAZ_NAME = 'Mount Whitney';
const WHITNEY_RASTER_ID = 120039;
const WHITNEY_SUMMIT_M = 4421; // Mount Whitney summit elevation (m)

function fail(messages) {
  for (const m of messages) console.error(`ERROR: ${m}`);
  process.exit(1);
}

function sha256OfFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/** Read and parse a JSON file, returning { ok, data } (ok=false on any error). */
function loadJson(file) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Little-endian decode of a Float32 buffer into its numeric values. */
function readFloat32LE(buffer) {
  const out = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  return Array.from(out);
}

/** A finite DEM elevation (meters) within the plausible USGS range. */
function isPlausibleElevation(v) {
  return v >= MIN_ELEVATION && v <= MAX_ELEVATION;
}

/** Strict-ish SVG well-formedness check: one root <svg>, no unbalanced tags. */
function isWellFormedSvg(content) {
  const trimmed = content.trim();
  if (!/^<svg\b/i.test(trimmed)) return { ok: false, reason: 'root element is not <svg>' };
  if (!trimmed.endsWith('</svg>') && !trimmed.endsWith('/>')) {
    return { ok: false, reason: 'document does not end with </svg>' };
  }
  const opens = (content.match(/<svg\b/gi) || []).length;
  if (opens !== 1) return { ok: false, reason: `expected exactly one <svg> root, found ${opens}` };
  // Every start tag (not self-closing) must have a matching close tag.
  const tagCounts = new Map();
  for (const raw of content.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?\/?>/g)) {
    const [ , slash, name ] = raw;
    if (slash === '/') tagCounts.set(name, (tagCounts.get(name) || 0) - 1);
    else if (!raw[0].endsWith('/>')) tagCounts.set(name, (tagCounts.get(name) || 0) + 1);
  }
  for (const [name, count] of tagCounts) {
    if (count !== 0) return { ok: false, reason: `unbalanced <${name}> tags (net ${count})` };
  }
  return { ok: true };
}

/** Parse the declared viewBox (minX minY width height) from the root <svg>. */
function parseViewBox(content) {
  const m = content.match(/<svg\b[^>]*\bviewBox\s*=\s*"([^"]+)"/i) ||
            content.match(/<svg\b[^>]*\bviewBox\s*=\s*'([^']+)"/i);
  if (!m) return null;
  const parts = m[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
}

/** Extract the 'd' attribute of the first (and only) <path> element. */
function extractPathD(content) {
  const m = content.match(/<path\b[^>]*\bd\s*=\s*"([^"]*)"/i) ||
            content.match(/<path\b[^>]*\bd\s*=\s*'([^']*)"/i);
  return m ? m[1] : null;
}

/** Parse path 'd' into numeric coordinate pairs (M/L commands only, in order). */
function parseCoords(d) {
  const tokens = d.match(/[MLL]\s*[-+]?[0-9]*\.?[0-9]+(\s+[-+]?[0-9]*\.?[0-9]+)?/gi) || [];
  const coords = [];
  for (const tok of tokens) {
    const cmd = tok[0];
    const nums = tok.slice(1).trim().split(/\s+/).filter((s) => s.length > 0).map(Number);
    if (nums.length === 1) coords.push({ x: nums[0], y: 0, implicitY: true });
    if (nums.length === 2) coords.push({ x: nums[0], y: nums[1], implicitY: false });
  }
  return coords;
}

function checkAsset(rel, content) {
  const errors = [];
  const wf = isWellFormedSvg(content);
  if (!wf.ok) return { errors: [`${rel}: malformed SVG — ${wf.reason}`], d: null, vb: null };

  const vb = parseViewBox(content);
  if (!vb) errors.push(`${rel}: malformed SVG — missing or unparseable viewBox`);

  const d = extractPathD(content);
  if (d === null) errors.push(`${rel}: no <path> element found (blank asset?)`);
  else {
    if (!d.trim().startsWith('M')) errors.push(`${rel}: path 'd' must start with M (absolute moveto)`);
    if (!d.trim().endsWith('Z')) errors.push(`${rel}: path 'd' must end with Z (closed path)`);

    const coords = parseCoords(d);
    if (coords.length === 0) errors.push(`${rel}: path 'd' has no drawing commands (blank asset?)`);
    else if (vb) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of coords) {
        minX = Math.min(minX, c.x);
        maxX = Math.max(maxX, c.x);
        if (!c.implicitY) {
          minY = Math.min(minY, c.y);
          maxY = Math.max(maxY, c.y);
        }
      }
      const eps = 0.5; // tolerate the fixed 2-decimal rounding at the boundary
      if (minX < vb.minX - eps || maxX > vb.minX + vb.width + eps) {
        errors.push(`${rel}: path x-range [${minX}, ${maxX}] out of viewBox x [${vb.minX}, ${vb.minX + vb.width}]`);
      }
      if (minY < vb.minY - eps || maxY > vb.minY + vb.height + eps) {
        errors.push(`${rel}: path y-range [${minY}, ${maxY}] out of viewBox y [${vb.minY}, ${vb.minY + vb.height}]`);
      }
    }
  }
  return { errors, d, vb };
}

/**
 * Validate a peak's DEM bin: exactly 16384 bytes = 4096 little-endian finite
 * float32 values falling in a plausible elevation range.
 */
function validateBin(binPath, peak, errors) {
  const buf = readFileSync(binPath);
  if (buf.byteLength !== DEM_BYTE_LENGTH) {
    errors.push(`${peak}: DEM bin is ${buf.byteLength} bytes, expected exactly ${DEM_BYTE_LENGTH} (4096 float32)`);
    return;
  }
  const values = readFloat32LE(buf);
  if (values.length !== 4096) {
    errors.push(`${peak}: DEM bin has ${values.length} float32 values, expected exactly 4096`);
    return;
  }
  let finite = 0, min = Infinity, max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    finite += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (finite !== 4096) {
    errors.push(`${peak}: DEM bin contains non-finite float32 values (only ${finite}/4096 finite)`);
  } else if (!isPlausibleElevation(min) || !isPlausibleElevation(max)) {
    errors.push(`${peak}: DEM bin elevation range [${min}, ${max}] is implausible (expected [${MIN_ELEVATION}, ${MAX_ELEVATION}] m)`);
  }
}

/**
 * Validate a peak's sidecar identifies official USGS 3DEP single-band F32
 * provenance and matches the manifest sample hash.
 */
function validateSidecar(obj, peak, manifestSampleSha256, errors) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`${peak}: sidecar is not a JSON object`);
    return;
  }
  if (obj.width !== 64 || obj.height !== 64) {
    errors.push(`${peak}: sidecar must be 64x64 (got ${obj.width}x${obj.height})`);
  }
  if (typeof obj.sample_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(obj.sample_sha256)) {
    errors.push(`${peak}: sidecar missing/invalid sample_sha256`);
  } else if (manifestSampleSha256 && obj.sample_sha256 !== manifestSampleSha256) {
    errors.push(`${peak}: sidecar sample_sha256 does not match manifest sample.sha256`);
  }
  if (typeof obj.source !== 'string' || !F32_MARKER.test(obj.source)) {
    errors.push(`${peak}: sidecar source must identify single-band F32 (official ImageServer)`);
  }
  if (typeof obj.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(obj.source_sha256)) {
    errors.push(`${peak}: sidecar missing/invalid source_sha256`);
  }
  if (typeof obj.retrieved_at !== 'string' || obj.retrieved_at.length === 0) {
    errors.push(`${peak}: sidecar missing retrieved_at`);
  }
  if (typeof obj.retrieval_method !== 'string' || !F32_MARKER.test(obj.retrieval_method)) {
    errors.push(`${peak}: sidecar retrieval_method must identify F32 provenance`);
  }
  if (typeof obj.coordinate_source !== 'string' || obj.coordinate_source.length === 0) {
    errors.push(`${peak}: sidecar missing coordinate_source`);
  }
  const prod = obj.source_product;
  if (!prod || typeof prod !== 'object') {
    errors.push(`${peak}: sidecar missing source_product`);
  } else {
    if (typeof prod.service !== 'string' || !OFFICIAL_USGS_3DEP_SERVICE.test(prod.service)) {
      errors.push(`${peak}: sidecar source_product.service must point to official USGS 3DEP ImageServer`);
    }
    if (!Number.isInteger(prod.raster_id)) {
      errors.push(`${peak}: sidecar source_product.raster_id must be an integer (USGS raster id)`);
    }
  }
}

/**
 * Validate a peak's manifest entry (peak_id, selected_direction, svg path/hash,
 * algorithm_version, renderer_version) against the single committed SVG file.
 */
function validateManifestEntry(entry, peak, svgFile, svgAbsPath, errors) {
  if (!entry || typeof entry !== 'object') {
    errors.push(`${peak}: manifest entry is not an object`);
    return null;
  }
  if (entry.peak_id !== peak) {
    errors.push(`${peak}: manifest peak_id ${entry.peak_id} does not match directory`);
  }
  if (svgFile && entry.selected_direction !== undefined && `${entry.selected_direction}.svg` !== svgFile) {
    errors.push(`${peak}: manifest selected_direction ${entry.selected_direction} does not match SVG ${svgFile}`);
  }
  if (entry.algorithm_version !== EXPECTED_ALGORITHM_VERSION) {
    errors.push(`${peak}: manifest algorithm_version ${entry.algorithm_version} unexpected (expected ${EXPECTED_ALGORITHM_VERSION})`);
  }
  if (entry.renderer_version !== EXPECTED_RENDERER_VERSION) {
    errors.push(`${peak}: manifest renderer_version ${entry.renderer_version} unexpected (expected ${EXPECTED_RENDERER_VERSION})`);
  }
  const svg = entry.svg;
  if (!svg || typeof svg !== 'object') {
    errors.push(`${peak}: manifest entry missing svg object`);
  } else {
    const expPath = `public/silhouettes/${peak}/${svgFile}`;
    if (svgFile && svg.path !== expPath) {
      errors.push(`${peak}: manifest svg.path ${svg.path} does not match expected ${expPath}`);
    }
    if (svgFile) {
      const actualHash = sha256OfFile(svgAbsPath);
      if (typeof svg.sha256 !== 'string' || svg.sha256 !== actualHash) {
        errors.push(`${peak}: manifest svg.sha256 does not match actual file hash`);
      }
    }
  }
  const sample = entry.sample;
  if (!sample || typeof sample !== 'object') {
    errors.push(`${peak}: manifest entry missing sample object`);
    return null;
  }
  if (sample.width !== 64 || sample.height !== 64) {
    errors.push(`${peak}: manifest sample must be 64x64 (got ${sample.width}x${sample.height})`);
  }
  return typeof sample.sha256 === 'string' ? sample.sha256 : null;
}

/**
 * Validate coordinates.json: an object with a "peaks" map of exactly 8 keys,
 * each with finite lat/lon and a unique coordinate pair. Returns the peaks map.
 */
function validateCoordinates(coords, errors) {
  if (!coords || typeof coords !== 'object' || Array.isArray(coords) ||
      !coords.peaks || typeof coords.peaks !== 'object' || Array.isArray(coords.peaks)) {
    errors.push('coordinates.json: expected an object with a "peaks" map of peak ids -> {lat, lon, ...}');
    return null;
  }
  const ids = Object.keys(coords.peaks);
  if (ids.length !== 8) {
    errors.push(`coordinates.json: expected exactly 8 peaks in "peaks", found ${ids.length}`);
  }
  const seenPairs = new Set();
  for (const id of ids) {
    const p = coords.peaks[id];
    if (!p || typeof p !== 'object') {
      errors.push(`coordinates.json: peak ${id} is not an object`);
      continue;
    }
    const lat = p.lat;
    const lon = p.lon;
    if (lat === undefined || !Number.isFinite(lat)) {
      errors.push(`coordinates.json: ${id} has non-finite or missing latitude`);
    }
    if (lon === undefined || !Number.isFinite(lon)) {
      errors.push(`coordinates.json: ${id} has non-finite or missing longitude`);
    }
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const pair = `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
      if (seenPairs.has(pair)) {
        errors.push(`coordinates.json: duplicate coordinate pair ${pair} (${id})`);
      }
      seenPairs.add(pair);
    }
  }
  return coords.peaks;
}

/** Find a peak id whose coordinates gaz_name equals the given name, or null. */
function peakIdByGazName(peaksMap, gazName) {
  for (const id of Object.keys(peaksMap || {})) {
    const p = peaksMap[id];
    if (p && typeof p === 'object' && p.gaz_name === gazName) return id;
  }
  return null;
}

function main() {
  const errors = [];

  // --- coordinates.json: object with a "peaks" map of exactly 8 ---
  let peaksMap = null;
  if (existsSync(COORDS_JSON)) {
    const { ok, data, error } = loadJson(COORDS_JSON);
    if (!ok) {
      errors.push(`coordinates.json: cannot parse — ${error}`);
    } else {
      peaksMap = validateCoordinates(data, errors);
    }
  } else {
    errors.push('coordinates.json not found (data/silhouettes/coordinates.json)');
  }

  if (!existsSync(OUT_DIR)) {
    errors.push('No public/silhouettes/ directory yet — nothing to validate.');
    fail(errors);
    return;
  }

  const peaks = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (peaks.length === 0) {
    errors.push('public/silhouettes/ is empty — nothing to validate.');
    fail(errors);
    return;
  }

  // --- exactly 8 unique peak IDs ---
  const uniquePeaks = new Set(peaks);
  if (peaks.length !== 8) {
    errors.push(`expected exactly 8 peak IDs under silhouettes/, found ${peaks.length}: ${peaks.join(', ')}`);
  } else if (uniquePeaks.size !== 8) {
    errors.push(`duplicate peak IDs found under silhouettes/ (${peaks.length} dirs, ${uniquePeaks.size} unique)`);
  }

  // --- load manifest.json exactly once ---
  const manifestById = new Map();
  if (existsSync(MANIFEST_JSON)) {
    const { ok, data, error } = loadJson(MANIFEST_JSON);
    if (!ok) {
      errors.push(`manifest.json: cannot parse — ${error}`);
    } else {
      if (!Array.isArray(data.peaks)) {
        errors.push('manifest.json: expected a "peaks" array');
      } else {
        if (data.peaks.length !== 8) {
          errors.push(`manifest.json: expected exactly 8 peak entries, found ${data.peaks.length}`);
        }
        for (const entry of data.peaks) {
          if (entry && typeof entry === 'object' && entry.peak_id) {
            manifestById.set(entry.peak_id, entry);
          }
        }
        if (manifestById.size !== 8) {
          errors.push(`manifest.json: expected 8 unique peak_id entries, found ${manifestById.size}`);
        }
      }
    }
  } else {
    errors.push('manifest.json not found (data/silhouettes/manifest.json)');
  }

  const fileHashes = new Map(); // sha256 -> first file
  const perPeak = new Map(); // peak -> [svg files]
  const sidecars = new Map(); // peak -> parsed sidecar object

  // --- parse each peak's sidecar JSON ---
  for (const peak of peaks) {
    const sidePath = path.join(DATA_DIR, peak, `${peak}.json`);
    if (!existsSync(sidePath)) {
      errors.push(`${peak}: missing sidecar (data/silhouettes/${peak}/${peak}.json)`);
      continue;
    }
    const { ok, data, error } = loadJson(sidePath);
    if (!ok) {
      errors.push(`${peak}: sidecar cannot parse — ${error}`);
      continue;
    }
    sidecars.set(peak, data);
  }

  for (const peak of peaks) {
    const dir = path.join(OUT_DIR, peak);
    const files = readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
    perPeak.set(peak, files);

    // --- exactly ONE selected SVG per peak ---
    if (files.length !== 1) {
      errors.push(`${peak}: expected exactly ONE selected SVG, found ${files.length}: ${files.join(', ')}`);
    }
    const svgFile = files.length === 1 ? files[0] : (files[0] || null);
    const svgAbs = svgFile ? path.join(dir, svgFile) : null;

    // --- manifest entry matches the single SVG ---
    const entry = manifestById.get(peak);
    const manifestSampleSha = entry ? validateManifestEntry(entry, peak, svgFile, svgAbs, errors) : null;
    if (!entry) {
      errors.push(`${peak}: no manifest entry with peak_id=${peak}`);
    }

    // --- DEM bin ---
    const binPath = path.join(DATA_DIR, peak, `${peak}.bin`);
    if (!existsSync(binPath)) {
      errors.push(`${peak}: missing DEM bin (data/silhouettes/${peak}/${peak}.bin)`);
    } else {
      validateBin(binPath, peak, errors);
    }

    // --- sidecar provenance ---
    const sideObj = sidecars.get(peak);
    if (sideObj) {
      validateSidecar(sideObj, peak, manifestSampleSha, errors);
    }

    // --- SVG geometry + duplicates (preserved) ---
    for (const f of files) {
      const abs = path.join(dir, f);
      if (!statSync(abs).isFile()) continue;
      const rel = `public/silhouettes/${peak}/${f}`;
      const content = readFileSync(abs, 'utf8');
      if (content.trim().length === 0) {
        errors.push(`${rel}: blank asset (empty file)`);
        continue;
      }
      const { errors: e2 } = checkAsset(rel, content);
      errors.push(...e2);

      const h = sha256OfFile(abs);
      if (fileHashes.has(h)) {
        const first = fileHashes.get(h);
        if (path.dirname(first) === path.dirname(rel)) {
          errors.push(`${rel}: duplicate — byte-identical to ${first}`);
        } else {
          errors.push(`${rel}: duplicate hash collision — byte-identical to ${first} (different peak)`);
        }
      } else {
        fileHashes.set(h, rel);
      }
    }
  }

  // --- Mount Whitney identified by gaz_name (spk-4.7), not spk-1.8 ---
  const whitneyId = peakIdByGazName(peaksMap, WHITNEY_GAZ_NAME);
  if (whitneyId) {
    const sideObj = sidecars.get(whitneyId);
    if (!sideObj || typeof sideObj !== 'object') {
      errors.push(`${whitneyId} (Mount Whitney): sidecar not parsed`);
    } else {
      const prod = sideObj.source_product;
      if (!prod || prod.raster_id !== WHITNEY_RASTER_ID) {
        errors.push(`${whitneyId} (Mount Whitney): must retain raster_id ${WHITNEY_RASTER_ID} (official USGS 3DEP), got ${prod && prod.raster_id}`);
      }
      const epqs = sideObj.epqs_elevation_m;
      if (typeof epqs !== 'number' || !Number.isFinite(epqs) || Math.abs(epqs - WHITNEY_SUMMIT_M) > 100) {
        errors.push(`${whitneyId} (Mount Whitney): epqs_elevation_m ${epqs} is not near the ${WHITNEY_SUMMIT_M} m summit`);
      }
    }
  }

  if (errors.length > 0) {
    fail(errors);
  }

  console.log(`OK: validated ${peaks.length} official-USGS peak directories (${fileHashes.size} SVG assets) — geometry, bins, sidecars, manifest, coordinates, and Whitney rasterId all checks passed.`);
  for (const [peak, files] of perPeak) {
    console.log(`  ${peak}: ${files.join(', ')}`);
  }
}

main();
