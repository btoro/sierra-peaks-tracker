#!/usr/bin/env python3
"""One-time vendoring tool: extract the SPS 29th Edition (Jan 2025) list from the
authorized local PDF into a faithful, lossless TSV snapshot.

This is a LOCAL, ONE-TIME tool. It is NOT part of the site build or CI.
CI only re-runs the Node importer over the committed TSV snapshot.

Input : an authorized local copy of the SPS 29th Edition PDF (never fetched
        from the network). The PDF binary is NOT committed; its sha256 is
        recorded in data/manifest.json for provenance.
Output: snapshots/sierraclub/sp-s-29-2025/sps-list-29th-2025.tsv

Faithfulness rules (frozen data contract, docs/data-contract.md §4):
  * Preserve per row, UNCHANGED from source: name (sans the * / ** emblem /
    mountaineer markers, which are stored as their own flags), elevation_raw,
    class_raw (raw climbing-class notation, never normalized), UTM when
    present, principal + auxiliary map references (verbatim, source order).
  * Record the left-margin "SUSPENDED" marker as the `suspended` flag.
  * Record the ** (emblem) and * (mountaineer) markers as flags.
  * Preserve source section (area) + 1-based within-section order.
"""
import hashlib
import re
import sys

import fitz  # PyMuPDF

PDF_PATH = sys.argv[1]
OUT_PATH = sys.argv[2]


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def page_words_lines(doc, pidx):
    """Return [(y, [(x0, word), ...]) sorted top-to-bottom, left-to-right."""
    p = doc[pidx]
    words = p.get_text("words")  # x0,y0,x1,y1,word,block,line,wordno
    groups = {}
    for x0, y0, x1, y1, w, b, l, n in words:
        groups.setdefault(round(y0), []).append((x0, w))
    keys = sorted(groups)
    lines = []
    cur, cur_y = [], None
    for k in keys:
        if cur_y is None or k - cur_y <= 3:
            cur.extend(groups[k])
            if cur_y is None:
                cur_y = k
        else:
            lines.append((cur_y, sorted(cur)))
            cur, cur_y = list(groups[k]), k
    if cur:
        lines.append((cur_y, sorted(cur)))
    return lines


def extract(pdf_path):
    doc = fitz.open(pdf_path)
    areas = {}   # area_no -> name
    area_order = []
    rows = []
    for pidx in range(2, 7):  # physical pages 3..7 hold the list
        for y, ln in page_words_lines(doc, pidx):
            # Detect the suspended left-margin marker BEFORE cleaning.
            suspended = any("SUSPENDED" in w.strip().upper() for _, w in ln)
            text = " ".join(w for _, w in ln)
            text = re.sub(r"\|+", " ", text)             # margin rule artifacts
            text = re.sub(r"_{1,2}SUSPENDED", " ", text)
            text = re.sub(r"\bSUSPENDED\b", " ", text)   # the marker itself
            text = re.sub(r"\s+", " ", text).strip()
            text = re.sub(r"^[^0-9A-Za-z@]*", "", text)  # leftover margin junk
            if not text:
                continue
            if "Changes to the SPS List" in text or "LIST OF MAPS" in text:
                break  # end of the list; ignore the trailing prose/map index
            # Area header: "1.  SOUTHERN SIERRA"  (single number, then NAME)
            am = re.match(r"^(\d+)\.\s+([A-Z][A-Z0-9 .&'’\-]*?)\s*$", text)
            if am:
                a_no, a_name = int(am.group(1)), am.group(2).strip()
                if a_no not in areas:
                    area_order.append(a_no)
                    areas[a_no] = a_name
                continue
            # Peak row: "<a>.<seq> <name> <elev> <class> [utm6] <maps...>"
            rm = re.match(
                r"^(\d+)\.(\d+)\s+(.+?)\s+(\d{4,5}\+?)\s+"
                r"(\d(?:\.\d+)?(?:s\d+)?\+?)\s+(?:(\d{6})\s+)?(.*)$",
                text,
            )
            if rm:
                a, seq, name, elev, cls, utm, maps = rm.groups()
                a, seq = int(a), int(seq)
                nm = name.strip()
                emblem = nm.startswith("**")
                mountaineer = (not emblem) and nm.startswith("*")
                nm = re.sub(r"^\**\s*", "", nm).strip()
                rows.append(
                    {
                        "area": a,
                        "seq": seq,
                        "name": nm,
                        "elevation_raw": elev,
                        "class_raw": cls,
                        "utm": utm or "",
                        "maps_raw": maps.strip(),
                        "emblem": emblem,
                        "mountaineer": mountaineer,
                        "suspended": suspended,
                    }
                )
                continue
            # Anything else (KEY line, column headers, stray margin tokens) is
            # intentionally ignored: only rows that match the strict peak-row
            # shape are accepted. This is what makes malformed rows fail.
    return areas, area_order, rows


