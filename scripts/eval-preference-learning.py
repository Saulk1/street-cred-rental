"""Offline evaluation of preference learning from recommendation feedback.

    python scripts/eval-preference-learning.py                       # 300 simulated users
    python scripts/eval-preference-learning.py --n 600 --seed 7 --data path/to/data

A simulated user has hidden weight multipliers and picks one of the homes shown each round
through a noisy logit choice. Every arm sees the same users. Reported per round:
regret = true cost of the top recommendation minus the true cost of the user's best home
(in ranker points; 1 point is about 1% of rent or 1 minute to a supermarket).

The simulated users are deliberately NOT drawn from the learner's prior: multipliers are
log-uniform, half the users ignore station distance entirely (weight 0, which the learner's
prior cannot represent) and the other half care far more than the prior expects,
and choice noise varies from near-random to near-deterministic. The choice rule is still a
logit over the same four score components, so this measures learning under a correctly
specified feature set, not real user behaviour. --taste adds a per-home personal taste
that no feature explains, to see how much of the gain survives a wrong model.

Needs the team-only data files (fair_rent_model.json, for_rent_snapshot.json). Standard library only.
"""
import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "compute"))

from world_model.advisor import RentalAdvisor  # noqa: E402
from world_model.fair_rent_boosted import load_fair_rent_model  # noqa: E402
from world_model.microburbs import listing_from_microburbs  # noqa: E402
from world_model.needs import apply_state_patch  # noqa: E402
from world_model.questions import QUESTION_HINTS  # noqa: E402
from world_model.transition import filter_feasible  # noqa: E402
from world_model.types import StationWalkRequirement, UserState  # noqa: E402
from world_model.value_ranker import ValueRanker  # noqa: E402

BASELINE = "heuristic, roles, drop@1"       # behaviour before this change
ARMS = {
    "no learning": None,
    BASELINE: {"learner": "heuristic", "selector": "roles", "skip_patience": 1},
    "heuristic, roles, drop@2": {"learner": "heuristic", "selector": "roles", "skip_patience": 2},
    "bayes, roles, drop@2": {"learner": "bayes", "selector": "roles", "skip_patience": 2},
    "bayes, EUS, drop@1": {"learner": "bayes", "selector": "eus", "skip_patience": 1},
    "bayes, EUS, drop@2": {"learner": "bayes", "selector": "eus", "skip_patience": 2},
    "bayes, EUS, drop@3": {"learner": "bayes", "selector": "eus", "skip_patience": 3},
    "bayes, EUS, never drop": {"learner": "bayes", "selector": "eus", "skip_patience": 0},
}
BUDGETS = {0: (550, 650, 750), 1: (700, 800, 950), 2: (950, 1100, 1300)}
DESTINATIONS = ("none", "CBD", "UTS", "USYD", "UNSW")
NOISE = (0.08, 0.25, 1.0)      # logit sharpness per point: noisy / typical / decisive


def load(data_dir):
    model = load_fair_rent_model((data_dir / "fair_rent_model.json").read_text(encoding="utf-8"))
    snapshot = json.loads((data_dir / "for_rent_snapshot.json").read_text(encoding="utf-8"))
    listings = [listing_from_microburbs(item["row"], item["enrichment"], model, snapshot["collected_at"])
                for item in snapshot["listings"]]
    ranker = ValueRanker("eval-" + model.fingerprint()[:8], model_fingerprint=model.fingerprint())
    return [item for item in listings if item.station_walk_m is not None and not item.extra.get("price_flag")], ranker


def log_uniform(rng, low, high):
    return math.exp(rng.uniform(math.log(low), math.log(high)))


def sample_user(rng):
    bedrooms = rng.choice(sorted(BUDGETS))
    start = UserState(budget_weekly_max=rng.choice(BUDGETS[bedrooms]), bedrooms=bedrooms,
                      station_walk=StationWalkRequirement(status="confirmed", max_m=None),
                      soft_preferences={"commute_to": rng.choice(DESTINATIONS)},
                      other_confirmed={"needs": {"pets": False, "furnished": False, "parking": False},
                                       "budget_stretch_pct": 0.0})
    truth = {"value": log_uniform(rng, 0.3, 3.3), "groceries": log_uniform(rng, 0.3, 3.3),
             "commute": log_uniform(rng, 0.3, 3.3)}
    if rng.random() < 0.5:      # the other half do not care about station distance at all (weight exactly 0)
        truth["station"] = log_uniform(rng, 0.5, 4.0)
    return start, truth, rng.choice(NOISE)


def choose(rng, shown_ids, cost, sharpness):
    utilities = [-sharpness * cost[listing_id] for listing_id in shown_ids]
    top = max(utilities)
    weights = [math.exp(value - top) for value in utilities]
    return rng.choices(shown_ids, weights=weights)[0]


