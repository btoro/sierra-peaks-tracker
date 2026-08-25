#!/usr/bin/env python3
"""Try different where-clause syntaxes against the USGS Gazetteer MapServer."""
import json
import math
import urllib.parse
import urllib.request

BASE = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5/query"
UA = "sierra-peaks-tracker-pilot/1.0 (personal project; contact btoro93@gmail.com)"

def merc(lon_deg, lat_deg):
    a = 20037508.34
    x = a * lon_deg / 180.0
    y = a * math.log(math.tan(math.radians(90 + lat_deg) / 2)) / math.pi
    return x, y

# Mount Whitney lat/lon
lat, lon = 36.5785905, -118.2921377
x, y = merc(lon, lat)
print(f"Mercator coords: x={x:.4f} y={y:.4f}")

attempts = [
    ("within_distance on shape", f"within_distance(shape, point({x:.4f} {y:.4f}), 35000)"),
    ("SPATIAL_REL within_distance", f"SPATIAL_REL = 'within_distance' AND within_distance(shape, point({x:.4f} {y:.4f}), 35000)"),
    ("SPATIAL_PREDICATE", f"SPATIAL_PREDICATE = 'esriSpatialRelIntersects'"),
    ("geometry query via geometry param", None),  # handled separately
    ("where 1=1 + geometry param", "1=1"),
    ("where gaz_name = 'Mount Whitney'", "gaz_name = 'Mount Whitney'"),
    ("where NAME like", "NAME LIKE '%Whitney%'"),
    ("where gaz_name LIKE", "gaz_name LIKE '%Whitney%'"),
    ("where gaz_name LIKE case-insens", "UCASE(gaz_name) LIKE '%WHITNEY%'"),
]

for label, where in attempts:
    print(f"\n=== {label} ===")
    if where is None:
        # use geometry param instead of where
        geo_json = json.dumps({"geometryType": "esriGeometryPoint", "geometry": {"x": x, "y": y, "spatialReference": {"wkid": 102100}}})
        url = BASE + "?" + urllib.parse.urlencode({
            "geometry": geo_json,
            "inSR": "102100",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "gaz_id,gaz_name,gaz_featureclass,state_alpha,county_name,isunknowncoords",
            "f": "json",
            "outSR": "4326",
            "resultRecordCount": "20",
        })
    else:
        url = BASE + "?" + urllib.parse.urlencode({
            "where": where,
            "outFields": "gaz_id,gaz_name,gaz_featureclass,state_alpha,county_name,isunknowncoords",
            "f": "json",
            "outSR": "4326",
            "resultRecordCount": "20",
        })
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        if "error" in d:
            print("  ERROR:", json.dumps(d["error"])[:200])
        else:
            feats = d.get("features", [])
            print(f"  {len(feats)} features")
            for f in feats[:10]:
                a = f.get("attributes", {})
                g = f.get("geometry")
                print(f"    {a.get('gaz_id')} {a.get('gaz_name')!r} {a.get('state_alpha')} {a.get('county_name')} isunk={a.get('isunknowncoords')} geo={json.dumps(g) if g else None}")
    except Exception as e:
        print(f"  EXCEPTION: {e}")
