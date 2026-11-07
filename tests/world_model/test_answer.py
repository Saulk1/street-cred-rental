import os
import sys
import threading
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
_BACKEND = os.path.join(_ROOT, "compute")
_FIXTURES = os.path.join(_ROOT, "tests", "fixtures", "world_model")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from world_model import (
    AnswerInput,
    AnswerResolution,
    FixedRanker,
    Listing,
    OrchestrationService,
    ProfileStore,
    QuestionRegistry,
    StationWalkRequirement,
    UserState,
    parse_custom_distance,
    resolve_answer,
)
from world_model.types import STATION_CONFIRMED, STATION_DEFERRED

SEARCH_ID = "search-1"


def listing(listing_id, walk, rent=700.0, market=4.0, district="西湖", bedrooms=2):
    return Listing(listing_id=listing_id, station_walk_m=walk, weekly_rent=rent,
                   supermarket_walk_min=market, district=district, bedrooms=bedrooms, source="demo")


def state(station=None, **overrides):
    payload = dict(budget_weekly_max=750.0, bedrooms=2, districts=("西湖",),
                   soft_preferences={"emphasis": "groceries"}, other_confirmed={"pets_allowed": False},
                   station_walk=station if station is not None else StationWalkRequirement())
    payload.update(overrides)
    return UserState(**payload)


def answer(option_id=None, custom_text=None, base_version=3, current_version=3, current=None):
    return AnswerInput(question_id="question-001", event_id="event-001",
                       base_state_version=base_version, current_state_version=current_version,
                       current_state=current if current is not None else state(),
                       option_id=option_id, custom_text=custom_text)


class OptionResolutionTest(unittest.TestCase):
    """§12.1 第 3、6、7 条：四个选项与自定义距离。"""

    def test_four_hundred_option(self):
        resolution = resolve_answer(answer(option_id="le_400"))
        self.assertEqual(resolution.status, "applied")
        self.assertEqual(resolution.state_patch,
                         {"station_walk": {"status": STATION_CONFIRMED, "max_m": 400.0}})
        self.assertEqual(resolution.next_state.station_walk.max_m, 400.0)
        self.assertTrue(resolution.should_recommend)

    def test_thousand_option(self):
        resolution = resolve_answer(answer(option_id="le_1000"))
        self.assertEqual(resolution.next_state.station_walk.max_m, 1000.0)

    def test_no_limit_option_is_confirmed_without_limit(self):
        resolution = resolve_answer(answer(option_id="no_limit"))
        self.assertEqual(resolution.status, "applied")
        self.assertEqual(resolution.next_state.station_walk.status, STATION_CONFIRMED)
        self.assertIsNone(resolution.next_state.station_walk.max_m)

    def test_skip_option_is_deferred_not_no_limit(self):
        resolution = resolve_answer(answer(option_id="skip"))
        self.assertEqual(resolution.status, "skipped")
        self.assertEqual(resolution.next_state.station_walk.status, STATION_DEFERRED)
        self.assertIsNone(resolution.next_state.station_walk.max_m)
        self.assertNotEqual(resolution.next_state.station_walk,
                            StationWalkRequirement(STATION_CONFIRMED, None))

    def test_custom_distance_is_kept_exactly(self):
        resolution = resolve_answer(answer(custom_text="最多 600 米"))
        self.assertEqual(resolution.next_state.station_walk.max_m, 600.0,
                         "600 不能被映射到 400 或 1000")

    def test_unknown_option_is_rejected(self):
        resolution = resolve_answer(answer(option_id="le_800"))
        self.assertEqual(resolution.status, "invalid_answer")

    def test_patch_does_not_touch_other_conditions(self):
        resolution = resolve_answer(answer(option_id="le_400"))
        next_state = resolution.next_state
        self.assertEqual(next_state.budget_weekly_max, 750.0)
        self.assertEqual(next_state.bedrooms, 2)
        self.assertEqual(next_state.districts, ("西湖",))
        self.assertEqual(next_state.other_confirmed["pets_allowed"], False)


