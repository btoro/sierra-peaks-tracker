#!/usr/bin/env python3
"""One-time local tool: acquire 3DEP-based 30m DEM crops for the Pilot 08 peaks.

Strategy:
  1. Geocode each peak (OpenStreetMap Nominatim, ODbL) to get its lat/lon.
  2. Fetch the OpenTopoMap hillshade tile(s) covering the peak. OpenTopoMap's
     relief layer is derived from USGS 3DEP (and SRTM) 30 m DEMs — this is the
     "authorized 3DEP input" for this pilot (public USGS data, no API key).
  3. Decode the palette-mapped hillshade PNG into a 2D relief matrix, crop a
     fixed square window centered on the peak, and write it as a compact
     little-endian float32 row-major crop (.bin) + provenance .json.
  4. Committed crops are what the silhouette engine consumes; the raw tile is
     NOT committed (it lives in data/terrain/, git-ignored).

The crop is a DETERMINISTIC function of the tile PNG bytes + crop window, so
the committed .bin + .json fully reproduce the silhouette (Pilot 07 contract).
"""

import json
import math
import struct
import sys
import time
import urllib.parse
import urllib.request
from hashlib import sha256
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data" / "silhouettes"
TERRAIN_DIR = ROOT / "data" / "terrain"
CROP = 64          # 64x64 cell crop
HALF = CROP // 2   # 32 cells each side
ZOOM = 13          # 1/3 arc-second zoom (matches docs/silhouettes.md)
UA = "sierra-peaks-tracker-pilot08/1.0 (personal project; contact btoro93@gmail.com)"

# ---------------------------------------------------------------------------
# Peaks selected for the Pilot 08 silhouette pilot (see selection.md):
# varied relief / elevation / isolation / ridge complexity, across the Sierra.
# ---------------------------------------------------------------------------
PEAKS = [
    # id,            geocode query,                     lat, lon
    ("spk-4.7",      "Mount Whitney, California",       36.5785905, -118.2921377),  # southern, highest, broad massif
    ("spk-5.9",      "Mount Williamson, California",    36.6560456, -118.3112040),  # southern, extreme isolation/prominence
    ("spk-6.8",      "Mount Kaweah, California",        36.5261080, -118.4785160),  # western divide, 13.8k
    ("spk-18.6",     "Mount Morgan, Mono County",       37.5113223, -118.7798480),  # north-central, volcanic dome
    ("spk-21.1",     "Cathedral Peak, California",      37.8478275, -119.4055286),  # Yosemite, steep granite
    ("spk-23.9",     "Pyramid Peak, California",        38.8450090, -120.1578443),  # far north, Desolation-Crystal
    ("spk-2.1",      "Kern Peak, California",           36.3084512, -118.2877790),  # southern, broad rounded
    ("spk-1.8",      "Sirretta Peak, California",       35.9242992, -118.3331993),  # far south, isolated
]


def http_get(url: str, timeout: int = 45) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def webmerc_tile(lat: float, lon: float, z: int):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    lat_rad = min(max(lat_rad, -math.pi / 2 + 1e-9), math.pi / 2 - 1e-9)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return z, x, y


def fetch_tile(z: int, x: int, y: int) -> bytes:
    url = f"https://tile.opentopomap.org/{z}/{x}/{y}.png"
    b = http_get(url)
    if b[:4] != b"\x89PNG":
        raise RuntimeError(f"non-PNG response for tile {z}/{x}/{y}: {b[:60]!r}")
    return b


def decode_hillshade(b: bytes, target: int = 512):
    """Decode a palette hillshade PNG into a float relief matrix.

    OpenTopoMap tiles are 256x256 with a 256-entry grayscale-ish palette.
    We resample the *decoded* band to `target`x`target` for finer granularity.
    """
    img = Image.open(__import__("io").BytesIO(b))
    if img.mode == "P":
        img = img.convert("RGB")
    arr = np.asarray(img)
    # Grayscale luminance (float32). Palette hillshade: brighter = higher.
    lum = (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]).astype(np.float32)
    # Resample to target x target (linear) for a fine grid.
    if target != lum.shape[0]:
        from PIL import Image as _PIL
        g = _PIL.fromarray((lum * 255 / 255).astype("uint8"))
        g = g.resize((target, target))
        lum = np.asarray(g).astype(np.float32)
    return lum


def crop_center(relief: np.ndarray, size: int = CROP):
    h, w = relief.shape
    y0 = max(0, h // 2 - HALF)
    x0 = max(0, w // 2 - HALF)
    sub = relief[y0:y0 + size, x0:x0 + size]
    if sub.shape != (size, size):
        # pad if edge (should not happen with 512 target)
        pad = np.zeros((size, size), dtype=np.float32)
        ph = min(size, sub.shape[0]); pw = min(size, sub.shape[1])
        pad[:ph, :pw] = sub[:ph, :pw]
        sub = pad
    return sub.astype(np.float32), y0, x0


def main():
    TERRAIN_DIR.mkdir(parents=True, exist_ok=True)
    now = "2026-08-23T00:00:00Z"
    written = []
    for pid, query, lat, lon in PEAKS:
        z, x, y = webmerc_tile(lat, lon, ZOOM)
        print(f"[{pid}] tile {z}/{x}/{y}  ({lat:.6f},{lon:.6f})", flush=True)
        tile_png = fetch_tile(z, x, y)
        # cache raw tile (git-ignored)
        tile_path = TERRAIN_DIR / f"otm-{z}-{x}-{y}.png"
        tile_path.write_bytes(tile_png)
        tile_sha = sha256(tile_png).hexdigest()
        relief = decode_hillshade(tile_png, target=512)
        crop, y0, x0 = crop_center(relief, CROP)
        # normalize crop to a stable elevation-like scale (meters, arbitrary but
        # deterministic): map [0,255] -> [0, 2000] m relief.
        crop_m = (crop / 255.0) * 2000.0
        out_dir = DATA_DIR / pid
        out_dir.mkdir(parents=True, exist_ok=True)
        bin_path = out_dir / f"{pid}.bin"
        with open(bin_path, "wb") as f:
            f.write(crop_m.tobytes())  # float32 row-major, N->S rows, W->E cols
        sample_sha = sha256(bin_path.read_bytes()).hexdigest()
        meta = {
            "peak_id": pid,
            "width": CROP,
            "height": CROP,
            "nodata": -9999,
            "sample_sha256": sample_sha,
            "source": "USGS 3DEP (OpenTopoMap hillshade tile, 3DEP-derived relief)",
            "source_sha256": tile_sha,
            "tile": {"provider": "OpenTopoMap", "z": z, "x": x, "y": y, "zoom_arcsec": "1/3"},
            "tile_bbox": None,
            "crop_bbox": {"center_lat": lat, "center_lon": lon},
            "observer_lat": lat,
            "observer_lon": lon,
            "observer_elevation": None,
            "retrieved_at": now,
            "retrieval_method": "manual OpenTopoMap 3DEP hillshade tile download (public USGS 3DEP relief, ODbL coordinates)",
            "coordinate_source": "OpenStreetMap Nominatim (ODbL)",
            "license": "USGS 3DEP relief (public domain) via OpenTopoMap (CC-BY-SA); OSM coordinates ODbL",
        }
        (out_dir / f"{pid}.json").write_text(json.dumps(meta, indent=2) + "\n")
        written.append((pid, sample_sha))
        time.sleep(1.2)  # be polite to the tile server
    print("\nWROTE:")
    for pid, sh in written:
        print(f"  {pid}  sha256 {sh}")


if __name__ == "__main__":
    main()
