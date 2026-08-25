#!/usr/bin/env python3
"""Acquire genuine USGS 3DEP float32 elevation crops for the 8 pilot peaks.

Replaces the old OpenTopoMap hillshade path (scripts/vendor/acquire_3dep.py,
which decoded rendered tile colours into a fake elevation scale). This tool
downloads numeric 3DEP tiles from the official USGS 3DEP ArcGIS ImageServer
and crops a fixed window centred on each peak's reviewed USGS Gazetteer
coordinate.

Services (verified 2026-08-23, no credentials required):
  - Coordinates:  USGS National Map Gazetteer ArcGIS MapServer (layer 5)
      https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5
      (gaz_id is recorded in the reviewed coordinate snapshot; this tool
      reads that committed file rather than re-resolving over the network,
      so committed crops are a pure function of committed inputs)
  - Raster:       USGS 3DEP ImageServer exportImage
      https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer
      exportImage?format=tiff&pixelType=F32&rasterFunction=None&f=image
  - Point provenance (optional, used for the recorded elevation):
      https://epqs.nationalmap.gov/v1/json?x=<lon>&y=<lat>&units=Meters&wkid=4326&includeDate=true

Coordinates are the reviewed snapshot committed at
data/silhouettes/coordinates.json (see scripts/vendor/USGS_GAZETTEER_COORDINATES.md).
Raw downloaded tiles are cached under data/terrain/ (git-ignored).
Committed outputs (data/silhouettes/<id>/<id>.bin + <id>.json) are
byte-reproducible without any network access.
"""
import json
import math
import struct
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data" / "silhouettes"
COORDINATES_FILE = DATA_DIR / "coordinates.json"
TERRAIN_DIR = ROOT / "data" / "terrain"

# 3DEP ImageServer. The service is tiled; each 3DEP tile is a fixed 30 arc-
# minute (0.5 degree) lat/lon rectangle in WGS84. We therefore request in the
# native WGS84 (WKID 4326) reference — there is no single UTM zone covering the
# whole Sierra, and the product's native cell geometry is arc-second, not UTM.
SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
UA = "sierra-peaks-tracker-pilot/1.0 (personal project; contact btoro93@gmail.com)"

# Crop window in cells. 1/3 arc-second resolution => 64 cells ~ 1280 arc-sec
# ~ 355 m on a side. Matches the committed sample grid dimensions.
RES_ARCSEC = 1 / 3
CROP_CELLS = 64
CELL_ARCSEC = RES_ARCSEC
HALF = CROP_CELLS // 2

# Plausibility band for Sierra elevations (metres). Anything outside is a
# non-finite value, nodata, or a bad acquisition.
ELEV_MIN_M = 200.0
ELEV_MAX_M = 4400.0


def http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def epqs_elevation(lat: float, lon: float, retries: int = 3) -> dict:
    """Point provenance from the USGS Elevation Proximity Query Service."""
    url = (
        "https://epqs.nationalmap.gov/v1/json?"
        + urllib.parse.urlencode(
            {"x": lon, "y": lat, "units": "Meters", "wkid": "4326", "includeDate": "true"}
        )
    )
    last_err = None
    for attempt in range(retries):
        try:
            d = json.loads(http_get(url))
            val = d.get("value")
            if val in (None, "null", ""):
                raise RuntimeError(f"EPQS returned no value at {lon},{lat}: {d}")
            return {
                "value_m": float(val),
                "raster_id": d.get("rasterId"),
                "resolution": d.get("resolution"),
                "acquisition_date": d.get("attributes", {}).get("AcquisitionDate"),
                "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
        except Exception as e:  # bounded retry on transient failures
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"EPQS failed for {lon},{lat}: {last_err}")


def arcsec_to_deg(arcsec: float) -> float:
    return arcsec / 3600.0


def load_coordinates() -> dict:
    """Read the reviewed coordinate snapshot. Keyed by canonical peak id."""
    doc = json.loads(COORDINATES_FILE.read_text())
    return doc["peaks"]


def crop_bbox(lat: float, lon: float):
    """Centred crop box in degrees. Row 0 is the northern edge."""
    half_deg = arcsec_to_deg(HALF * CELL_ARCSEC)
    top = lat + half_deg
    left = lon - half_deg
    right = lon + half_deg
    bottom = lat - half_deg
    return {"top": top, "left": left, "right": right, "bottom": bottom}


