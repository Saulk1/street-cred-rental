import json
import os
import sys
import threading
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
_BACKEND = os.path.join(_ROOT, "compute")
_FIXTURES = os.path.join(_ROOT, "tests", "fixtures", "world_model")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

"""逐条对应实施策划 §12.1 功能验收表（第 1—12 条）。"""

from world_model import (
    AnswerResolution,
    FixedRanker,
    Listing,
    OrchestrationService,
    PlanInput,
    ProfileStore,
    StationWalkRequirement,
    UserState,
    plan_next_step,
)
from world_model.types import STATION_CONFIRMED, candidates_fingerprint

SEARCH_ID = "search-1"


def load_fixture(name):
    with open(os.path.join(_FIXTURES, name), encoding="utf-8") as handle:
        return json.load(handle)


def listing(listing_id, walk, market=4.0, rent=700.0):
    return Listing(listing_id=listing_id, station_walk_m=walk, weekly_rent=rent,
                   supermarket_walk_min=market, district="西湖", bedrooms=2, source="demo")


def state(station=None):
    return UserState(budget_weekly_max=750.0, bedrooms=2, districts=("西湖",),
                     soft_preferences={"emphasis": "groceries"}, other_confirmed={"pets_allowed": False},
                     station_walk=station if station is not None else StationWalkRequirement())


def service_for(candidates, version=3):
    pool = tuple(candidates)
    return OrchestrationService(
        store=ProfileStore(state(), state_version=version), ranker=FixedRanker("ranker-007"),
        candidate_provider=lambda search_id: ("candidates-003", pool),
    )


def service_from_fixture(name):
    """用 fixture 自带的档案与候选建服务，避免测试档案把候选过滤空。"""
    fixture = load_fixture(name)
    request = PlanInput.from_payload(fixture["request"])
    return OrchestrationService(
        store=ProfileStore(request.user_state, state_version=request.state_version),
        ranker=FixedRanker(request.ranker_snapshot_id),
        candidate_provider=lambda search_id: (request.candidate_snapshot_id, request.candidates),
    )


