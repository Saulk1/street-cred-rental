"""Fit and back-test the fair-rent models on the team-only rent history.

    python scripts/fit-fair-rent.py --data <dir>                 # back-test v1 against v2
    python scripts/fit-fair-rent.py --data <dir> --write <dir>   # also fit v2 on all rows and write fair_rent_model.json

Back-test: fit on listings before --cutoff, predict every later listing using only what
was known before its date (walk forward), and compare with the advertised rent.
v2's tree count is chosen by early stopping on the last 90 days BEFORE the cutoff, so the
test period is never used for tuning. Standard library only; fitting takes a few minutes.
"""
import argparse
import math
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "compute"))

from world_model.fair_rent import FairRentModel, load_rent_history_csv  # noqa: E402
from world_model.fair_rent_boosted import AreaFeatures, BoostedFairRent  # noqa: E402


def metrics(pairs):
    errors = sorted(abs(prediction - row.weekly_rent) / row.weekly_rent for row, prediction in pairs)
    mae = sum(abs(prediction - row.weekly_rent) for row, prediction in pairs) / len(pairs)
    return {"n": len(pairs), "MAE": mae, "MdAPE": 100 * errors[len(errors) // 2],
            "within10": 100 * sum(e <= 0.10 for e in errors) / len(errors),
            "within20": 100 * sum(e <= 0.20 for e in errors) / len(errors)}


def show(label, result):
    print(f"{label:<34} n={result['n']:>5}  MAE ${result['MAE']:>6.1f}  MdAPE {result['MdAPE']:>5.2f}%  "
          f"within 10% {result['within10']:>5.1f}%  within 20% {result['within20']:>5.1f}%")


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=Path(os.environ.get("RENTAL_DATA_DIR", ROOT / "rental-world-model" / "data")))
    parser.add_argument("--cutoff", default="2026-08-01")
    parser.add_argument("--write", type=Path, help="directory to write fair_rent_model.json (v2 fitted on all rows)")
    parser.add_argument("--trees", type=int, default=400)
    parser.add_argument("--depth", type=int, default=5)
    parser.add_argument("--rate", type=float, default=0.08)
    parser.add_argument("--areas", action="store_true",
                        help="also use mesh_blocks.json (income, crime, livability); measured to add nothing, so off by default")
    args = parser.parse_args()

    rows = [row for row in load_rent_history_csv(str(args.data / "rent_history_2y.csv")) if 150 <= row.weekly_rent <= 8000]
    train = [row for row in rows if row.listing_date < args.cutoff]
    test = [row for row in rows if row.listing_date >= args.cutoff]
    print(f"{len(train)} listings before {args.cutoff}, {len(test)} after")

    v1 = FairRentModel.fit(train, repeat_weight=0.9)
    v1_pairs = [(row, v1.estimate(suburb=row.suburb, property_type=row.property_type, bedrooms=row.bedrooms,
                                  bathrooms=row.bathrooms, car_spaces=row.car_spaces, lat=row.lat, lng=row.lng,
                                  date_text=row.listing_date, gnaf=row.gnaf).fair_rent) for row in test]
    started = time.time()
    params = {"n_trees": args.trees, "max_depth": args.depth, "learning_rate": args.rate}
    areas = None
    if args.areas:
        import json
        areas = AreaFeatures.from_mesh_blocks(json.loads((args.data / "mesh_blocks.json").read_text(encoding="utf-8")))
        covered = sum(1 for row in rows if areas.lookup(row.lat, row.lng)[1] is not None)
        print(f"mesh-block features: {len(areas.blocks)} blocks, {100 * covered / len(rows):.1f}% of listings fall inside one")
    v2 = BoostedFairRent.fit(train, log=print, areas=areas, **params)
    chosen = len(v2.booster.trees)
    print(f"v2 fitted in {time.time() - started:.0f} s; early stopping kept {chosen} trees, repeat weight {v2.repeat_weight:.2f}")
    v2_pairs = v2.walk_forward(test)

    seen = set(v1.last_seen)
    print("\nAll later listings")
    show("v1 hand-built layers", metrics(v1_pairs))
    show("v2 boosted trees", metrics(v2_pairs))
    for label, keep in (("Home listed before", lambda row: row.gnaf in seen), ("Home never listed before", lambda row: row.gnaf not in seen)):
        print("\n" + label)
        show("v1 hand-built layers", metrics([pair for pair in v1_pairs if keep(pair[0])]))
        show("v2 boosted trees", metrics([pair for pair in v2_pairs if keep(pair[0])]))
    by_row = {id(row): prediction for row, prediction in v1_pairs}
    wins = [abs(prediction - row.weekly_rent) < abs(by_row[id(row)] - row.weekly_rent) for row, prediction in v2_pairs]
    diffs = [abs(math.log(by_row[id(row)] / row.weekly_rent)) - abs(math.log(prediction / row.weekly_rent)) for row, prediction in v2_pairs]
    mean = sum(diffs) / len(diffs)
    spread = 1.96 * math.sqrt(sum((d - mean) ** 2 for d in diffs) / (len(diffs) - 1) / len(diffs))
    print(f"\nv2 is closer than v1 on {100 * sum(wins) / len(wins):.1f}% of listings; "
          f"mean reduction in absolute log error {mean:.4f} ±{spread:.4f} (paired, 95%)")
    gains = sorted(zip(v2.booster.feature_gain(), v2.feature_names), reverse=True)
    total = sum(gain for gain, _name in gains) or 1.0
    print("Split gain by feature: " + ", ".join(f"{name} {100 * gain / total:.1f}%" for gain, name in gains[:14]))

    if args.write:
        started = time.time()
        final = BoostedFairRent.fit(rows, valid_days=0, repeat_weight=v2.repeat_weight, areas=areas, n_trees=chosen,
                                    max_depth=args.depth, learning_rate=args.rate)
        args.write.mkdir(parents=True, exist_ok=True)
        target = args.write / "fair_rent_model.json"
        target.write_text(final.to_json(), encoding="utf-8")
        print(f"\nWrote {target} ({target.stat().st_size / 1e6:.1f} MB): {final.version}, {final.n_train} listings through "
              f"{final.trained_through}, {chosen} trees, fitted in {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