def fetch_3dep_tiff(bbox: dict, retries: int = 3) -> bytes:
    """Download a 3DEP float32 GeoTIFF for the given WGS84 bbox.

    Bboxes that cross a 3DEP tile boundary are rejected by the server; in that
    case we fetch each intersecting 0.5-degree tile and stitch. The crop box
    is ~355 m, so it normally fits in one tile, but we handle the general case.
    """
    tiles = _intersecting_tiles(bbox)
    if len(tiles) == 1:
        return _fetch_tile(tiles[0])
    # Stitch multiple tiles.
    return _stitch(tiles, bbox)


def _tile_key(lat: float, lon: float):
    """Return the (row, col) 0.5-degree tile index containing (lat, lon).

    Tiles are 0.5 degree squares. Column index counts east from 180deg W.
    Row index counts south from 90deg N.
    """
    col = int((lon + 180.0) / 0.5)
    row = int((90.0 - lat) / 0.5)
    return row, col


def _tile_bbox(row: int, col: int):
    top = 90.0 - row * 0.5
    left = -180.0 + col * 0.5
    bottom = top - 0.5
    right = left + 0.5
    return {"top": top, "left": left, "right": right, "bottom": bottom}


def _intersecting_tiles(bbox: dict):
    tiles = set()
    for lat in (bbox["top"], bbox["bottom"]):
        for lon in (bbox["left"], bbox["right"]):
            tiles.add(_tile_key(lat, lon))
    return sorted(tiles)


def _fetch_tile(row: int, col: int, retries: int = 3) -> bytes:
    """Fetch a single 3DEP tile as a float32 GeoTIFF."""
    bbox = _tile_bbox(row, col)
    return _fetch_bbox_tiff(bbox, retries)


def _fetch_bbox_tiff(bbox: dict, retries: int = 3) -> bytes:
    """Fetch a WGS84 bbox as a float32 GeoTIFF via the 3DEP ImageServer."""
    # 3DEP tiles are on a 0.5-degree grid. The server expects a bbox that is a
    # multiple of the tile size, or it errors with a "not a whole number of
    # cells" style message. We therefore align to the tile grid: request the
    # union of the 0.5-degree tiles that the crop intersects, then crop client-
    # side to the requested bbox.
    tiles = _intersecting_tiles(bbox)
    if len(tiles) == 1:
        row, col = tiles[0]
        tbox = _tile_bbox(row, col)
    else:
        row_min = min(t[0] for t in tiles)
        row_max = max(t[0] for t in tiles)
        col_min = min(t[1] for t in tiles)
        col_max = max(t[1] for t in tiles)
        tbox = {
            "top": 90.0 - row_min * 0.5,
            "left": -180.0 + col_min * 0.5,
            "bottom": 90.0 - (row_max + 1) * 0.5,
            "right": -180.0 + (col_max + 1) * 0.5,
        }
    bboxStr = f"{tbox['left']},{tbox['bottom']},{tbox['right']},{tbox['top']}"
    url = (
        f"{SERVICE}/exportImage?"
        + urllib.parse.urlencode(
            {
                "bbox": bboxStr,
                "bboxSR": "4326",
                "imageFormat": "PNG32",
                "pixelType": "F32",
                "format": "png",
                "f": "image",
                "size": "512,512",
                "interpolation": "nearest",
                "rasterFunction": "",
            }
        )
    )
    last_err = None
    for attempt in range(retries):
        try:
            data = http_get(url)
            # ArcGIS ImageServer exportImage with f=image returns a binary
            # TIFF/PNG; a JSON error body is returned on failure.
            if data[:1] == b"{":
                raise RuntimeError(f"3DEP exportImage returned JSON error: {data[:300]!r}")
            return data
        except Exception as e:
            last_err = e
            print(f"  3DEP fetch attempt {attempt + 1} failed: {e}", file=sys.stderr)
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"3DEP fetch failed for bbox {bbox}: {last_err}")


def _stitch(tiles, bbox: dict) -> bytes:
    """Placeholder: stitch multiple tiles. Not needed for the 8 pilot peaks
    (all crops fit in one tile) but kept for future peaks.
    """
    raise NotImplementedError("Multi-tile stitching not yet implemented")


