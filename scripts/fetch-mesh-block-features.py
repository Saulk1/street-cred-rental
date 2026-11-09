"""Fetch mesh-block boundaries and non-price attributes for every suburb in the rent history.

    MICROBURBS_API_KEY=... python scripts/fetch-mesh-block-features.py --data <dir>

Writes <dir>/mesh_blocks.json (team-only, never committed): for each mesh block its outline,
median weekly income, modelled crime rate and the seven livability scores. None of these is
derived from rents, so they can be used as fair-rent features without leaking the target.
About four requests per suburb, paced well under the 10 requests/second limit.
The key is read from the environment only. Standard library only.
"""
import argparse
import csv
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api-ht.microburbs.com.au/v1/suburbs/"


def get(suburb, endpoint, key, pause):
    url = BASE + urllib.parse.quote(suburb) + "/" + endpoint
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "User-Agent": "street-cred-rental"})
    for attempt in range(3):
        time.sleep(pause)
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return json.loads(response.read().decode("utf-8")).get("data")
        except urllib.error.HTTPError as error:
            if error.code == 429:
                time.sleep(2.0 * (attempt + 1))
                continue
            if error.code in (404, 422):
                return None
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1.0)
    return None


def rings(geometry):
    """Outer rings only, as [[lng, lat], ...] rounded to about one metre."""
    if not geometry:
        return []
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"] if geometry["type"] == "MultiPolygon" else []
    return [[[round(point[0], 5), round(point[1], 5)] for point in polygon[0]] for polygon in polygons if polygon]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=Path(os.environ.get("RENTAL_DATA_DIR", ROOT / "rental-world-model" / "data")))
    parser.add_argument("--pause", type=float, default=0.2, help="seconds between requests")
    args = parser.parse_args()
    key = os.environ.get("MICROBURBS_API_KEY")
    if not key:
        sys.exit("Set MICROBURBS_API_KEY in the environment. It is never read from or written to a file.")

    with open(args.data / "rent_history_2y.csv", newline="", encoding="utf-8") as handle:
        suburbs = sorted({record["suburb"] for record in csv.DictReader(handle)})
    blocks, requests, missing = {}, 0, []
    for suburb in suburbs:
        shapes = get(suburb, "shapes/mesh-blocks", key, args.pause)
        income = get(suburb, "demographics/income-map", key, args.pause)
        crime = get(suburb, "crime/by-mesh-block", key, args.pause)
        livability = get(suburb, "lifestyle/livability-map", key, args.pause)
        requests += 4
        if not shapes:
            missing.append(suburb)
            continue
        for feature in shapes["geojson"]["features"]:
            properties = feature.get("properties") or {}
            code = str(properties.get("mb_code") or properties.get("mb") or properties.get("MB_CODE_2021")
                       or properties.get("mb_code_2021") or feature.get("id") or "")
            outline = rings(feature.get("geometry"))
            if code and outline:
                blocks.setdefault(code, {"suburb": suburb, "rings": outline})
        for item in (income or {}).get("microburbs", []):
            if str(item.get("mb")) in blocks and item.get("weekly_income") is not None:
                blocks[str(item["mb"])]["income"] = item["weekly_income"]
        for code, rate in ((crime or {}).get("mesh_blocks") or {}).items():
            if str(code) in blocks and rate is not None:
                blocks[str(code)]["crime"] = rate
        for item in (livability or {}).get("microburbs", []):
            if str(item.get("mb")) in blocks:
                blocks[str(item["mb"])]["livability"] = {name: value for name, value in (item.get("scores") or {}).items()
                                                         if isinstance(value, (int, float))}
        print(f"{suburb}: {len(shapes['geojson']['features'])} mesh blocks")
    payload = {"collected_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "source": "Microburbs hackathon API: shapes/mesh-blocks, demographics/income-map, crime/by-mesh-block, lifestyle/livability-map",
               "blocks": blocks}
    target = args.data / "mesh_blocks.json"
    target.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    have = lambda name: sum(1 for block in blocks.values() if name in block)  # noqa: E731
    print(f"\n{requests} requests, {len(suburbs)} suburbs, {len(blocks)} mesh blocks → {target} ({target.stat().st_size / 1e6:.2f} MB)")
    print(f"with income {have('income')}, crime {have('crime')}, livability {have('livability')}; suburbs without shapes: {missing or 'none'}")


if __name__ == "__main__":
    main()
