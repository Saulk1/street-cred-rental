"""真实数据接入：公平租金、价值排序器、自适应问句、估算误差稳健性、Microburbs 适配。"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "compute"))

from world_model import (  # noqa: E402
    Listing,
    OrchestrationService,
    PlanInput,
    ProfileStore,
    StationWalkRequirement,
    UserState,
    plan_next_step,
)
from world_model.fair_rent import FairRentModel, RentObservation  # noqa: E402
from world_model.microburbs import (  # noqa: E402
    MicroburbsClient,
    MicroburbsError,
    build_candidate_pool,
    enrichment_from_responses,
    estimate_walk_m,
    listing_from_microburbs,
)
from world_model.scenarios import build_adaptive_question  # noqa: E402
from world_model.transition import data_problems  # noqa: E402
from world_model.types import WALK_HIGH_KEY, WALK_LOW_KEY  # noqa: E402
from world_model.value_ranker import ValueRanker  # noqa: E402

SNAP = "value-ranker-test"


def est(listing_id, rent, fair, market_min, walk, low=None, high=None, beds=1, suburb="Surry Hills"):
    """估算口径房源；不给 low/high 时误差带退化为点值（仍是合法估算口径）。"""
    extra = {"fair_rent": fair, WALK_LOW_KEY: walk if low is None else low,
             WALK_HIGH_KEY: walk if high is None else high}
    return Listing(listing_id=listing_id, station_walk_m=walk, distance_kind="walking_estimated",
                   weekly_rent=rent, bedrooms=beds, district=suburb, supermarket_walk_min=market_min,
                   source="real", extra=extra)


def request(candidates, station=None, emphasis="value", budget=None):
    state = UserState(budget_weekly_max=budget, soft_preferences={"emphasis": emphasis},
                      station_walk=station or StationWalkRequirement())
    return PlanInput(session_id="s", search_id="search-x", state_version=1,
                     candidate_snapshot_id="cands-1", ranker_snapshot_id=SNAP,
                     user_state=state, candidates=tuple(candidates))


# ---------------------------------------------------------------------------
class FairRentModelTest(unittest.TestCase):
    def rows(self):
        out = []
        for i in range(40):
            out.append(RentObservation("Surry Hills", "Unit", 1, 1, 0, 800 + (i % 5) * 10, f"2026-0{1 + i % 6}-10",
                                       -33.886, 151.211, f"G{i}"))
            out.append(RentObservation("Zetland", "Unit", 1, 1, 0, 700 + (i % 5) * 10, f"2026-0{1 + i % 6}-10",
                                       -33.906, 151.209, f"Z{i}"))
            out.append(RentObservation("Zetland", "Unit", 2, 2, 1, 1000 + (i % 5) * 10, f"2026-0{1 + i % 6}-10",
                                       -33.906, 151.209, f"Y{i}"))
        return out

    def test_suburb_effect_and_bedrooms_are_learned(self):
        model = FairRentModel.fit(self.rows())
        surry = model.estimate(suburb="Surry Hills", property_type="Unit", bedrooms=1, date_text="2026-06-20").fair_rent
        zet1 = model.estimate(suburb="Zetland", property_type="Unit", bedrooms=1, date_text="2026-06-20").fair_rent
        zet2 = model.estimate(suburb="Zetland", property_type="Unit", bedrooms=2, date_text="2026-06-20").fair_rent
        self.assertGreater(surry, zet1)
        self.assertGreater(zet2, zet1)
        self.assertTrue(650 < zet1 < 850, zet1)

    def test_unknown_suburb_falls_back_to_type_beds(self):
        model = FairRentModel.fit(self.rows())
        estimate = model.estimate(suburb="Nowhere", property_type="Unit", bedrooms=1)
        self.assertEqual(estimate.level, "type_beds")

    def test_repeat_listing_pulls_towards_prior_rent_but_not_same_day(self):
        rows = self.rows() + [RentObservation("Zetland", "Unit", 1, 1, 0, 1200, "2026-03-01", None, None, "HOT")]
        model = FairRentModel.fit(rows)
        later = model.estimate(suburb="Zetland", property_type="Unit", bedrooms=1, date_text="2026-06-01", gnaf="HOT")
        same_day = model.estimate(suburb="Zetland", property_type="Unit", bedrooms=1, date_text="2026-03-01", gnaf="HOT")
        self.assertIsNotNone(later.repeat_rent)
        self.assertGreater(later.fair_rent, later.hedonic_rent)
        self.assertIsNone(same_day.repeat_rent)  # 不能用"自己"预测自己

    def test_json_round_trip_is_exact(self):
        model = FairRentModel.fit(self.rows())
        clone = FairRentModel.from_json(model.to_json())
        kwargs = dict(suburb="Zetland", property_type="Unit", bedrooms=2, bathrooms=2, car_spaces=1,
                      lat=-33.906, lng=151.209, date_text="2026-05-05", gnaf="Y3")
        self.assertAlmostEqual(model.estimate(**kwargs).fair_rent, clone.estimate(**kwargs).fair_rent, places=6)
        self.assertEqual(model.fingerprint(), clone.fingerprint())


# ---------------------------------------------------------------------------
class ValueRankerTest(unittest.TestCase):
    def test_cheaper_than_fair_wins(self):
        ranker = ValueRanker(SNAP)
        a = est("A", 800, 900, 5, 300)   # 比同类便宜 11%
        b = est("B", 700, 650, 5, 300)   # 绝对更便宜，但比同类贵 8%
        self.assertEqual(ranker.rank(UserState(), [b, a], SNAP)[0], "A")

    def test_groceries_emphasis_changes_order(self):
        ranker = ValueRanker(SNAP)
        a = est("A", 850, 900, 12, 300)   # 便宜 5.6%，超市 12 分钟
        b = est("B", 900, 900, 3, 300)    # 平价，超市 3 分钟
        self.assertEqual(ranker.rank(UserState(soft_preferences={"emphasis": "value"}), [a, b], SNAP)[0], "A")
        self.assertEqual(ranker.rank(UserState(soft_preferences={"emphasis": "groceries"}), [a, b], SNAP)[0], "B")

    def test_discount_is_capped(self):
        ranker = ValueRanker(SNAP)
        junk = est("J", 50, 820, 6, 300)      # -94%，按 -40% 计
        good = est("G", 480, 820, 1, 300)     # -41%，同样封顶，但超市更近
        self.assertEqual(ranker.rank(UserState(), [junk, good], SNAP)[0], "G")

    def test_missing_fair_rent_sinks_and_ties_are_deterministic(self):
        ranker = ValueRanker(SNAP)
        missing = Listing("M", station_walk_m=100, weekly_rent=500, supermarket_walk_min=1, source="real")
        x, y = est("Y", 900, 900, 5, 300), est("X", 900, 900, 5, 300)
        self.assertEqual(ranker.rank(UserState(), [missing, x, y], SNAP), ["X", "Y", "M"])

    def test_snapshot_mismatch_raises(self):
        from world_model import RankingContractError
        with self.assertRaises(RankingContractError):
            ValueRanker(SNAP).rank(UserState(), [], "other")


# ---------------------------------------------------------------------------
class AdaptiveQuestionTest(unittest.TestCase):
    def pool(self):
        # A 最划算但离车站约 900 米；B 次之、离车站 350 米
        return [est("A", 760, 900, 4, 900, 800, 1100), est("B", 840, 900, 4, 350, 310, 430),
                est("C", 900, 900, 4, 200, 180, 260)]

    def test_thresholds_bracket_the_anchor_band(self):
        aq = build_adaptive_question(UserState(), self.pool(), ValueRanker(SNAP), SNAP)
        self.assertEqual(aq.meta["anchor_listing_id"], "A")
        self.assertEqual((aq.meta["t_cut"], aq.meta["t_keep"]), (600.0, 1200.0))  # 800 落在误差带内，被跳过
        self.assertEqual([o.id for o in aq.options], ["le_600", "le_1200", "no_limit", "skip"])

    def test_adaptive_plan_asks_with_pool_specific_options(self):
        plan = plan_next_step(request(self.pool()), ValueRanker(SNAP), adaptive=True)
        self.assertEqual((plan.action, plan.reason_code), ("ask", "different_top_choice"))
        self.assertEqual(plan.diagnostics["branch_tops_by_scenario"],
                         {"station-le-600": "B", "station-le-1200": "A", "station-no-limit": "A"})
        self.assertIn("约 900 米", plan.question_text)
        self.assertTrue(plan.diagnostics["decision_robust"])

    def test_close_anchor_means_no_question(self):
        pool = [est("A", 760, 900, 4, 250, 230, 330), est("B", 840, 900, 4, 900, 800, 1100)]
        plan = plan_next_step(request(pool), ValueRanker(SNAP), adaptive=True)
        self.assertEqual((plan.action, plan.reason_code), ("recommend", "all_branches_agree"))

    def test_service_round_trip_with_adaptive_option(self):
        pool = self.pool()
        svc = OrchestrationService(store=ProfileStore(UserState(soft_preferences={"emphasis": "value"})),
                                   ranker=ValueRanker(SNAP),
                                   candidate_provider=lambda search_id: ("cands-1", tuple(pool)),
                                   adaptive_questions=True)
        plan = svc.request_plan("search-x")
        self.assertTrue(plan.is_ask)
        result = svc.submit_answer(question_id=plan.question_id, event_id="e1", option_id="le_600")
        self.assertEqual(result["resolution"]["status"], "applied")
        self.assertEqual(svc.store.snapshot()[1].station_walk.max_m, 600.0)
        self.assertEqual(result["recommendation"]["top_listing_id"], "B")
        self.assertEqual(result["branch_consistency"],
                         {"matched_scenario": "station-le-600", "simulated_top": "B", "real_top": "B",
                          "consistent": True})

    def test_standard_option_id_not_shown_is_rejected(self):
        pool = self.pool()
        svc = OrchestrationService(store=ProfileStore(UserState()), ranker=ValueRanker(SNAP),
                                   candidate_provider=lambda search_id: ("cands-1", tuple(pool)),
                                   adaptive_questions=True)
        plan = svc.request_plan("search-x")
        result = svc.submit_answer(question_id=plan.question_id, event_id="e1", option_id="le_400")
        self.assertEqual(result["resolution"]["status"], "invalid_answer")

    def test_three_tier_pool_produces_three_distinct_branch_tops(self):
        """当候选池存在远/中/近三个性价比梯队时，自适应问句生成三档不同首选 (C, B, A)，不再退化为二选一。"""
        pool = [
            est("A", 720, 900, 4, 1200, 1050, 1400),
            est("B", 780, 900, 4, 650, 580, 750),
            est("C", 840, 900, 4, 300, 260, 360),
        ]
        aq = build_adaptive_question(UserState(), pool, ValueRanker(SNAP), SNAP)
        self.assertEqual((aq.meta["t_tight"], aq.meta["t_cut"]), (500.0, 1000.0))
        plan = plan_next_step(request(pool), ValueRanker(SNAP), adaptive=True)
        self.assertEqual(plan.action, "ask")
        self.assertEqual(plan.diagnostics["branch_tops_by_scenario"],
                         {"station-le-500": "C", "station-le-1000": "B", "station-no-limit": "A"})
        self.assertAlmostEqual(plan.divergence, 2.0 / 3.0)


# ---------------------------------------------------------------------------
class LowRegretTest(unittest.TestCase):
    def pool(self, b_rent):
        return [est("A", 800, 900, 4, 900, 850, 1000), est("B", b_rent, 900, 4, 300, 280, 350)]

    def test_near_tie_is_recommended_without_asking(self):
        # A 价格分 -11.1×2，B 用 815 → -9.4×2：差 3.3 分 ≤ 5
        plan = plan_next_step(request(self.pool(815)), ValueRanker(SNAP), regret_tolerance=5)
        self.assertEqual((plan.action, plan.reason_code), ("recommend", "low_regret_choice"))
        self.assertEqual(plan.diagnostics["low_regret"]["listing_id"], "B")

    def test_real_trade_off_still_asks(self):
        plan = plan_next_step(request(self.pool(880)), ValueRanker(SNAP), regret_tolerance=5)
        self.assertEqual((plan.action, plan.reason_code), ("ask", "different_top_choice"))

    def test_off_by_default(self):
        plan = plan_next_step(request(self.pool(815)), ValueRanker(SNAP))
        self.assertEqual(plan.action, "ask")

    def test_no_match_branch_disables_low_regret(self):
        pool = [est("A", 800, 900, 4, 900, 850, 1000)]
        plan = plan_next_step(request(pool), ValueRanker(SNAP), regret_tolerance=100)
        self.assertEqual(plan.action, "ask")


# ---------------------------------------------------------------------------
class EstimateRobustnessTest(unittest.TestCase):
    def test_decision_flipped_by_estimate_error_needs_data(self):
        # A 点估计 390 米（400 内），误差带 350–470：悲观视图下 400 分支会换首选
        pool = [est("A", 760, 900, 4, 390, 350, 470), est("B", 840, 900, 4, 200, 180, 240)]
        plan = plan_next_step(request(pool), ValueRanker(SNAP))
        self.assertEqual((plan.action, plan.reason_code), ("needs_data", "walk_estimate_ambiguous"))
        self.assertEqual(plan.diagnostics["boundary_listing_ids"], ["A"])
        self.assertFalse(plan.diagnostics["decision_robust"])

    def test_same_listing_measured_exactly_is_decided(self):
        pool = [est("A", 760, 900, 4, 390), est("B", 840, 900, 4, 200)]
        plan = plan_next_step(request(pool), ValueRanker(SNAP))
        self.assertEqual((plan.action, plan.reason_code), ("recommend", "all_branches_agree"))
        self.assertNotIn("decision_robust", plan.diagnostics)

    def test_boundary_listing_that_does_not_flip_decision_is_only_reported(self):
        # C 跨 400 米边界但永远不是首选：结论稳健，照常推荐
        pool = [est("A", 700, 900, 4, 200, 180, 240), est("C", 900, 900, 9, 390, 350, 470)]
        plan = plan_next_step(request(pool), ValueRanker(SNAP))
        self.assertEqual(plan.action, "recommend")
        self.assertTrue(plan.diagnostics["decision_robust"])
        self.assertEqual(plan.diagnostics["boundary_listing_ids"], ["C"])

    def test_estimated_distance_without_band_is_rejected(self):
        bare = Listing("A", station_walk_m=300, distance_kind="walking_estimated", weekly_rent=800, source="real")
        self.assertEqual(data_problems([bare]), ["missing_walk_band:A"])
        plan = plan_next_step(request([bare]), ValueRanker(SNAP))
        self.assertEqual((plan.action, plan.reason_code), ("needs_data", "data_missing"))

    def test_robust_check_does_not_mutate_candidates(self):
        pool = (est("A", 760, 900, 4, 390, 350, 470), est("B", 840, 900, 4, 200, 180, 240))
        before = [item.to_dict() for item in pool]
        plan_next_step(request(pool), ValueRanker(SNAP))
        self.assertEqual(before, [item.to_dict() for item in pool])


# ---------------------------------------------------------------------------
class MicroburbsAdapterTest(unittest.TestCase):
    ROW = {"gnaf_pid": "GANSW710313346", "address": {"street": "Unit 105, 82-92 Cooper Street", "sal": "Surry Hills"},
           "attributes": {"bedrooms": 1.0, "bathrooms": 1.0, "garage_spaces": 1},
           "coordinates": {"latitude": -33.8861158, "longitude": 151.2112161},
           "listing_date": "2026-10-30", "price": 900.0, "property_type": "Unit"}
    TRANSPORT = {"nearest": {"train": {"name": "Central", "distance_m": 400}, "bus": {"distance_m": 90}}}
    AMENITIES = {"results": [{"name": "Cafe", "category": "Restaurant", "distance_m": 20},
                             {"name": "Big Shop", "category": "Supermarket", "distance_m": 300},
                             {"name": "Small Shop", "category": "Supermarket", "distance_m": 160}]}

    def test_walk_estimate_band(self):
        self.assertEqual(estimate_walk_m(400), (520.0, 460.0, 650.0))
        self.assertEqual(estimate_walk_m(None), (None, None, None))
        self.assertEqual(estimate_walk_m(-5), (None, None, None))

    def test_listing_conversion(self):
        enrichment = enrichment_from_responses(self.TRANSPORT, self.AMENITIES)
        listing = listing_from_microburbs(self.ROW, enrichment)
        self.assertEqual(listing.listing_id, "GANSW710313346")
        self.assertEqual(listing.district, "Surry Hills")
        self.assertEqual((listing.station_walk_m, listing.walk_band()), (520.0, (460.0, 650.0)))
        self.assertEqual(listing.supermarket_walk_min, 2.6)          # 160 m × 1.3 / 80
        self.assertEqual(listing.extra["supermarket_name"], "Small Shop")
        self.assertEqual(listing.extra["car_spaces"], 1)
        self.assertEqual(data_problems([listing]), [])

    def test_missing_station_stays_missing(self):
        listing = listing_from_microburbs(self.ROW, enrichment_from_responses({"nearest": {}}, {}))
        self.assertIsNone(listing.station_walk_m)
        self.assertIsNone(listing.supermarket_walk_min)
        self.assertEqual(data_problems([listing]), ["missing_station_walk:GANSW710313346"])

    def test_candidate_pool_caps_and_skips_missing_distance(self):
        listings = [est(f"L{i:02d}", 700 + i, 900, 4, 300) for i in range(30)]
        listings.append(Listing("NO-DIST", weekly_rent=500, source="real", extra={"fair_rent": 900}))
        pool = build_candidate_pool(UserState(budget_weekly_max=720), listings, ValueRanker(SNAP))
        self.assertEqual(len(pool), 20)
        self.assertNotIn("NO-DIST", [item.listing_id for item in pool])
        self.assertEqual(pool[0].listing_id, "L00")

    def test_price_flags(self):
        from world_model.microburbs import price_flag
        self.assertEqual(price_flag(50, 820, 1, "Unit"), "implausibly_low_vs_fair_rent")   # 车位广告
        self.assertEqual(price_flag(600, 1400, 12, "Unit"), "likely_boarding_house")
        self.assertEqual(price_flag(12000, 2500, 3, "Unit"), "implausibly_high_vs_fair_rent")
        self.assertIsNone(price_flag(760, 820, 1, "Unit"))
        self.assertIsNone(price_flag(1500, 900, 8, "House"))  # 大独立屋不算寄宿屋

    def test_flagged_listing_is_kept_out_of_pool(self):
        parking = Listing("PARK", station_walk_m=100, distance_kind="walking_estimated", weekly_rent=50,
                          supermarket_walk_min=1, source="real",
                          extra={"fair_rent": 820, WALK_LOW_KEY: 90, WALK_HIGH_KEY: 160,
                                 "price_flag": "implausibly_low_vs_fair_rent"})
        pool = build_candidate_pool(UserState(), [parking, est("A", 760, 820, 4, 300)], ValueRanker(SNAP))
        self.assertEqual([item.listing_id for item in pool], ["A"])

    def test_supermarket_map_finds_nearest_by_coordinates(self):
        from world_model.microburbs import nearest_supermarket
        markets = [{"name": "Far", "lat": -33.8900, "lng": 151.2112}, {"name": "Near", "lat": -33.8870, "lng": 151.2112}]
        found = nearest_supermarket(-33.8861, 151.2112, markets)
        self.assertEqual(found["name"], "Near")
        self.assertTrue(95 <= found["distance_m"] <= 105, found)
        enrichment = enrichment_from_responses(self.TRANSPORT, self.AMENITIES, supermarkets=markets,
                                               lat=-33.8861, lng=151.2112)
        self.assertEqual(enrichment["supermarket"]["name"], "Near")   # 地图优先于 amenities 列表

    def test_client_requires_key(self):
        previous = os.environ.pop("MICROBURBS_API_KEY", None)
        try:
            with self.assertRaises(MicroburbsError):
                MicroburbsClient()
        finally:
            if previous is not None:
                os.environ["MICROBURBS_API_KEY"] = previous

    def test_rent_history_rejects_non_positive_page_and_handles_missing_meta_total(self):
        client = MicroburbsClient(api_key="dummy-key")
        with self.assertRaises(MicroburbsError):
            list(client.rent_history("Surry Hills", "2025-01-01", page=0))

        pages = [
            {"results": [{"id": 1}, {"id": 2}]},  # meta.total 缺失，不应在第一页被当成 total=0 截断
            {"results": [{"id": 3}]},
        ]
        calls = []

        def fake_get(path, **params):
            calls.append(params)
            return pages[len(calls) - 1]

        client.get = fake_get  # type: ignore[method-assign]
        rows = list(client.rent_history("Surry Hills", "2025-01-01", page=2))
        self.assertEqual([r["id"] for r in rows], [1, 2, 3])
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
