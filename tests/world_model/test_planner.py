import json
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
    FixedRanker,
    Listing,
    PlanInput,
    StationWalkRequirement,
    UserState,
    build_scenarios,
    plan_next_step,
)
from world_model.types import STATION_CONFIRMED, STATION_DEFERRED, candidates_fingerprint


def load_fixture(name):
    with open(os.path.join(_FIXTURES, name), encoding="utf-8") as handle:
        return json.load(handle)


def listing(listing_id, walk, rent=700.0, market=4.0, district="西湖", bedrooms=2):
    return Listing(listing_id=listing_id, station_walk_m=walk, weekly_rent=rent,
                   supermarket_walk_min=market, district=district, bedrooms=bedrooms, source="demo")


def state(station=None, **overrides):
    payload = dict(budget_weekly_max=750.0, bedrooms=2, districts=("西湖",),
                   soft_preferences={"emphasis": "groceries"}, other_confirmed={"pets_allowed": False},
                   station_walk=station if station is not None else StationWalkRequirement())
    payload.update(overrides)
    return UserState(**payload)


def make_request(candidates, *, user_state=None, asked=(), ranker_id="ranker-007", version=3):
    return PlanInput(session_id="demo-session", search_id="search-1", state_version=version,
                     candidate_snapshot_id="candidates-003", ranker_snapshot_id=ranker_id,
                     user_state=user_state if user_state is not None else state(),
                     candidates=tuple(candidates), asked_question_keys=tuple(asked))


def fixture_request(name):
    fixture = load_fixture(name)
    return fixture, PlanInput.from_payload(fixture["request"])


class DecisionRuleTest(unittest.TestCase):
    """§6.2：三个首选一致 -> 推荐；存在差异 -> 问一次；NO_MATCH 也算一种结果。"""

    def test_different_tops_asks(self):
        fixture, request = fixture_request("decisive.json")
        plan = plan_next_step(request, FixedRanker(), current_state_version=request.state_version)
        self.assertEqual(plan.action, "ask")
        self.assertEqual(plan.reason_code, "different_top_choice")
        self.assertEqual(plan.question_key, "station_walk_max_m")
        self.assertIsNone(plan.question_id, "question_id 只在登记成功后由编排服务写入")
        self.assertEqual([option.id for option in plan.options], fixture["expected"]["option_ids"])
        tops = {result.scenario_id: result.top_listing_id for result in plan.scenarios}
        self.assertEqual(tops, {"station-le-400": "B", "station-le-1000": "A", "station-no-limit": "A"})

    def test_identical_tops_recommends(self):
        fixture, request = fixture_request("unchanged.json")
        plan = plan_next_step(request, FixedRanker(), current_state_version=request.state_version)
        self.assertEqual(plan.action, "recommend")
        self.assertEqual(plan.reason_code, "all_branches_agree")
        self.assertIsNone(plan.question_text)
        self.assertEqual(plan.divergence, 0.0)
        self.assertEqual(len(plan.scenarios), 3)

    def test_no_match_branch_still_asks(self):
        fixture, request = fixture_request("no_match.json")
        plan = plan_next_step(request, FixedRanker(), current_state_version=request.state_version)
        self.assertEqual(plan.action, "ask")
        branch = {result.scenario_id: result for result in plan.scenarios}["station-le-400"]
        self.assertEqual(branch.outcome, "no_match")
        self.assertEqual(branch.feasible_listing_ids, ())
        self.assertEqual(len(plan.scenarios), 3, "不得删掉零候选分支来美化结论")

    def test_divergence_two_thirds_with_three_distinct_tops(self):
        pool = [listing("X", 1500, market=1), listing("Y", 500, market=3), listing("Z", 100, market=5)]
        plan = plan_next_step(make_request(pool), FixedRanker())
        tops = {result.scenario_id: result.top_listing_id for result in plan.scenarios}
        self.assertEqual(set(tops.values()), {"X", "Y", "Z"})
        self.assertAlmostEqual(plan.divergence, 2.0 / 3.0)

    def test_divergence_is_one_third_for_two_to_one_split(self):
        fixture, request = fixture_request("decisive.json")
        plan = plan_next_step(request, FixedRanker(), current_state_version=3)
        self.assertAlmostEqual(plan.divergence, 1.0 / 3.0)


