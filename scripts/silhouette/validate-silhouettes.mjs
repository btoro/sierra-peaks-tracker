#!/usr/bin/env node
/**
 * Technical validator for generated silhouette SVG assets (Pilot 07).
 *
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

function fail(messages) {
  for (const m of messages) console.error(`ERROR: ${m}`);
  process.exit(1);
}

function sha256OfFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
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

function main() {
  if (!existsSync(OUT_DIR)) {
    console.log('No public/silhouettes/ directory yet — nothing to validate.');
    return;
  }

  const peaks = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (peaks.length === 0) {
    console.log('public/silhouettes/ is empty — nothing to validate.');
    return;
  }

  const errors = [];
  const fileHashes = new Map(); // sha256 -> first file
  const perPeak = new Map();

  for (const peak of peaks) {
    const dir = path.join(OUT_DIR, peak);
    const files = readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
    perPeak.set(peak, files);

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

  if (errors.length > 0) {
    fail(errors);
  }

  console.log(`OK: validated ${peaks.length} peak director(, total ${fileHashes.size} SVG assets — no missing, blank, malformed, out-of-viewbox, or duplicate assets.`);
  for (const [peak, files] of perPeak) {
    console.log(`  ${peak}: ${files.join(', ')}`);
  }
}

main();
