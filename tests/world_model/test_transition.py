import json
import math
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
_BACKEND = os.path.join(_ROOT, "compute")
_FIXTURES = os.path.join(_ROOT, "tests", "fixtures", "world_model")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from world_model import (
    Listing,
    PlanInput,
    RankingContractError,
    ScenarioResult,
    SimulationIntegrityError,
    StationWalkRequirement,
    UserState,
    apply_patch,
    build_scenarios,
    clone_state,
    data_problems,
    filter_feasible,
    simulate_question,
)
from world_model.ranker import FixedRanker
from world_model.types import STATION_CONFIRMED, candidates_fingerprint


def listing(listing_id, walk, rent=700.0, market=4.0, district="西湖", bedrooms=2):
    return Listing(listing_id=listing_id, station_walk_m=walk, weekly_rent=rent,
                   supermarket_walk_min=market, district=district, bedrooms=bedrooms,
                   source="demo", collected_at="2026-11-06T00:00:00Z")


def state(**overrides):
    payload = dict(budget_weekly_max=750.0, bedrooms=2, districts=("西湖",),
                   soft_preferences={"emphasis": "groceries"}, other_confirmed={"pets_allowed": False})
    payload.update(overrides)
    return UserState(**payload)


def request(candidates, ranker_id="ranker-007", user_state=None):
    return PlanInput(session_id="demo-session", search_id="search-1", state_version=3,
                     candidate_snapshot_id="candidates-003", ranker_snapshot_id=ranker_id,
                     user_state=user_state if user_state is not None else state(),
                     candidates=tuple(candidates))


class BoundaryTest(unittest.TestCase):
    """距离边界：<= 400 保留，401 排除。"""

    def test_four_hundred_kept_and_401_excluded(self):
        pool = [listing("keep", 400), listing("drop", 401)]
        simulated = state().with_station_walk(StationWalkRequirement(STATION_CONFIRMED, 400))
        self.assertEqual([item.listing_id for item in filter_feasible(simulated, pool)], ["keep"])

    def test_zero_metre_listing_survives_a_zero_limit(self):
        pool = [listing("zero", 0)]
        simulated = state().with_station_walk(StationWalkRequirement(STATION_CONFIRMED, 0))
        self.assertEqual([item.listing_id for item in filter_feasible(simulated, pool)], ["zero"])

    def test_missing_distance_is_excluded_under_a_numeric_limit(self):
        pool = [listing("gap", None)]
        simulated = state().with_station_walk(StationWalkRequirement(STATION_CONFIRMED, 400))
        self.assertEqual(filter_feasible(simulated, pool), [])


class HardRequirementIsolationTest(unittest.TestCase):
    """分支只改车站要求：预算、卧室、区域与其他确认条件不变。"""

    def test_budget_and_district_still_apply_in_every_branch(self):
        pool = [listing("cheap", 100), listing("pricey", 100, rent=900), listing("elsewhere", 100, district="滨江")]
        results = simulate_question(request(pool), FixedRanker())
        for result in results:
            self.assertEqual(result.feasible_listing_ids, ("cheap",), result.scenario_id)

    def test_patch_rejects_other_fields(self):
        with self.assertRaises(Exception):
            apply_patch(state(), {"budget_weekly_max": 999})

    def test_apply_patch_keeps_other_fields(self):
        patched = apply_patch(state(), {"station_walk": {"status": STATION_CONFIRMED, "max_m": 400}})
        self.assertEqual(patched.budget_weekly_max, 750.0)
        self.assertEqual(patched.districts, ("西湖",))
        self.assertEqual(patched.other_confirmed["pets_allowed"], False)


class BranchResultTest(unittest.TestCase):
    def test_every_branch_is_marked_as_simulation(self):
        results = simulate_question(request([listing("A", 900), listing("B", 250)]), FixedRanker())
        self.assertEqual(len(results), 3)
        for result in results:
            self.assertEqual(result.source, "simulation")
            self.assertEqual(result.candidate_snapshot_id, "candidates-003")
            self.assertEqual(result.ranker_snapshot_id, "ranker-007")

    def test_empty_branch_is_kept_as_no_match(self):
        results = simulate_question(request([listing("A", 900), listing("B", 600)]), FixedRanker())
        by_id = {result.scenario_id: result for result in results}
        empty = by_id["station-le-400"]
        self.assertEqual(empty.feasible_listing_ids, ())
        self.assertIsNone(empty.top_listing_id)
        self.assertEqual(empty.outcome, "no_match")
        self.assertEqual(len(results), 3, "零候选分支不得删除")

    def test_branch_patch_is_recorded(self):
        results = simulate_question(request([listing("A", 900)]), FixedRanker())
        self.assertEqual(results[0].next_state_patch,
                         {"station_walk": {"status": STATION_CONFIRMED, "max_m": 400.0}})
        self.assertIsNone(results[2].next_state_patch["station_walk"]["max_m"])

    def test_branches_do_not_share_state(self):
        seen = []

        class Recorder:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                seen.append((id(branch_state), id(candidates)))
                return [item.listing_id for item in candidates]

        simulate_question(request([listing("A", 900), listing("B", 250)]), Recorder())
        self.assertEqual(len({item[0] for item in seen}), 3, "三个分支必须各自持有状态副本")
        self.assertEqual(len({item[1] for item in seen}), 3, "三个分支不能共享候选列表对象")