class CustomTextTest(unittest.TestCase):
    """§4.1/§7.4：单位不清先确认，不静默换算猜测。"""

    def test_metres_are_accepted(self):
        for text, expected in (("400米", 400.0), ("600 m", 600.0), ("最多 1000 米以内", 1000.0)):
            kind, value, _reason, needs_confirm = parse_custom_distance(text)
            self.assertEqual((kind, value), ("limit", expected), text)
            self.assertFalse(needs_confirm, text)

    def test_kilometres_with_explicit_unit_are_converted(self):
        kind, value, _reason, _needs = parse_custom_distance("1.2 公里")
        self.assertEqual((kind, value), ("limit", 1200.0))

    def test_bare_number_is_ambiguous(self):
        kind, value, reason, needs_confirm = parse_custom_distance("600")
        self.assertEqual((kind, value, reason), ("ambiguous", None, "ambiguous_unit"))
        self.assertTrue(needs_confirm, "单位不清时必须继续确认")

    def test_time_unit_is_not_a_distance(self):
        kind, _value, reason, needs_confirm = parse_custom_distance("10 分钟")
        self.assertEqual((kind, reason), ("ambiguous", "unsupported_unit"))
        self.assertTrue(needs_confirm)

    def test_negative_number_is_rejected(self):
        self.assertEqual(parse_custom_distance("-600 米")[0], "invalid")

    def test_non_numeric_text_is_rejected(self):
        self.assertEqual(parse_custom_distance("随便吧")[0], "invalid")

    def test_no_limit_text(self):
        self.assertEqual(parse_custom_distance("车站距离不设限制")[0], "no_limit")

    def test_skip_text(self):
        self.assertEqual(parse_custom_distance("暂时跳过")[0], "skip")

    def test_zero_metres_is_legal(self):
        kind, value, _reason, _needs = parse_custom_distance("0 米")
        self.assertEqual((kind, value), ("limit", 0.0))

    def test_ambiguous_text_does_not_apply_a_patch(self):
        resolution = resolve_answer(answer(custom_text="600"))
        self.assertEqual(resolution.status, "invalid_answer")
        self.assertIsNone(resolution.state_patch)
        self.assertTrue(resolution.requires_confirmation)
        self.assertFalse(resolution.should_recommend)


class StaleAnswerTest(unittest.TestCase):
    """§7.3/§12.1 第 10 条：旧按钮不得覆盖新档案。"""

    def test_version_mismatch_returns_stale_state_without_patch(self):
        resolution = resolve_answer(answer(option_id="le_400", base_version=3, current_version=4))
        self.assertEqual(resolution.status, "stale_state")
        self.assertIsNone(resolution.state_patch)
        self.assertFalse(resolution.should_recommend)


class ServiceTestCase(unittest.TestCase):
    def make_service(self, candidates=None, version=3, profile=None):
        pool = tuple(candidates) if candidates is not None else (listing("A", 900), listing("B", 250))
        store = ProfileStore(profile if profile is not None else state(), state_version=version)
        return OrchestrationService(
            store=store, ranker=FixedRanker("ranker-007"),
            candidate_provider=lambda search_id: ("candidates-003", pool),
        )