class AcceptanceTableTest(unittest.TestCase):
    def test_01_different_branches_ask_once(self):
        """第 1 条：三个分支为 B/A/A、要求未知 -> 主动问一次。"""
        service = service_from_fixture("decisive.json")
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "ask")
        service.request_plan(SEARCH_ID)
        self.assertEqual(len(service.registry.records()), 1, "只允许问一次")

    def test_02_identical_branches_hand_back(self):
        """第 2 条：三个分支都为 A -> 直接交回原推荐流程。"""
        fixture = load_fixture("unchanged.json")
        request = PlanInput.from_payload(fixture["request"])
        plan = plan_next_step(request, FixedRanker(), current_state_version=request.state_version)
        self.assertEqual(plan.action, "recommend")
        # 同时证明：这条路径是因为分支一致而不问，而不是因为候选被其他硬要求过滤空。
        self.assertEqual([item.feasible_listing_ids for item in plan.scenarios], [("A", "B")] * 3)
        service = service_from_fixture("unchanged.json")
        self.assertEqual(service.request_plan(SEARCH_ID).action, "recommend")
        self.assertEqual(service.registry.records(), [])

    def test_03_confirmed_requirement_is_not_asked_again(self):
        """第 3 条：用户已明确最多 400 米 -> 不重复问，按真实要求推荐。"""
        profile = state(StationWalkRequirement(STATION_CONFIRMED, 400))
        service = OrchestrationService(
            store=ProfileStore(profile, state_version=4), ranker=FixedRanker("ranker-007"),
            candidate_provider=lambda search_id: ("candidates-003", (listing("A", 900), listing("B", 250))),
        )
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "recommend")
        self.assertEqual(plan.reason_code, "already_confirmed")
        self.assertEqual(service.registry.records(), [])
        self.assertEqual(service.recommend(SEARCH_ID)["top_listing_id"], "B")

    def test_04_empty_branch_is_kept(self):
        """第 4 条：只有某个分支无房源 -> 保留 NO_MATCH，不删分支、不自动放宽。"""
        fixture = load_fixture("no_match.json")
        request = PlanInput.from_payload(fixture["request"])
        plan = plan_next_step(request, FixedRanker(), current_state_version=request.state_version)
        self.assertEqual(len(plan.scenarios), 3)
        empty = [item for item in plan.scenarios if item.top_listing_id is None]
        self.assertEqual(len(empty), 1)
        self.assertEqual(empty[0].outcome, "no_match")
        self.assertEqual(plan.action, "ask")

    def test_05_real_answer_to_zero_candidates_says_no_match(self):
        """第 5 条：用户真实选择导致零候选 -> 明确说明无匹配，由用户决定是否修改。"""
        service = service_for((listing("A", 900), listing("B", 600)))
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        self.assertEqual(outcome["recommendation"]["action"], "no_match")
        self.assertTrue(outcome["recommendation"]["message"])
        self.assertEqual(service.store.snapshot()[1].station_walk.max_m, 400.0)

    def test_06_skip_stays_unknown_and_is_not_repeated(self):
        """第 6 条：选暂时跳过 -> 保持未知，本任务不再主动问同项。"""
        service = service_for((listing("A", 900), listing("B", 250)))
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="skip")
        self.assertEqual(outcome["resolution"]["status"], "skipped")
        profile = service.store.snapshot()[1]
        self.assertEqual(profile.station_walk.status, "deferred")
        self.assertIsNone(profile.station_walk.max_m)
        again = service.request_plan(SEARCH_ID)
        self.assertEqual(again.action, "recommend")
        self.assertEqual(len(service.registry.records()), 1)

    def test_07_custom_distance_is_not_snapped_to_an_option(self):
        """第 7 条：真实输入“最多 600 米” -> 保存 600，不映射到 400 或 1000。"""
        service = service_for((listing("A", 900), listing("B", 250)))
        plan = service.request_plan(SEARCH_ID)
        service.submit_answer(question_id=plan.question_id, event_id="evt-1", custom_text="最多 600 米")
        requirement = service.store.snapshot()[1].station_walk
        self.assertEqual(requirement.max_m, 600.0)
        self.assertEqual(requirement.status, STATION_CONFIRMED)

    def test_08_bad_distance_data_stops_simulation(self):
        """第 8 条：距离为 null、负数或直线口径 -> 停止该轮模拟，返回需核实数据。"""
        cases = {
            "null": [{"listing_id": "A", "station_walk_m": None, "distance_kind": "walking", "source": "demo"}],
            "negative": [{"listing_id": "A", "station_walk_m": -20, "distance_kind": "walking", "source": "demo"}],
            "straight_line": [{"listing_id": "A", "station_walk_m": 300, "distance_kind": "straight_line", "source": "demo"}],
        }
        for label, candidates in cases.items():
            payload = json.loads(json.dumps(load_fixture("decisive.json")["request"]))
            payload["candidates"] = candidates
            request = PlanInput.from_payload(payload)
            plan = plan_next_step(request, FixedRanker(), current_state_version=payload["state_version"])
            self.assertEqual(plan.action, "needs_data", label)
            self.assertIn(plan.reason_code, ("data_missing", "invalid_input"), label)
            self.assertEqual(plan.scenarios, (), f"{label}: 数据不全时不得跑模拟")

    def test_09_duplicate_answer_refresh_and_concurrency(self):
        """第 9 条：同一回答重发、未答就刷新、并发发问 -> 只生效一次、只登记一次、恢复同一 ID。"""
        service = service_for((listing("A", 900), listing("B", 250)))
        plan = service.request_plan(SEARCH_ID)
        refreshed = service.request_plan(SEARCH_ID)
        self.assertEqual(refreshed.question_id, plan.question_id)

        first = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        second = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["state_version"], second["state_version"])
        self.assertEqual(service.store.snapshot()[0], 4)

        concurrent = service_for((listing("A", 900), listing("B", 250)))
        plans = []
        threads = [threading.Thread(target=lambda: plans.append(concurrent.request_plan(SEARCH_ID))) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual({plan.question_id for plan in plans}, {"question-001"})
        self.assertEqual(len(concurrent.registry.records()), 1)

    def test_10_stale_button_cannot_overwrite_newer_profile(self):
        """第 10 条：旧按钮版本与当前档案不同 -> 不覆盖新档案，同步最新状态。"""
        service = service_for((listing("A", 900), listing("B", 250)))
        plan = service.request_plan(SEARCH_ID)
        service.store.apply_answer(
            expected_version=3,
            patch={"station_walk": {"status": STATION_CONFIRMED, "max_m": 1000.0}},
            event_id="evt-newer", question_id="other", resolution=AnswerResolution(status="applied", reason_code="external"),
        )
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-old", option_id="le_400")
        self.assertEqual(outcome["resolution"]["status"], "stale_state")
        version, profile = service.store.snapshot()
        self.assertEqual(version, 4)
        self.assertEqual(profile.station_walk.max_m, 1000.0)

    def test_11_simulation_leaves_real_state_and_ranker_untouched(self):
        """第 11 条：完成三个模拟但未取得真实回答 -> 真实需求与推荐器参数不变。"""
        service = service_for((listing("A", 900), listing("B", 250)))
        _version, profile = service.store.snapshot()
        before_state = profile.fingerprint()
        before_ranker = service.ranker.params_fingerprint()
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "ask")
        after_version, after_profile = service.store.snapshot()
        self.assertEqual(after_version, 3)
        self.assertEqual(after_profile.fingerprint(), before_state)
        self.assertEqual(after_profile.station_walk.status, "unknown")
        self.assertEqual(service.ranker.params_fingerprint(), before_ranker)
        record = service.registry.pending(SEARCH_ID)
        self.assertEqual(record.status, "pending", "登记只更新交互元数据")

    def test_12_ranker_failure_falls_back(self):
        """第 12 条：某分支排序器报错或返回非法 ID -> 返回 fallback，不展示伪造结果。"""
        class IllegalRanker:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                return ["NOT_A_REAL_LISTING"]

        class ErrorRanker:
            snapshot_id = "ranker-007"

            def rank(self, branch_state, candidates, snapshot_id):
                raise RuntimeError("ranker unavailable")

        for ranker, expected in ((IllegalRanker(), "ranker_invalid_output"), (ErrorRanker(), "ranker_error")):
            request = PlanInput(session_id="s", search_id=SEARCH_ID, state_version=3,
                                candidate_snapshot_id="candidates-003", ranker_snapshot_id="ranker-007",
                                user_state=state(), candidates=(listing("A", 900), listing("B", 250)))
            plan = plan_next_step(request, ranker)
            self.assertEqual(plan.action, "fallback", expected)
            self.assertEqual(plan.reason_code, expected)
            self.assertIsNone(plan.question_text, "降级时不得展示伪造问句")


class FrozenConstraintTest(unittest.TestCase):
    """Global Constraints：模拟只改副本里的车站要求。"""

    def test_simulation_only_touches_station_walk(self):
        request = PlanInput(session_id="s", search_id=SEARCH_ID, state_version=3,
                            candidate_snapshot_id="candidates-003", ranker_snapshot_id="ranker-007",
                            user_state=state(), candidates=(listing("A", 900), listing("B", 250)))
        before = request.user_state.fingerprint()
        before_candidates = candidates_fingerprint(request.candidates)
        plan_next_step(request, FixedRanker(), current_state_version=3)
        self.assertEqual(request.user_state.fingerprint(), before)
        self.assertEqual(candidates_fingerprint(request.candidates), before_candidates)