class IsolationProofTest(unittest.TestCase):
    """Task 2：模拟后真实档案、候选快照与推荐器参数摘要都不变。"""

    def test_real_state_and_ranker_untouched(self):
        ranker = FixedRanker()
        plan_input = request([listing("A", 900), listing("B", 250)])
        state_before = plan_input.user_state.fingerprint()
        candidates_before = candidates_fingerprint(plan_input.candidates)
        ranker_before = ranker.params_fingerprint()
        simulate_question(plan_input, ranker)
        self.assertEqual(plan_input.user_state.fingerprint(), state_before)
        self.assertEqual(candidates_fingerprint(plan_input.candidates), candidates_before)
        self.assertEqual(ranker.params_fingerprint(), ranker_before)

    def test_ranker_that_mutates_real_state_is_caught(self):
        plan_input = request([listing("A", 900), listing("B", 250)])

        class LeakyRanker:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                plan_input.user_state.soft_preferences["leaked"] = True
                return [item.listing_id for item in candidates]

        with self.assertRaises(SimulationIntegrityError):
            simulate_question(plan_input, LeakyRanker())

    def test_ranker_that_changes_its_own_params_is_caught(self):
        class DriftingRanker:
            snapshot_id = "ranker-007"

            def __init__(self):
                self.calls = 0

            def params_fingerprint(self):
                self.calls += 1
                return f"fp-{self.calls}"

            def rank(self, branch_state, candidates, snapshot_id):
                return [item.listing_id for item in candidates]

        with self.assertRaises(SimulationIntegrityError):
            simulate_question(request([listing("A", 900)]), DriftingRanker())


class ReadOnlyRankerContractTest(unittest.TestCase):
    def test_out_of_pool_id_is_rejected(self):
        class GhostRanker:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                return ["Z"]

        with self.assertRaises(RankingContractError):
            simulate_question(request([listing("A", 900)]), GhostRanker())

    def test_empty_ranking_for_non_empty_pool_is_rejected(self):
        class SilentRanker:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                return []

        with self.assertRaises(RankingContractError):
            simulate_question(request([listing("A", 900)]), SilentRanker())

    def test_duplicate_ids_are_rejected(self):
        class DuplicatingRanker:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                ids = [item.listing_id for item in candidates]
                return ids + ids

        with self.assertRaises(RankingContractError):
            simulate_question(request([listing("A", 900)]), DuplicatingRanker())

    def test_snapshot_mismatch_is_rejected(self):
        with self.assertRaises(RankingContractError):
            simulate_question(request([listing("A", 900)], ranker_id="ranker-999"), FixedRanker("ranker-007"))

    def test_ties_break_on_listing_id(self):
        pool = [listing("B", 900, rent=700, market=4), listing("A", 900, rent=700, market=4)]
        results = simulate_question(request(pool), FixedRanker())
        self.assertEqual(results[2].top_listing_id, "A", "同分必须按 listing_id 固定排序")


class DataProblemTest(unittest.TestCase):
    def test_complete_pool_has_no_problems(self):
        self.assertEqual(data_problems([listing("A", 900), listing("B", 250)]), [])

    def test_missing_distance_is_reported(self):
        self.assertEqual(data_problems([listing("A", None)]), ["missing_station_walk:A"])

    def test_straight_line_distance_is_reported(self):
        pool = [Listing(listing_id="A", station_walk_m=300, distance_kind="straight_line", source="demo")]
        self.assertEqual(data_problems(pool), ["non_walking_distance:A:straight_line"])


class CloneTest(unittest.TestCase):
    def test_clone_is_deep(self):
        original = state()
        copy = clone_state(original)
        copy.soft_preferences["emphasis"] = "tampered"
        self.assertEqual(original.soft_preferences["emphasis"], "groceries")
        self.assertEqual(copy.fingerprint() == original.fingerprint(), False)