class AskRegistrationTest(ServiceTestCase):
    """§5.3：ask 只是提案，登记成功后才能展示；并发与刷新都复用同一条记录。"""

    def test_asking_registers_a_pending_question(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "ask")
        self.assertEqual(plan.question_id, "question-001")
        self.assertEqual(len(plan.options), 4)
        record = service.registry.pending(SEARCH_ID)
        self.assertIsNotNone(record)
        self.assertEqual(record.base_state_version, 3)
        self.assertEqual(service.store.snapshot()[0], 3, "登记问句不得改动档案版本")

    def test_refresh_reuses_the_same_question_id(self):
        service = self.make_service()
        first = service.request_plan(SEARCH_ID)
        second = service.request_plan(SEARCH_ID)
        self.assertEqual(first.question_id, second.question_id)
        self.assertEqual(second.reason_code, "restored_pending")
        self.assertEqual(len(service.registry.records()), 1)

    def test_concurrent_asks_register_only_once(self):
        service = self.make_service()
        results = []

        def worker():
            results.append(service.request_plan(SEARCH_ID))

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(results), 8)
        self.assertEqual({plan.question_id for plan in results}, {"question-001"})
        self.assertEqual(len(service.registry.records()), 1, "并发发问只允许建立一个问题")
        self.assertEqual(len(service.registry.asked_keys(SEARCH_ID)), 1)

    def test_version_change_does_not_allow_a_second_question(self):
        """审计回归：旧问题失效后，同一任务不得再问同一条。"""
        service = self.make_service()
        first = service.request_plan(SEARCH_ID)
        self.assertEqual(first.action, "ask")
        # 另一条流程只动了版本、没动车站要求
        service.store.apply_answer(
            expected_version=3, patch={"station_walk": {"status": "unknown", "max_m": None}},
            event_id="evt-other", question_id="other-flow",
            resolution=AnswerResolution(status="applied", reason_code="external_update"),
        )
        again = service.request_plan(SEARCH_ID)
        self.assertEqual(again.action, "recommend")
        self.assertEqual(again.reason_code, "already_asked")
        self.assertIsNone(again.question_id, "不得生成第二个问题")
        self.assertEqual(len(service.registry.records()), 1)

    def test_expired_pending_question_is_not_restored_and_not_reasked(self):
        pool = (listing("A", 900), listing("B", 250))
        service = OrchestrationService(
            store=ProfileStore(state(), state_version=3), ranker=FixedRanker("ranker-007"),
            candidate_provider=lambda search_id: ("candidates-003", pool),
            registry=QuestionRegistry(pending_ttl_s=0.01),
        )
        first = service.request_plan(SEARCH_ID)
        self.assertEqual(first.action, "ask")
        time.sleep(0.05)
        again = service.request_plan(SEARCH_ID)
        self.assertIsNone(again.question_id, "过期问题不应再被恢复")
        self.assertEqual(again.action, "recommend")
        self.assertEqual(again.reason_code, "already_asked")
        self.assertEqual(len(service.registry.records()), 1)

    def test_fresh_pending_question_is_still_restored(self):
        service = self.make_service()
        first = service.request_plan(SEARCH_ID)
        again = service.request_plan(SEARCH_ID)
        self.assertEqual(again.question_id, first.question_id)

    def test_recommend_path_opens_no_question(self):
        service = self.make_service(candidates=(listing("A", 200), listing("B", 250)))
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "recommend")
        self.assertIsNone(plan.question_id)
        self.assertEqual(service.registry.records(), [])