def main():
    areas, area_order, rows = extract(PDF_PATH)

    # ---- Sanity checks (fail loudly if the source does not match the contract)
    assert area_order == list(range(1, 25)), f"expected areas 1..24, got {area_order}"
    assert len(rows) == 248, f"expected 248 rows, got {len(rows)}"
    for a in area_order:
        seqs = [r["seq"] for r in rows if r["area"] == a]
        assert seqs == list(range(1, len(seqs) + 1)), f"area {a} seq not contiguous: {seqs}"
    susp = [r for r in rows if r["suspended"]]
    assert len(susp) == 1 and susp[0]["area"] == 1 and susp[0]["seq"] == 1, f"suspended rows: {susp}"
    assert susp[0]["name"] == "Pilot Knob (S)", f"suspended name: {susp[0]['name']}"
    em = [r for r in rows if r["name"] == "Mt Emerson"]
    assert len(em) == 1 and em[0]["area"] == 16 and em[0]["seq"] == 2, f"Emerson: {em}"
    assert em[0]["class_raw"] == "3", f"Emerson class_raw: {em[0]['class_raw']}"
    pk = [r for r in rows if r["name"].startswith("Pilot Knob")]
    assert { (r['area'], r['seq']) for r in pk } == {(1, 1), (16, 7)}, f"Pilot Knob rows: {pk}"

    # ---- Emit the TSV snapshot
    lines = [
        "# sps-list-29th-2025.tsv",
        "# Sierra Club \"Sierra Peaks & Sums\" (SPS), 29th Edition, January 2025.",
        "# Vendored, authorized local extraction. The source PDF binary is NOT",
        "# committed (no redistribution of the copyrighted publication); its",
        "# sha256 + provenance live in data/manifest.json. Extracted by",
        "# scripts/vendor/extract_sps.py (one-time local tool, requires PyMuPDF).",
        "# Format (tab-delimited); lines starting with '#' and blank lines are ignored",
        "# by the importer:",
        "#   @AREA <area_no> <area_name>",
        "#   <area_no>.<seq> <name> <elevation_raw> <class_raw> <utm_or_-> <maps_or_-> <emblem> <mountaineer> <suspended>",
        "#   emblem/mountaineer/suspended are 1 or 0.",
    ]
    last_area = None
    for r in rows:
        if r["area"] != last_area:
            lines.append(f"@AREA\t{r['area']}\t{areas[r['area']]}")
            last_area = r["area"]
        lines.append(
            "\t".join(
                [
                    f"{r['area']}.{r['seq']}",
                    r["name"],
                    r["elevation_raw"],
                    r["class_raw"],
                    r["utm"] or "-",
                    r["maps_raw"] or "-",
                    "1" if r["emblem"] else "0",
                    "1" if r["mountaineer"] else "0",
                    "1" if r["suspended"] else "0",
                ]
            )
        )
    with open(OUT_PATH, "w") as f:
        f.write("\n".join(lines) + "\n")

    pdf_sha = sha256_of(PDF_PATH)
    print(f"areas={len(area_order)} rows={len(rows)}")
    print(f"emblem={sum(1 for r in rows if r['emblem'])} "
          f"mountaineer={sum(1 for r in rows if r['mountaineer'])} "
          f"utm={sum(1 for r in rows if r['utm'])} "
          f"suspended={len(susp)}")
    print(f"pdf_sha256={pdf_sha}")
    print(f"wrote {OUT_PATH} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