class NoAskConditionTest(unittest.TestCase):
    """§4.2：已答、已跳过、已问过一律不追问。"""

    def test_confirmed_requirement_is_not_asked_again(self):
        request = make_request([listing("A", 900)], user_state=state(StationWalkRequirement(STATION_CONFIRMED, 400)))
        plan = plan_next_step(request, FixedRanker())
        self.assertEqual(plan.action, "recommend")
        self.assertEqual(plan.reason_code, "already_confirmed")
        self.assertEqual(plan.scenarios, (), "已确认时不应再跑模拟")

    def test_confirmed_without_limit_is_not_asked_again(self):
        request = make_request([listing("A", 900)], user_state=state(StationWalkRequirement(STATION_CONFIRMED, None)))
        self.assertEqual(plan_next_step(request, FixedRanker()).reason_code, "already_confirmed")

    def test_already_asked_key_blocks_a_second_question(self):
        request = make_request([listing("A", 900), listing("B", 250)], asked=("station_walk_max_m",))
        plan = plan_next_step(request, FixedRanker())
        self.assertEqual(plan.action, "recommend")
        self.assertEqual(plan.reason_code, "already_asked")

    def test_deferred_is_not_asked_again_but_stays_unknown(self):
        request = make_request([listing("A", 900), listing("B", 250)],
                               user_state=state(StationWalkRequirement(STATION_DEFERRED, None)))
        plan = plan_next_step(request, FixedRanker())
        self.assertEqual(plan.action, "recommend")
        self.assertEqual(plan.reason_code, "already_skipped")
        self.assertEqual(request.station_walk.status, STATION_DEFERRED)
        self.assertIsNot(request.station_walk, StationWalkRequirement(STATION_CONFIRMED, None))


class BlockingConditionTest(unittest.TestCase):
    """§4.2/§6.3：空池、数据缺口、版本失效、排序器异常都不猜。"""

    def test_empty_base_pool_returns_no_match(self):
        plan = plan_next_step(make_request([]), FixedRanker())
        self.assertEqual(plan.action, "no_match")
        self.assertEqual(plan.reason_code, "base_candidates_empty")

    def test_missing_distance_returns_needs_data(self):
        fixture, request = fixture_request("missing_data.json")
        plan = plan_next_step(request, FixedRanker())
        self.assertEqual(plan.action, "needs_data")
        self.assertEqual(plan.reason_code, "data_missing")
        self.assertIn("missing_station_walk:B", plan.diagnostics["data_problems"])

    def test_straight_line_distance_returns_needs_data(self):
        pool = [Listing(listing_id="A", station_walk_m=300, distance_kind="straight_line", source="demo")]
        plan = plan_next_step(make_request(pool), FixedRanker())
        self.assertEqual(plan.action, "needs_data")
        self.assertEqual(plan.reason_code, "data_missing")

    def test_stale_state_version_returns_fallback(self):
        plan = plan_next_step(make_request([listing("A", 900)]), FixedRanker(), current_state_version=4)
        self.assertEqual(plan.action, "fallback")
        self.assertEqual(plan.reason_code, "stale_state")

    def test_ranker_snapshot_mismatch_returns_fallback(self):
        plan = plan_next_step(make_request([listing("A", 900)], ranker_id="ranker-999"), FixedRanker("ranker-007"))
        self.assertEqual(plan.action, "fallback")
        self.assertEqual(plan.reason_code, "stale_ranker_snapshot")

    def test_ranker_exception_returns_fallback(self):
        class BrokenRanker:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                raise RuntimeError("ranking service down")

        plan = plan_next_step(make_request([listing("A", 900)]), BrokenRanker())
        self.assertEqual(plan.action, "fallback")
        self.assertEqual(plan.reason_code, "ranker_error")

    def test_illegal_ranker_output_returns_fallback(self):
        class GhostRanker:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                return ["NOT_IN_POOL"]

        plan = plan_next_step(make_request([listing("A", 900)]), GhostRanker())
        self.assertEqual(plan.action, "fallback")
        self.assertEqual(plan.reason_code, "ranker_invalid_output")

    def test_invalid_station_walk_status_returns_needs_data(self):
        payload = load_fixture("decisive.json")["request"]
        payload = json.loads(json.dumps(payload))
        payload["station_walk"] = {"status": "maybe", "max_m": 400}
        request = PlanInput.from_payload(payload)
        plan = plan_next_step(request, FixedRanker())
        self.assertEqual(plan.action, "needs_data")
        self.assertEqual(plan.reason_code, "invalid_input")

    def test_invalid_payload_returns_needs_data(self):
        payload = load_fixture("decisive.json")["request"]
        payload = json.loads(json.dumps(payload))
        payload["candidates"][0]["station_walk_m"] = float("nan")
        request = PlanInput.from_payload(payload)
        plan = plan_next_step(request, FixedRanker())
        self.assertEqual(plan.action, "needs_data")
        self.assertEqual(plan.reason_code, "invalid_input")