def run_arm(options, start, truth, sharpness, listings, ranker, rounds, seed, taste=0.0):
    advisor = RentalAdvisor(listings, ranker, initial_state=start, max_questions=0, **(options or {}))
    advisor.asked_keys = list(QUESTION_HINTS)          # isolate feedback learning from question planning
    truth_state = apply_state_patch(start, {"weight_adjust": truth})
    feasible = filter_feasible(start, advisor.listings)
    cost = {item.listing_id: ranker.score(truth_state, item) for item in feasible}
    if taste:   # a fixed personal like/dislike per home that no feature explains
        taste_rng = random.Random(seed + 1)
        cost = {listing_id: value + taste_rng.gauss(0.0, taste) for listing_id, value in sorted(cost.items())}
    best = min(cost.values())
    rng = random.Random(seed)
    step = advisor.next()
    regrets, shown_regrets = [], []
    for _round in range(rounds + 1):
        shown = [item["listing_id"] for item in step.get("recommendations", [])]
        if not shown:
            regrets.append(float("nan"))
            shown_regrets.append(float("nan"))
            continue
        regrets.append(cost[shown[0]] - best)
        shown_regrets.append(min(cost[listing_id] for listing_id in shown) - best)
        if options is None or _round == rounds:
            continue
        step = advisor.feedback(chosen_id=choose(rng, shown, cost, sharpness))["next"]
    return regrets, shown_regrets


def mean_ci(values):
    values = [value for value in values if value == value]
    mean = sum(values) / len(values)
    if len(values) < 2:
        return mean, 0.0
    variance = sum((value - mean) ** 2 for value in values) / (len(values) - 1)
    return mean, 1.96 * math.sqrt(variance / len(values))


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=Path(os.environ.get("RENTAL_DATA_DIR", ROOT / "rental-world-model" / "data")))
    parser.add_argument("--n", type=int, default=300)
    parser.add_argument("--rounds", type=int, default=6)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--arms", nargs="*", default=list(ARMS))
    parser.add_argument("--taste", type=float, default=0.0,
                        help="std dev (points) of a per-home personal taste the model cannot see")
    args = parser.parse_args()

    listings, ranker = load(args.data)
    rng = random.Random(args.seed)
    results = {arm: [] for arm in args.arms}
    shown_results = {arm: [] for arm in args.arms}
    by_noise = {arm: {level: [] for level in NOISE} for arm in args.arms}
    started, done, skipped = time.time(), 0, 0
    while done < args.n:
        start, truth, sharpness = sample_user(rng)
        if len(filter_feasible(start, listings)) < 5:
            skipped += 1
            continue
        seed = rng.randrange(1 << 30)
        for arm in args.arms:
            regrets, shown_regrets = run_arm(ARMS[arm], start, truth, sharpness, listings, ranker, args.rounds,
                                             seed, args.taste)
            if ARMS[arm] is None:
                regrets, shown_regrets = regrets[:1] * (args.rounds + 1), shown_regrets[:1] * (args.rounds + 1)
            results[arm].append(regrets)
            shown_results[arm].append(shown_regrets)
            by_noise[arm][sharpness].append(regrets[-1])
        done += 1

    print(f"\n{args.n} simulated users, seed {args.seed}, unseen taste sd {args.taste}, {skipped} skipped (fewer than 5 feasible homes), "
          f"{time.time() - started:.0f} s. Regret of the top recommendation, in points; ± is a 95% interval.")
    print(f"{'arm':<26}" + "".join(f"{'round ' + str(i):>10}" for i in range(args.rounds + 1)) + f"{'cumulative':>16}")
    for arm in args.arms:
        rows = results[arm]
        cells = "".join(f"{mean_ci([row[i] for row in rows])[0]:>10.2f}" for i in range(args.rounds + 1))
        total, total_ci = mean_ci([sum(row) for row in rows])
        print(f"{arm:<26}{cells}{total:>10.2f} ±{total_ci:<4.2f}")
    print("\nRegret of the best home among those shown (what a careful user could still pick):")
    for arm in args.arms:
        rows = shown_results[arm]
        print(f"{arm:<26}" + "".join(f"{mean_ci([row[i] for row in rows])[0]:>10.2f}" for i in range(args.rounds + 1)))
    print("\nFinal-round regret by choice noise (sharpness per point):")
    for arm in args.arms:
        print(f"{arm:<26}" + "".join(f"  {level}: {mean_ci(values)[0]:.2f} ±{mean_ci(values)[1]:.2f}"
                                    for level, values in by_noise[arm].items() if values))
    base = BASELINE
    if base in results:
        print(f"\nPaired difference against '{base}' (negative = better):")
        for arm in args.arms:
            if arm in (base, "no learning"):
                continue
            last, last_ci = mean_ci([a[-1] - b[-1] for a, b in zip(results[arm], results[base])])
            total, total_ci = mean_ci([sum(a) - sum(b) for a, b in zip(results[arm], results[base])])
            print(f"{arm:<26}  final round {last:+.2f} ±{last_ci:.2f}   cumulative {total:+.2f} ±{total_ci:.2f}")


if __name__ == "__main__":
    main()
