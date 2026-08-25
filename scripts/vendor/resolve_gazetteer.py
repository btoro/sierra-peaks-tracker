#!/usr/bin/env python3
"""Resolve the 8 pilot peaks against the USGS National Map Gazetteer
(MapServer layer 5 = Landforms) by exact gaz_name match.

Authoritative source (verified 2026-08-23):
  https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5/query

Duplicate names across the gazetteer are resolved by county / state bounds
matching the peak's known location (Sierra Nevada, California). All
candidates are printed so a human can review the selection; the selected
gaz_id + coordinate per peak is then committed as a reviewed coordinate
snapshot (see scripts/vendor/USGS_GAZETTEER_COORDINATES.md).
"""
import json
import math
import urllib.parse
import urllib.request

BASE = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5/query"
UA = "sierra-peaks-tracker-pilot/1.0 (personal project; contact btoro93@gmail.com)"

# Peak identity dedup: gaz_id + county/state + featureclass + coordinate
# bounds. The coordinate bounds are a ~0.4° box around the SPS-derived prior
# location — any gazetteer entry outside these bounds is a different feature
# with the same name, not a duplicate of the target peak.
PEAKS = [
    # peak_id,   gaz_name (exact), expected county hints, expected lat/lon (SPS-derived prior)
    ("spk-4.7",  "Mount Whitney",    ["Tulare", "Inyo"],      36.5785905, -118.2921377),
    ("spk-5.9",  "Mount Williamson", ["Tulare", "Inyo"],      36.6560456, -118.3112040),
    ("spk-6.8",  "Mount Kaweah",     ["Tulare"],             36.5261080, -118.4785160),
    ("spk-18.6", "Mount Morgan",     ["Mono"],               37.5113223, -118.7798480),
    ("spk-21.1", "Cathedral Peak",   ["Mariposa", "Tuolumne"], 37.8478275, -119.4055286),
    ("spk-23.9", "Pyramid Peak",     ["Alpine", "El Dorado"], 38.8450090, -120.1578443),
    ("spk-2.1",  "Kern Peak",        ["Tulare", "Kern"],     36.3084512, -118.2877790),
    ("spk-1.8",  "Sirretta Peak",    ["Kern"],               35.9242992, -118.3331993),
]
BOUNDS_DEG = 0.4


def http_get_json(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def haversine_km(lat1, lon1, lat2, lon2):
    """Approximate great-circle distance in km."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(a))


def main():
    out = []
    for pid, name, counties, lat, lon in PEAKS:
        url = BASE + "?" + urllib.parse.urlencode(
            {
                "where": f"gaz_name = '{name}'",
                "outFields": "gaz_id,gaz_name,gaz_featureclass,state_alpha,county_name,isunknowncoords",
                "f": "json",
                "outSR": "4326",
                "resultRecordCount": "100",
            }
        )
        d = http_get_json(url)
        feats = d.get("features", [])
        cands = []
        for f in feats:
            a = f.get("attributes", {})
            pts = (f.get("geometry") or {}).get("points") or []
            cands.append(
                {
                    "gaz_id": a.get("gaz_id"),
                    "gaz_name": a.get("gaz_name"),
                    "gaz_featureclass": a.get("gaz_featureclass"),
                    "state_alpha": a.get("state_alpha"),
                    "county_name": a.get("county_name"),
                    "isunknowncoords": a.get("isunknowncoords"),
                    "lon": pts[0][0] if pts else None,
                    "lat": pts[0][1] if pts else None,
                }
            )
        # Dedup: same gaz_id with multiple county rows.
        by_id = {}
        for c in cands:
            e = by_id.setdefault(c["gaz_id"], {"gaz_id": c["gaz_id"], "counties": set()})
            e["counties"].add(c["county_name"])
            e.setdefault("lon", c["lon"])
            e.setdefault("lat", c["lat"])
            e.setdefault("gaz_featureclass", c["gaz_featureclass"])
            e.setdefault("state_alpha", c["state_alpha"])
        entries = []
        for e in by_id.values():
            e["counties"] = sorted(e["counties"])
            # Distance from expected location (SPS prior)
            if e["lat"] is not None and e["lon"] is not None:
                e["distance_km"] = round(haversine_km(lat, lon, e["lat"], e["lon"]), 1)
            else:
                e["distance_km"] = None
            in_county = any(cc in e["counties"] for cc in counties)
            e["matches_expected_county"] = in_county
            entries.append(e)
        # Rank: closest to expected location first, then by gaz_id
        entries.sort(key=lambda e: (e["distance_km"] is not None, e["distance_km"] if e["distance_km"] is not None else float("inf"), str(e["gaz_id"])))
        entry = {
            "peak_id": pid,
            "gaz_name": name,
            "expected_counties": counties,
            "candidates": entries,
            "selected": None,
        }
        # Auto-select the first candidate that is within bounds (50 km) and
        # matches expected county. If only one candidate within bounds, use it.
        in_bounds = [e for e in entries if e["distance_km"] is not None and e["distance_km"] <= 50]
        if len(in_bounds) == 1:
            entry["selected"] = in_bounds[0]
        elif in_bounds:
            # Prefer expected-county match among in-bounds
            county_match = [e for e in in_bounds if e["matches_expected_county"]]
            if len(county_match) == 1:
                entry["selected"] = county_match[0]
        out.append(entry)
        print(f"=== {pid}  {name!r}  ({len(entries)} unique gazetteer entries)")
        for e in entries:
            sel = "SELECTED" if entry["selected"] is e else "        "
            dist = f"{e['distance_km']} km" if e["distance_km"] is not None else "?"
            print(
                f"  [{sel}] gaz_id={e['gaz_id']} county={','.join(e['counties'])} "
                f"state={e['state_alpha']} cls={e['gaz_featureclass']} "
                f"lat={e['lat']} lon={e['lon']} dist={dist}"
            )
        if entry["selected"] is None:
            print(f"  -> MANUAL SELECTION NEEDED ({len(entries)} candidates)")
    with open("coordinate_candidates.json", "w") as f:
        json.dump(out, f, indent=2)
    print("\nWrote coordinate_candidates.json")


if __name__ == "__main__":
    main()