class PresentationTest(unittest.TestCase):
    """界面只显示决策与自然问句；分支分数、版本细节留在日志。"""

    def test_public_payload_hides_simulation_details(self):
        fixture, request = fixture_request("decisive.json")
        plan = plan_next_step(request, FixedRanker(), current_state_version=3)
        public = plan.to_dict()
        self.assertEqual(public["action"], "ask")
        self.assertEqual(public["question_text"], plan.question_text)
        self.assertEqual(len(public["options"]), 4)
        for hidden in ("branches", "diagnostics", "divergence", "scenarios"):
            self.assertNotIn(hidden, public)

    def test_log_payload_keeps_diagnostics(self):
        fixture, request = fixture_request("decisive.json")
        plan = plan_next_step(request, FixedRanker(), current_state_version=3)
        log = plan.to_log_dict()
        self.assertEqual(log["diagnostics"]["branch_tops"], ["B", "A", "A"])
        self.assertEqual(log["diagnostics"]["candidate_count"], 2)
        self.assertGreaterEqual(log["diagnostics"]["duration_ms"], 0)
        for key in ("simulation_id", "search_id", "state_version",
                    "candidate_snapshot_id", "ranker_snapshot_id", "model_version"):
            self.assertIn(key, log["diagnostics"])
        self.assertEqual(len(log["branches"]), 3)

    def test_recommend_payload_has_no_question_fields(self):
        fixture, request = fixture_request("unchanged.json")
        plan = plan_next_step(request, FixedRanker(), current_state_version=3)
        public = plan.to_dict()
        self.assertEqual(public["action"], "recommend")
        self.assertNotIn("options", public)


class PurityTest(unittest.TestCase):
    def test_planning_never_mutates_the_request(self):
        fixture, request = fixture_request("decisive.json")
        state_before = request.user_state.fingerprint()
        candidates_before = candidates_fingerprint(request.candidates)
        plan_next_step(request, FixedRanker(), current_state_version=3)
        self.assertEqual(request.user_state.fingerprint(), state_before)
        self.assertEqual(candidates_fingerprint(request.candidates), candidates_before)
        self.assertEqual(request.station_walk.status, "unknown")

    def test_repeated_planning_is_reproducible(self):
        fixture, request = fixture_request("decisive.json")
        first = plan_next_step(request, FixedRanker(), current_state_version=3)
        second = plan_next_step(request, FixedRanker(), current_state_version=3)
        self.assertEqual(first.action, second.action)
        self.assertEqual([result.top_listing_id for result in first.scenarios],
                         [result.top_listing_id for result in second.scenarios])
        self.assertEqual(first.diagnostics["branch_tops"], second.diagnostics["branch_tops"])

    def test_empty_scenario_list_is_not_a_vacuous_recommend(self):
        fixture, request = fixture_request("decisive.json")
        plan = plan_next_step(request, FixedRanker(), current_state_version=3, scenarios=[])
        self.assertEqual(plan.action, "fallback")
        self.assertEqual(plan.reason_code, "no_scenarios")

    def test_standard_scenarios_are_used(self):
        plan = plan_next_step(make_request([listing("A", 900), listing("B", 250)]), FixedRanker())
        self.assertEqual([result.scenario_id for result in plan.scenarios],
                         [scenario.scenario_id for scenario in build_scenarios()])
