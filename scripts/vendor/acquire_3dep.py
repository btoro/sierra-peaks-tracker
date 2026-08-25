#!/usr/bin/env python3
"""
acquire_3dep.py — One-time tool to acquire genuine USGS 3DEP elevation crops
for the 8 pilot peaks in the Sierra Peaks Tracker.

Replaces the old OpenTopoMap hillshade proxy (acquire_3dep.py) which decoded
rendered map tile colours into a fake elevation scale. This tool downloads
raw numeric 3DEP float32 data from the official USGS 3DEP ArcGIS ImageServer.

Services (verified 2026-08-23, no credentials):
  - Coordinates: USGS National Map Gazetteer ArcGIS MapServer layer 5
  - Raster:      USGS 3DEP ImageServer exportImage (PNG32, F32, WGS84 bbox)
  - Point prov.: USGS EPQS (epqs.nationalmap.gov/v1/json)

Usage:
    python3 scripts/vendor/acquire_3dep.py            # acquire all 8 peaks
    python3 scripts/vendor/acquire_3dep.py spk-4.7    # acquire a single peak

Output:
    data/silhouettes/<id>/<id>.bin   (64×64 float32, little-endian, N→S rows)
    data/silhouettes/<id>/<id>.json  (full provenance metadata)

The raw tile cache lives in data/terrain/ (git-ignored, NOT committed).
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
from pathlib import Path

import numpy as np
import tifffile
import io

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data" / "silhouettes"
COORDINATES_FILE = DATA_DIR / "coordinates.json"
TERRAIN_DIR = ROOT / "data" / "terrain"

# 3DEP service
SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
UA = "sierra-peaks-tracker-pilot/1.0 (personal project; contact btoro93@gmail.com)"

# Crop geometry: 64×64 cells at 1/3 arc-second ≈ 356 m on a side
RES_ARCSEC = 1 / 3
CROP_CELLS = 64
HALF = CROP_CELLS // 2
HALF_DEG = HALF * RES_ARCSEC / 3600.0  # ≈ 0.0056 degrees

# Plausibility band for Sierra Nevada elevations (metres)
ELEV_MIN_M = 200.0
ELEV_MAX_M = 4450.0

# The 8 pilot peaks. Coordinates and gazetteer IDs come from the reviewed
# coordinate snapshot (data/silhouettes/coordinates.json), so this tool reads
# that committed file rather than hardcoding them. The hardcoded fallback
# below matches the snapshot as of 2026-08-23 and is used only if the file
# is missing.
PEAKS_FALLBACK = {
    "spk-4.7":  {"name": "Mount Whitney",     "gaz_id": 269051,  "lat": 36.578575123095334, "lon": -118.29243422748108},
    "spk-5.9":  {"name": "Mount Williamson",  "gaz_id": 1654980, "lat": 36.65595952978726,  "lon": -118.3110975117379},
    "spk-6.8":  {"name": "Mount Kaweah",      "gaz_id": 254846,  "lat": 36.52601461323106,  "lon": -118.4785650752989},
    "spk-18.6": {"name": "Mount Morgan",      "gaz_id": 263831,  "lat": 37.51132230042837,  "lon": -118.77984859951377},
    "spk-21.1": {"name": "Cathedral Peak",    "gaz_id": 254724,  "lat": 37.84783411454863,  "lon": -119.40563418390315},
    "spk-23.9": {"name": "Pyramid Peak",      "gaz_id": 265078,  "lat": 38.84487437562047,  "lon": -120.15779498883795},
    "spk-2.1":  {"name": "Kern Peak",         "gaz_id": 244274,  "lat": 36.30840796229331,  "lon": -118.28786524952068},
    "spk-1.8":  {"name": "Sirretta Peak",     "gaz_id": 249522,  "lat": 35.924305761295585, "lon": -118.33319702443303},
}


def load_peaks() -> dict:
    """Load peak coordinates from the reviewed snapshot, else the fallback."""
    if COORDINATES_FILE.exists():
        doc = json.loads(COORDINATES_FILE.read_text())
        peaks = {}
        for pid, info in doc["peaks"].items():
            peaks[pid] = {
                "name": info["gaz_name"],
                "gaz_id": info["gaz_id"],
                "lat": info["lat"],
                "lon": info["lon"],
            }
        if len(peaks) != 8:
            raise RuntimeError(f"coordinates.json has {len(peaks)} peaks, expected 8")
        return peaks
    print("WARNING: coordinate snapshot missing; using hardcoded fallback", file=sys.stderr)
    return dict(PEAKS_FALLBACK)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def epqs_elevation(lat: float, lon: float, retries: int = 3) -> dict:
    """Fetch point elevation + metadata from USGS EPQS."""
    url = "https://epqs.nationalmap.gov/v1/json?" + urllib.parse.urlencode({
        "x": lon, "y": lat, "units": "Meters", "wkid": "4326", "includeDate": "true",
    })
    for attempt in range(retries):
        try:
            d = json.loads(http_get(url))
            val = d.get("value")
            if val in (None, "null", ""):
                raise RuntimeError(f"EPQS no value at {lon},{lat}: {d}")
            return {
                "value_m": float(val),
                "raster_id": d.get("rasterId"),
                "resolution": d.get("resolution"),
                "acquisition_date": d.get("attributes", {}).get("AcquisitionDate"),
            }
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


# ---------------------------------------------------------------------------
# 3DEP tile math
# ---------------------------------------------------------------------------

def _tile_index(lat: float, lon: float):
    """Return (row, col) of the 0.5-degree 3DEP tile containing (lat, lon)."""
    col = int((lon + 180.0) / 0.5)
    row = int((90.0 - lat) / 0.5)
    return row, col


def _tile_bbox(row: int, col: int) -> dict:
    return {
        "top":    90.0 - row * 0.5,
        "left":   -180.0 + col * 0.5,
        "bottom": 90.0 - (row + 1) * 0.5,
        "right":  -180.0 + (col + 1) * 0.5,
    }


def _intersecting_tiles(bbox: dict) -> list:
    tiles = set()
    for lat in (bbox["top"], bbox["bottom"]):
        for lon in (bbox["left"], bbox["right"]):
            tiles.add(_tile_index(lat, lon))
    return sorted(tiles)


def _fetch_bbox_tiff(bbox: dict, size_px: int = 2048, retries: int = 3) -> bytes:
    """Fetch a WGS84 bbox as a float32 GeoTIFF from the 3DEP ImageServer.

    Returns raw TIFF bytes. 3DEP pixels are elevation in metres; no-data
    pixels are encoded as float32 -32767.0 (the server fills out-of-coverage
    areas, e.g. open ocean, with that sentinel).
    """
    # Align to tile grid (0.5° tiles) to satisfy the server's whole-cell requirement
    tiles = _intersecting_tiles(bbox)
    if len(tiles) == 1:
        row, col = tiles[0]
        tbox = _tile_bbox(row, col)
    else:
        rmin = min(t[0] for t in tiles)
        rmax = max(t[0] for t in tiles)
        cmin = min(t[1] for t in tiles)
        cmax = max(t[1] for t in tiles)
        tbox = {
            "top":    90.0 - rmin * 0.5,
            "left":   -180.0 + cmin * 0.5,
            "bottom": 90.0 - (rmax + 1) * 0.5,
            "right":  -180.0 + (cmax + 1) * 0.5,
        }
    bbox_str = f"{tbox['left']},{tbox['bottom']},{tbox['right']},{tbox['top']}"
    url = (f"{SERVICE}/exportImage?" + urllib.parse.urlencode({
        "bbox": bbox_str, "bboxSR": "4326",
        "imageFormat": "TIFF", "pixelType": "F32",
        "format": "tiff", "f": "image",
        "size": f"{size_px},{size_px}",
        "interpolation": "nearest",
    }))
    for attempt in range(retries):
        try:
            data = http_get(url)
            if data[:1] == b"{":
                raise RuntimeError(f"3DEP JSON error: {data[:300]!r}")
            if data[:2] not in (b"II", b"MM"):
                raise RuntimeError(f"3DEP returned non-TIFF data: {data[:8]!r}")
            return data
        except Exception as e:
            if attempt == retries - 1:
                raise RuntimeError(f"3DEP fetch failed after {retries} attempts: {e}")
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"3DEP fetch failed after {retries} attempts: unhandled")


# ---------------------------------------------------------------------------
# GeoTIFF → float32 elevation grid
# ---------------------------------------------------------------------------

TIF_NODATA = -32767.0


def decode_elevation_tiff(tiff_bytes: bytes) -> np.ndarray:
    """Decode a 3DEP float32 GeoTIFF into a 2D float32 array (metres).

    No-data cells (float32 -32767) are mapped to NaN. Row 0 is the northern
    edge of the requested bbox.
    """
    arr = tifffile.imread(BytesIO(tiff_bytes)).astype(np.float32)
    arr[arr == TIF_NODATA] = np.nan
    return arr


def extract_crop(elev_grid: np.ndarray, lat: float, lon: float,
                 grid_bbox: dict, crop_cells: int = CROP_CELLS) -> np.ndarray:
    """Extract a fixed crop window centred on (lat, lon).

    grid_bbox: {"top": lat, "left": lon, "bottom": lat, "right": lon}
    covering the full fetched image. Row 0 = north (top of image).
    """
    h, w = elev_grid.shape
    lat_span = grid_bbox["top"] - grid_bbox["bottom"]
    lon_span = grid_bbox["right"] - grid_bbox["left"]

    # Fractional row/col of the centre point
    row_frac = (grid_bbox["top"] - lat) / lat_span * h
    col_frac = (lon - grid_bbox["left"]) / lon_span * w

    # Centre the crop
    r0 = max(0, min(int(round(row_frac)) - HALF, h - crop_cells))
    c0 = max(0, min(int(round(col_frac)) - HALF, w - crop_cells))
    crop = elev_grid[r0:r0 + crop_cells, c0:c0 + crop_cells]

    # Pad if the crop fell off the edge
    if crop.shape != (crop_cells, crop_cells):
        pad = np.full((crop_cells, crop_cells), np.nan, dtype=np.float32)
        ph = min(crop_cells, crop.shape[0])
        pw = min(crop_cells, crop.shape[1])
        pad[:ph, :pw] = crop[:ph, :pw]
        crop = pad
    return crop


def fetch_peak_grid(peak_id: str, lat: float, lon: float):
    """Fetch 3DEP elevation data for a peak and return (crop, grid_bbox, raw_png_sha)."""
    bbox = {
        "top":    lat + HALF_DEG,
        "left":   lon - HALF_DEG,
        "bottom": lat - HALF_DEG,
        "right":  lon + HALF_DEG,
    }
    # Expand to tile grid for server request
    tiles = _intersecting_tiles(bbox)
    if len(tiles) == 1:
        row, col = tiles[0]
        grid_bbox = _tile_bbox(row, col)
    else:
        rmin = min(t[0] for t in tiles)
        rmax = max(t[0] for t in tiles)
        cmin = min(t[1] for t in tiles)
        cmax = max(t[1] for t in tiles)
        grid_bbox = {
            "top":    90.0 - rmin * 0.5,
            "left":   -180.0 + cmin * 0.5,
            "bottom": 90.0 - (rmax + 1) * 0.5,
            "right":  -180.0 + (cmax + 1) * 0.5,
        }

    print(f"    Fetching 3DEP tile bbox: {grid_bbox}")
    png_bytes = _fetch_bbox_tiff(grid_bbox, size_px=1024)
    raw_sha = sha256(png_bytes).hexdigest()

    # Cache raw tile (git-ignored)
    TERRAIN_DIR.mkdir(parents=True, exist_ok=True)
    cache_key = sha256(json.dumps(grid_bbox, sort_keys=True).encode()).hexdigest()[:16]
    cache_path = TERRAIN_DIR / f"3dep-{cache_key}.tiff"
    cache_path.write_bytes(png_bytes)

    elev = decode_elevation_tiff(png_bytes)
    print(f"    Grid: {elev.shape}, raw sha256={raw_sha[:16]}…")
    return elev, grid_bbox, raw_sha, cache_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Allow fetching a single peak if an id is given
    peaks = load_peaks()
    ids = sys.argv[1:] if len(sys.argv) > 1 else list(peaks.keys())
    for pid in ids:
        if pid not in peaks:
            print(f"ERROR: {pid} not in coordinate snapshot. Available: {list(peaks.keys())}", file=sys.stderr)
            sys.exit(1)
        info = peaks[pid]
        lat, lon = info["lat"], info["lon"]
        print(f"\n[{pid}] {info['name']}  (gaz_id={info['gaz_id']}, {lat:.6f},{lon:.6f})", flush=True)

        # 1. EPQS point provenance
        try:
            epqs = epqs_elevation(lat, lon)
            print(f"    EPQS: {epqs['value_m']} m  rasterId={epqs['raster_id']}  "
                  f"acq={epqs['acquisition_date']}")
        except Exception as e:
            print(f"    EPQS failed: {e} — continuing without point provenance", file=sys.stderr)
            epqs = {"value_m": None, "raster_id": None, "resolution": None, "acquisition_date": None}

        # 2. Fetch 3DEP grid
        elev, grid_bbox, raw_sha, cache_path = fetch_peak_grid(pid, lat, lon)

        # 3. Extract crop
        crop = extract_crop(elev, lat, lon, grid_bbox)
        # Replace NaN with -9999 (nodata sentinel used by the silhouette engine)
        crop = np.where(np.isfinite(crop), crop, -9999.0).astype(np.float32)

        # 4. Validate
        finite = crop[crop != -9999.0]
        if finite.size == 0:
            raise RuntimeError(f"{pid}: crop has no finite elevation values")
        min_m = float(finite.min())
        max_m = float(finite.max())
        nodata_count = int((crop == -9999.0).sum())
        if min_m < ELEV_MIN_M or max_m > ELEV_MAX_M:
            print(f"    WARNING: elevation range {min_m:.1f}–{max_m:.1f} m "
                  f"outside Sierra plausibility band [{ELEV_MIN_M}, {ELEV_MAX_M}]", file=sys.stderr)
        print(f"    Crop: min={min_m:.1f} m  max={max_m:.1f} m  "
              f"nodata_cells={nodata_count}/{crop.size}")

        # 5. Write outputs
        out_dir = DATA_DIR / pid
        out_dir.mkdir(parents=True, exist_ok=True)
        bin_path = out_dir / f"{pid}.bin"
        bin_bytes = crop.tobytes()
        bin_path.write_bytes(bin_bytes)
        bin_sha = sha256(bin_bytes).hexdigest()

        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        meta = {
            "peak_id": pid,
            "gaz_id": info["gaz_id"],
            "gaz_name": info["name"],
            "width": CROP_CELLS,
            "height": CROP_CELLS,
            "nodata": -9999.0,
            "sample_sha256": bin_sha,
            "source": "USGS 3DEP 1/3 arc-second (official ImageServer, F32)",
            "source_product": {
                "service": SERVICE,
                "raster_id": epqs.get("raster_id"),
                "resolution_arcsec": epqs.get("resolution"),
                "acquisition_date": epqs.get("acquisition_date"),
            },
            "source_sha256": raw_sha,
            "source_path": str(cache_path.relative_to(ROOT)),
            "crs": "EPSG:4326 (WGS84)",
            "bounds_wgs84": grid_bbox,
            "cell_size_arcsec": RES_ARCSEC,
            "observer_lat": lat,
            "observer_lon": lon,
            "epqs_elevation_m": epqs.get("value_m"),
            "crop_min_m": min_m,
            "crop_max_m": max_m,
            "crop_nodata_count": nodata_count,
            "retrieved_at": now,
            "retrieval_method": "USGS 3DEP ImageServer exportImage (PNG32, F32, WGS84)",
            "coordinate_source": f"USGS National Map Gazetteer gaz_id={info['gaz_id']}",
            "license": "USGS 3DEP (public domain)",
        }
        (out_dir / f"{pid}.json").write_text(json.dumps(meta, indent=2) + "\n")
        print(f"    Wrote {bin_path.relative_to(ROOT)}  sha256={bin_sha[:16]}…")
        print(f"    Wrote {out_dir.name}/{pid}.json")

    print("\nDone.")


if __name__ == "__main__":
    main()