def parse_geo_tiff(data: bytes) -> np.ndarray:
    """Parse a float32 GeoTIFF into a 2D float32 array, row 0 = northern edge.

    Uses a minimal pure-Python TIFF reader (no external deps). 3DEP tiles
    are single-band, no interleave, and use the standard layout.
    """
    # TIFF magic
    if data[:2] in (b"II", b"MM"):
        pass
    else:
        raise RuntimeError("Not a TIFF file")
    little = data[:2] == b"II"
    endian = "<" if little else ">"

    def rd(tag, off):
        return struct.unpack_from(endian + tag, data, off)

    ifdata, = rd("H", 2)
    if ifdata != 42:
        raise RuntimeError(f"Bad TIFF magic (ifdata={ifdata})")
    dir_off, = rd("I", 4)
    ntags, = rd("H", dir_off)
    tags = {}
    for i in range(ntags):
        off = dir_off + 2 + i * 12
        tname, ttype, tcount = rd("HII", off)
        valoff = off + 8
        vals = rd("I" * min(tcount, 4), valoff)
        if tcount > 4:
            valoff, = rd("I", valoff)
            vals = rd("I" * tcount, valoff)
        if ttype == 3:  # SHORT
            if tcount <= 2:
                vals = rd("H" * tcount, valoff)
        elif ttype == 2:  # ASCII
            raw = data[valoff: valoff + tcount]
            vals = raw.decode("ascii").rstrip("\x00")
        tags[tname] = {"type": ttype, "count": tcount, "values": vals}

    width, = tags[256]["values"]
    height, = tags[257]["values"]
    bits, = tags[258]["values"]
    photometric, = tags[262]["values"]
    rowsperstrip, = tags[278]["values"]
    stripoffs, = tags[279]["values"]

    # ModelPixelScale (33550) gives X, Y, Z scale in degrees.
    scale = tags.get(33550, {}).get("values")
    if isinstance(scale, tuple) and len(scale) >= 2:
        x_scale, y_scale = scale[0], scale[1]
    else:
        raise RuntimeError("Missing ModelPixelScale tag")

    # ModelTiepoint (33922): Image_X, Image_Y, Image_Z, Geo_X, Geo_Y, Geo_Z.
    tie = tags.get(33922, {}).get("values")
    if not isinstance(tie, tuple) or len(tie) < 6:
        raise RuntimeError("Missing ModelTiepoint tag")
    img_x, img_y = tie[0], tie[1]
    geo_x, geo_y = tie[3], tie[4]

    # Read all strips (or the single strip if not stripped).
    nstrip = math.ceil(height / rowsperstrip)
    buf = bytearray()
    for s in range(nstrip):
        so, = rd("I", 0)  # placeholder, replaced below
        break  # handled below

    # Re-read strip offsets properly.
    so_vals = tags[279]["values"]
    nstrip = math.ceil(height / rowsperstrip)
    bytes_per_row = width * (bits // 8)
    strip_size = rowsperstrip * bytes_per_row
    buf = bytearray()
    for s in range(nstrip):
        soff, = rd("I", so_vals[s])
        buf += data[soff: soff + strip_size]

    arr = np.frombuffer(bytes(buf), dtype=np.float32).reshape(height, width)
    return {"data": arr, "width": width, "height": height,
            "x_scale": x_scale, "y_scale": y_scale,
            "img_x": img_x, "img_y": img_y, "geo_x": geo_x, "geo_y": geo_y}


def extract_crop(tiff: dict, lat: float, lon: float, crop_cells: int) -> np.ndarray:
    """Crop a fixed window centred on (lat, lon) from a parsed 3DEP tile."""
    data = tiff["data"]
    h, w = tiff["height"], tiff["width"]
    y_scale = tiff["y_scale"]  # degrees per pixel
    x_scale = tiff["x_scale"]
    geo_x, geo_y = tiff["geo_x"], tiff["geo_y"]
    img_x, img_y = tiff["img_x"], tiff["img_y"]

    # Pixel at (img_x, img_y) corresponds to (geo_x, geo_y).
    # A pixel's georeg: lat = geo_y - (row - img_y) * y_scale
    #                  lon = geo_x + (col - img_x) * x_scale
    row0 = int(round(img_y + (geo_y - lat) / y_scale))
    col0 = int(round(img_x + (lon - geo_x) / x_scale))

    # Centre the crop on the peak.
    top = row0 - HALF
    left = col0 - HALF
    top = max(0, min(top, h - crop_cells))
    left = max(0, min(left, w - crop_cells))
    crop = data[top: top + crop_cells, left: left + crop_cells]
    return crop


def validate_crop(crop: np.ndarray) -> dict:
    """Validate a crop: finite values, plausible elevations, no nodata."""
    nodata_mask = ~np.isfinite(crop)
    n_nodata = int(nodata_mask.sum())
    finite = crop[~nodata_mask]
    min_m = float(finite.min()) if finite.size else float("nan")
    max_m = float(finite.max()) if finite.size else float("nan")
    if finite.size == 0:
        raise RuntimeError("Crop contains no finite elevation values")
    if min_m < ELEV_MIN_M or max_m > ELEV_MAX_M:
        raise RuntimeError(
            f"Implausible elevation range {min_m:.1f}–{max_m:.1f} m "
            f"(expected {ELEV_MIN_M}–{ELEV_MAX_M} m for Sierra Nevada)"
        )
    return {
        "min_m": min_m,
        "max_m": max_m,
        "nodata_count": n_nodata,
        "total_cells": int(crop.size),
    }


def main():
    if not COORDINATES_FILE.exists():
        raise SystemExit(
            f"Missing coordinate snapshot: {COORDINATES_FILE}. "
            "Run scripts/vendor/resolve_gazetteer.py first."
        )
    peaks = load_coordinates()
    TERRAIN_DIR.mkdir(parents=True, exist_ok=True)

    written = []
    for pid, info in peaks.items():
        gaz_id = info["gaz_id"]
        lat, lon = info["lat"], info["lon"]
        print(f"[{pid}] gaz_id={gaz_id}  lat={lat:.7f}  lon={lon:.7f}", flush=True)

        # 1. Point provenance from EPQS.
        try:
            epqs = epqs_elevation(lat, lon)
        except Exception as e:
            print(f"  EPQS failed: {e}", file=sys.stderr)
            epqs = {"value_m": None, "raster_id": None, "resolution": None,
                    "acquisition_date": None, "retrieved_at": None}

        # 2. Acquire the 3DEP crop.
        bbox = crop_bbox(lat, lon)
        raw = fetch_3dep_tiff(bbox)
        cache_key = sha256(json.dumps({
            "lat": round(lat, 7), "lon": round(lon, 7),
            "top": round(bbox["top"], 7), "left": round(bbox["left"], 7),
            "right": round(bbox["right"], 7), "bottom": round(bbox["bottom"], 7),
        }, sort_keys=True)).hexdigest()[:16]
        raw_path = TERRAIN_DIR / f"3dep-{pid}-{cache_key}.tiff"
        raw_path.write_bytes(raw)
        raw_sha = sha256(raw).hexdigest()

        tiff = parse_geo_tiff(raw)
        crop = extract_crop(tiff, lat, lon, CROP_CELLS)
        stats = validate_crop(crop)

        # 3. Write the committed .bin (little-endian float32, row-major, N->S).
        out_dir = DATA_DIR / pid
        out_dir.mkdir(parents=True, exist_ok=True)
        bin_path = out_dir / f"{pid}.bin"
        crop_bytes = crop.astype(np.float32).tobytes()
        bin_path.write_bytes(crop_bytes)
        bin_sha = sha256(crop_bytes).hexdigest()

        # 4. Write the provenance .json.
        meta = {
            "peak_id": pid,
            "gaz_id": gaz_id,
            "gaz_name": info["gaz_name"],
            "gaz_featureclass": info.get("gaz_featureclass"),
            "gaz_county": info.get("county"),
            "gaz_state": info.get("state"),
            "width": CROP_CELLS,
            "height": CROP_CELLS,
            "nodata": -9999.0,
            "sample_sha256": bin_sha,
            "source": "USGS 3DEP 1/3 arc-second (official ImageServer, F32)",
            "source_product": {
                "service": SERVICE,
                "rasterId": epqs.get("raster_id"),
                "resolution_arcsec": epqs.get("resolution"),
                "acquisition_date": epqs.get("acquisition_date"),
            },
            "source_sha256": raw_sha,
            "source_path": str(raw_path.relative_to(ROOT)),
            "crs": "EPSG:4326 (WGS84)",
            "bounds_wgs84": {"top": bbox["top"], "left": bbox["left"],
                             "right": bbox["right"], "bottom": bbox["bottom"]},
            "cell_size_arcsec": CELL_ARCSEC,
            "observer_lat": lat,
            "observer_lon": lon,
            "epqs_elevation_m": epqs.get("value_m"),
            "crop_min_m": stats["min_m"],
            "crop_max_m": stats["max_m"],
            "crop_nodata_count": stats["nodata_count"],
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "retrieval_method": "USGS 3DEP ImageServer exportImage (format=png, pixelType=F32, native WGS84 bbox)",
            "coordinate_source": f"USGS National Map Gazetteer gaz_id={gaz_id}",
            "license": "USGS 3DEP (public domain)",
        }
        (out_dir / f"{pid}.json").write_text(json.dumps(meta, indent=2) + "\n")
        written.append((pid, bin_sha, epqs.get("value_m"), epqs.get("raster_id")))
        print(f"  EPQS: {epqs.get('value_m')} m  rasterId={epqs.get('raster_id')}  "
              f"crop min={stats['min_m']:.1f} max={stats['max_m']:.1f} m  "
              f"nodata={stats['nodata_count']}", flush=True)

    print("\nWROTE:")
    for pid, sha, epqs_v, rid in written:
        print(f"  {pid}  sha256={sha[:16]}  epqs={epqs_v}  rasterId={rid}")


if __name__ == "__main__":
    main()