class RealAnswerFlowTest(ServiceTestCase):
    """§7：真实回答才改档案，之后按真实档案重新推荐。"""

    def test_answer_updates_profile_and_recommends_b(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        self.assertEqual(outcome["resolution"]["status"], "applied")
        self.assertEqual(outcome["state_version"], 4)
        version, profile = service.store.snapshot()
        self.assertEqual(version, 4)
        self.assertEqual(profile.station_walk.max_m, 400.0)
        self.assertEqual(outcome["recommendation"]["top_listing_id"], "B")
        self.assertEqual(outcome["recommendation"]["listing_ids"], ["B"])

    def test_same_event_id_applies_once(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        first = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        second = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        self.assertEqual(service.store.snapshot()[0], 4, "重复提交不得再次递增版本")
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["resolution"], second["resolution"])

    def test_skip_keeps_requirement_unknown(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-skip", option_id="skip")
        self.assertEqual(outcome["resolution"]["status"], "skipped")
        _version, profile = service.store.snapshot()
        self.assertEqual(profile.station_walk.status, STATION_DEFERRED)
        self.assertIsNone(profile.station_walk.max_m)

    def test_no_second_question_after_answering(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_1000")
        again = service.request_plan(SEARCH_ID)
        self.assertEqual(again.action, "recommend")
        self.assertEqual(again.reason_code, "already_confirmed")

    def test_no_second_question_after_skipping(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        service.submit_answer(question_id=plan.question_id, event_id="evt-skip", option_id="skip")
        again = service.request_plan(SEARCH_ID)
        self.assertEqual(again.action, "recommend")
        self.assertEqual(again.reason_code, "already_skipped")
        self.assertEqual(len(service.registry.records()), 1)

    def test_confirmed_requirement_with_no_listing_does_not_relax(self):
        service = self.make_service(candidates=(listing("A", 900), listing("B", 600)))
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "ask")
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        self.assertEqual(outcome["recommendation"]["action"], "no_match")
        self.assertEqual(outcome["recommendation"]["listing_ids"], [])
        _version, profile = service.store.snapshot()
        self.assertEqual(profile.station_walk.max_m, 400.0, "不得自动把 400 放宽成 1000")
        self.assertIn("没有同时满足", outcome["recommendation"]["message"])

    def test_custom_answer_is_stored_verbatim(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", custom_text="最多 600 米")
        self.assertEqual(outcome["resolution"]["status"], "applied")
        _version, profile = service.store.snapshot()
        self.assertEqual(profile.station_walk.max_m, 600.0)

    def test_ambiguous_custom_answer_changes_nothing(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", custom_text="600")
        self.assertEqual(outcome["resolution"]["status"], "invalid_answer")
        self.assertTrue(outcome["resolution"]["requires_confirmation"])
        self.assertEqual(service.store.snapshot()[0], 3, "含糊回答不得写入档案")
        self.assertEqual(service.registry.pending(SEARCH_ID).question_id, plan.question_id,
                         "问题应保持 pending，等待用户给出明确距离")

    def test_unknown_question_is_rejected(self):
        service = self.make_service()
        outcome = service.submit_answer(question_id="question-999", event_id="evt-x", option_id="le_400")
        self.assertEqual(outcome["resolution"]["reason_code"], "unknown_question")
        self.assertEqual(service.store.snapshot()[0], 3)


class StaleButtonTest(ServiceTestCase):
    """§12.1 第 10 条：旧按钮对应版本与当前档案不同。"""

    def test_stale_button_does_not_overwrite_newer_profile(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        # 另一个流程先更新了档案（例如用户主动修改了预算）
        service.store.apply_answer(
            expected_version=3,
            patch={"station_walk": {"status": STATION_CONFIRMED, "max_m": 1000.0}},
            event_id="evt-other",
            question_id="other-flow",
            resolution=AnswerResolution(status="applied", reason_code="external_update"),
        )
        self.assertEqual(service.store.snapshot()[0], 4)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-late", option_id="le_400")
        self.assertEqual(outcome["resolution"]["status"], "stale_state")
        self.assertEqual(outcome["recommendation"], None)
        version, profile = service.store.snapshot()
        self.assertEqual(version, 4, "过期按钮不得写档案")
        self.assertEqual(profile.station_walk.max_m, 1000.0, "不得覆盖较新的档案")
        self.assertEqual(service.registry.get(plan.question_id).status, "invalidated")

    def test_stale_pending_question_is_not_restored_after_version_change(self):
        service = self.make_service()
        first = service.request_plan(SEARCH_ID)
        service.store.apply_answer(
            expected_version=3,
            patch={"station_walk": {"status": STATION_CONFIRMED, "max_m": 1000.0}},
            event_id="evt-other",
            question_id="other-flow",
            resolution=AnswerResolution(status="applied", reason_code="external_update"),
        )
        again = service.request_plan(SEARCH_ID)
        self.assertNotEqual(again.question_id, first.question_id)
        self.assertEqual(again.action, "recommend")
        self.assertEqual(again.reason_code, "already_confirmed")


class SimulationDoesNotLeakTest(ServiceTestCase):
    """§12.1 第 11 条：模拟不写档案、不动推荐器参数。"""

    def test_asking_leaves_profile_and_ranker_untouched(self):
        service = self.make_service()
        before_version, before_profile = service.store.snapshot()
        before_fingerprint = before_profile.fingerprint()
        before_ranker = service.ranker.params_fingerprint()
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "ask")
        after_version, after_profile = service.store.snapshot()
        self.assertEqual(after_version, before_version)
        self.assertEqual(after_profile.fingerprint(), before_fingerprint)
        self.assertEqual(service.ranker.params_fingerprint(), before_ranker)
        self.assertEqual(after_profile.station_walk.status, "unknown")


class BranchConsistencyTest(ServiceTestCase):
    """§12.2：回答落入标准分支且版本相同时，模拟首选应与真实重算首选一致。"""

    def test_standard_branch_matches_its_simulation(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        consistency = outcome["branch_consistency"]
        self.assertEqual(consistency["matched_scenario"], "station-le-400")
        self.assertEqual(consistency["simulated_top"], "B")
        self.assertEqual(consistency["real_top"], "B")
        self.assertTrue(consistency["consistent"])

    def test_no_limit_branch_matches_its_simulation(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="no_limit")
        consistency = outcome["branch_consistency"]
        self.assertEqual(consistency["matched_scenario"], "station-no-limit")
        self.assertEqual(consistency["simulated_top"], "A")
        self.assertTrue(consistency["consistent"])

    def test_custom_distance_is_not_compared_to_a_standard_branch(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", custom_text="最多 600 米")
        consistency = outcome["branch_consistency"]
        self.assertIsNone(consistency["matched_scenario"])
        self.assertIsNone(consistency["consistent"])
        self.assertEqual(consistency["reason"], "custom_distance_outside_standard_branches")

    def test_skip_has_no_branch_to_compare(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="skip")
        self.assertEqual(outcome["branch_consistency"]["reason"], "requirement_not_confirmed")

    def test_snapshot_change_blocks_the_comparison(self):
        pool = (listing("A", 900), listing("B", 250))
        holder = {"snapshot": "candidates-003"}
        store = ProfileStore(state(), state_version=3)
        service = OrchestrationService(
            store=store, ranker=FixedRanker("ranker-007"),
            candidate_provider=lambda search_id: (holder["snapshot"], pool),
        )
        plan = service.request_plan(SEARCH_ID)
        holder["snapshot"] = "candidates-004"
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        self.assertEqual(outcome["branch_consistency"]["reason"], "snapshot_changed")
        self.assertIsNone(outcome["branch_consistency"]["consistent"],
                          "版本不同时不得声称模拟与重算一致")


class NegativeSignVariantTest(unittest.TestCase):
    """审计回归：全角与 Unicode 负号不得被读成正数，否则会写坏真实档案。"""

    def test_all_minus_variants_are_invalid(self):
        for text in ("-600米", "－600米", "−600米", "﹣600 米", "－ 600 m"):
            kind, value, _reason, _needs = parse_custom_distance(text)
            self.assertEqual((kind, value), ("invalid", None), text)

    def test_negative_variant_never_applies_a_patch(self):
        for text in ("－600米", "−600米"):
            resolution = resolve_answer(answer(custom_text=text))
            self.assertEqual(resolution.status, "invalid_answer", text)
            self.assertIsNone(resolution.state_patch, text)

    def test_fullwidth_digits_are_still_accepted(self):
        self.assertEqual(parse_custom_distance("６００米")[0:2], ("limit", 600.0))

    def test_positive_sign_is_still_a_distance(self):
        self.assertEqual(parse_custom_distance("+600米")[0:2], ("limit", 600.0))

    def test_range_is_ambiguous_not_a_distance(self):
        kind, value, reason, needs_confirm = parse_custom_distance("600-700米")
        self.assertEqual((kind, value, reason), ("ambiguous", None, "range_not_supported"))
        self.assertTrue(needs_confirm)


class FlakyRanker:
    """前几次排序正常（够跑完三分支模拟），之后开始报错。"""

    def __init__(self, fail_after=3):
        self.snapshot_id = "ranker-007"
        self.fail_after = fail_after
        self.calls = 0

    def params_fingerprint(self):
        return "stable-params"

    def rank(self, branch_state, candidates, snapshot_id):
        self.calls += 1
        if self.calls > self.fail_after:
            raise RuntimeError("ranker down")
        return [item.listing_id for item in candidates]


class RankerOutageAfterAnswerTest(ServiceTestCase):
    """审计回归：回答已写入档案后，推荐器故障不得让 submit_answer 抛异常。"""

    def service_with_flaky_ranker(self):
        pool = (listing("A", 900), listing("B", 250))
        store = ProfileStore(state(), state_version=3)
        return OrchestrationService(store=store, ranker=FlakyRanker(),
                                    candidate_provider=lambda search_id: ("candidates-003", pool))

    def test_answer_succeeds_and_degrades_the_recommendation(self):
        service = self.service_with_flaky_ranker()
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "ask")
        outcome = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        self.assertEqual(outcome["resolution"]["status"], "applied")
        self.assertEqual(service.store.snapshot()[0], 4, "要求本身必须已经写入")
        self.assertEqual(outcome["recommendation"]["action"], "fallback")
        self.assertEqual(outcome["recommendation"]["reason_code"], "ranker_error")
        self.assertIsNone(outcome["recommendation"]["top_listing_id"], "降级时不得臆造首选")
        self.assertTrue(outcome["recommendation"]["message"])
        self.assertIsNone(outcome["branch_consistency"]["consistent"])
        self.assertEqual(outcome["branch_consistency"]["reason"], "recommendation_unavailable")

    def test_retry_of_the_same_event_does_not_raise(self):
        service = self.service_with_flaky_ranker()
        plan = service.request_plan(SEARCH_ID)
        service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        again = service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="le_400")
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["recommendation"]["action"], "fallback")

    def test_missing_ranker_snapshot_degrades_instead_of_crashing(self):
        class NoSnapshotRanker:
            def rank(self, branch_state, candidates, snapshot_id):
                return [item.listing_id for item in candidates]

        pool = (listing("A", 900), listing("B", 250))
        service = OrchestrationService(
            store=ProfileStore(state(), state_version=3), ranker=NoSnapshotRanker(),
            candidate_provider=lambda search_id: ("candidates-003", pool),
        )
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "fallback")
        self.assertEqual(plan.reason_code, "stale_ranker_snapshot")


class BadSnapshotFromExistingSystemTest(ServiceTestCase):
    """审计回归：现有系统给出违约快照时必须降级，不能把 request_plan 打成异常。"""

    def test_pool_over_twenty_returns_needs_data(self):
        service = self.make_service(candidates=[listing(f"L{index}", 100.0 + index) for index in range(25)])
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "needs_data")
        self.assertEqual(plan.reason_code, "invalid_input")
        self.assertEqual(service.registry.records(), [])

    def test_duplicate_listing_ids_return_needs_data(self):
        service = self.make_service(candidates=[listing("A", 900), listing("A", 250)])
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "needs_data")
        self.assertEqual(plan.reason_code, "invalid_input")

    def test_candidate_provider_failure_returns_fallback(self):
        def broken_provider(search_id):
            raise RuntimeError("listing service down")

        service = OrchestrationService(
            store=ProfileStore(state(), state_version=3), ranker=FixedRanker("ranker-007"),
            candidate_provider=broken_provider,
        )
        plan = service.request_plan(SEARCH_ID)
        self.assertEqual(plan.action, "fallback")
        self.assertEqual(plan.reason_code, "candidate_snapshot_unavailable")


class LateEventLedgerTest(ServiceTestCase):
    """审计回归：过期事件不得把已答/已跳过的记录降级，否则"本任务已问过"的账会丢。"""

    def test_late_event_keeps_resolved_status_and_asked_key(self):
        service = self.make_service()
        plan = service.request_plan(SEARCH_ID)
        service.submit_answer(question_id=plan.question_id, event_id="evt-1", option_id="skip")
        self.assertEqual(service.registry.get(plan.question_id).status, "skipped")
        late = service.submit_answer(question_id=plan.question_id, event_id="evt-2", option_id="le_400")
        self.assertEqual(late["resolution"]["status"], "stale_state")
        self.assertEqual(service.registry.get(plan.question_id).status, "skipped",
                         "已跳过的记录不能被过期事件改成 invalidated")
        self.assertEqual(service.registry.asked_keys(SEARCH_ID), ("station_walk_max_m",))
        self.assertEqual(service.store.snapshot()[1].station_walk.status, STATION_DEFERRED)
