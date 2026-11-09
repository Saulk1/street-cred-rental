"""v0.3：需求抽取、房源特征、硬筛选新规则、多问题规划、推荐集合、反馈、顾问多轮流程。"""

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from world_model import Listing, StationWalkRequirement, UserState, matches_hard_requirements  # noqa: E402
from world_model.advisor import RentalAdvisor  # noqa: E402
from world_model.microburbs import listing_features  # noqa: E402
from world_model.needs import apply_state_patch, extract_needs, validate_patch  # noqa: E402
from world_model.questions import (  # noqa: E402
    DEFAULT_PRIORS,
    INFEASIBLE_COST,
    QuestionSpec,
    QuestionValue,
    _robust_station_value,
    apply_feedback,
    build_question_bank,
    followup_prompt,
    plan_multi,
    question_value,
    recommend_set,
)
from world_model.types import WALK_HIGH_KEY, WALK_LOW_KEY  # noqa: E402
from world_model.value_ranker import UNKNOWN_NEED_PENALTY, ValueRanker  # noqa: E402

SNAP = "value-ranker-test"
SUBURBS = ("Redfern", "Waterloo (NSW)", "Ultimo")


def home(listing_id, rent=600, fair=700, market=5, walk=300, low=None, high=None, beds=1, suburb="Ultimo",
         features=None, lat=None, lng=None):
    extra = {"fair_rent": fair, "features": dict(features or {}), "lat": lat, "lng": lng,
             "address": f"{listing_id} Test St",
             WALK_LOW_KEY: walk if low is None else low, WALK_HIGH_KEY: walk if high is None else high}
    return Listing(listing_id=listing_id, station_walk_m=walk, distance_kind="walking_estimated", weekly_rent=rent,
                   bedrooms=beds, district=suburb, supermarket_walk_min=market, source="real", extra=extra)


def ranker():
    return ValueRanker(SNAP)


def state(**kwargs):
    kwargs.setdefault("budget_weekly_max", 800)
    kwargs.setdefault("bedrooms", 1)
    return UserState(**kwargs)


def spec_of(key, st, pool):
    return next(item for item in build_question_bank(st, pool, ranker(), SNAP) if item.key == key)


def pets_pool():
    """A 便宜但明确不许养宠物；B 贵一些但允许。只有宠物问题值得问（0.15 × 25 = 3.75 分）。"""
    return [home("A", rent=550, features={"pets": False}), home("B", rent=650, features={"pets": True})]


def two_question_pool():
    """A 宠物、家具都明确不满足；B 都满足。家具 5 分 > 宠物 3.75 分。"""
    return [home("A", rent=550, features={"pets": False, "furnished": False}),
            home("B", rent=650, features={"pets": True, "furnished": True})]


# ---------------------------------------------------------------------------
class ExtractNeedsTest(unittest.TestCase):
    def needs(self, text):
        return extract_needs(text).patch.get("needs", {})

    def test_full_sentence(self):
        patch = extract_needs("我在UTS上课，想找一室，预算800一周，养了一只猫").patch
        self.assertEqual(patch, {"needs": {"pets": True}, "commute_to": "UTS", "budget_weekly_max": 800.0,
                                 "bedrooms": 1})

    def test_negated_needs_are_false_not_true(self):
        cases = {"pets": ("没有宠物", "不养猫", "不带宠物", "no pets", "without pets", "I don't have a dog"),
                 "furnished": ("不需要家具", "不要家具", "家具无所谓", "unfurnished", "I want unfurnished",
                               "not furnished please", "unfurnished is fine"),
                 "parking": ("不需要车位", "不需要停车", "没车", "我不开车", "no car", "no parking needed",
                             "don't need parking")}
        for key, texts in cases.items():
            for text in texts:
                with self.subTest(text=text):
                    self.assertIs(self.needs(text).get(key), False)

    def test_positive_needs(self):
        cases = {"pets": ("有一只狗", "带着猫", "my cat", "pets"), "furnished": ("要带家具", "拎包入住", "furnished"),
                 "parking": ("需要车位", "有车", "need parking", "car space")}
        for key, texts in cases.items():
            for text in texts:
                with self.subTest(text=text):
                    self.assertIs(self.needs(text).get(key), True)

    def test_mixed_chinese_english_boundaries(self):
        patch = extract_needs("想要2bed，budget 900一周，有cat，在UNSW读书").patch
        self.assertEqual(patch["bedrooms"], 2)
        self.assertEqual(patch["budget_weekly_max"], 900.0)
        self.assertEqual(patch["commute_to"], "UNSW")
        self.assertIs(patch["needs"]["pets"], True)

    def test_bedroom_words_hyphens_and_existing_formats(self):
        for text, beds in (("one-bedroom", 1), ("one bedroom", 1), ("1 bedroom", 1),
                           ("two-bed", 2), ("Three-Bedroom", 3), ("four‑bedroom", 4),
                           ("2-bed", 2), ("一室", 1), ("两卧", 2), ("studio", 0)):
            with self.subTest(text=text):
                self.assertEqual(extract_needs(f"Find a {text} rental under $800 near UTS").patch["bedrooms"], beds)

    def test_latin_words_inside_other_words_do_not_match(self):
        self.assertEqual(extract_needs("love hotdogs and outsiders, scattered thoughts").patch, {})

    def test_distance_is_not_a_budget(self):
        for text in ("离车站最多800米", "不超过500米到车站", "within 800m of the station", "最多 1.5 公里到地铁"):
            with self.subTest(text=text):
                patch = extract_needs(text).patch
                self.assertNotIn("budget_weekly_max", patch)
                self.assertEqual(patch["station_walk"]["status"], "confirmed")

    def test_budget_and_distance_in_one_sentence(self):
        patch = extract_needs("离车站最多800米，预算700一周").patch
        self.assertEqual(patch["budget_weekly_max"], 700.0)
        self.assertEqual(patch["station_walk"]["max_m"], 800.0)

    def test_budget_formats(self):
        for text, value in (("budget $1,200 per week", 1200.0), ("under 700", 700.0), ("$650/week", 650.0)):
            with self.subTest(text=text):
                self.assertEqual(extract_needs(text).patch.get("budget_weekly_max"), value)

    def test_studio_and_districts(self):
        patch = extract_needs("studio，想住Redfern，不想住Waterloo", suburbs=SUBURBS).patch
        self.assertEqual(patch["bedrooms"], 0)
        self.assertEqual(patch["districts"], ["Redfern"])
        self.assertEqual(patch["excluded_districts"], ["Waterloo (NSW)"])

    def test_vague_text_extracts_nothing(self):
        self.assertEqual(extract_needs("随便看看，方便就行").patch, {})


class LlmHookTest(unittest.TestCase):
    def run_llm(self, payload, text="预算800一周"):
        return extract_needs(text, llm=lambda prompt: payload)

    def test_valid_output_overrides_rules_and_merges_needs(self):
        result = self.run_llm(json.dumps({"budget_weekly_max": 900, "needs": {"furnished": True}}), "预算800，养猫")
        self.assertEqual(result.source, "rules+llm")
        self.assertEqual(result.patch["budget_weekly_max"], 900.0)
        self.assertEqual(result.patch["needs"], {"pets": True, "furnished": True})

    def test_dict_output_is_accepted(self):
        self.assertEqual(self.run_llm({"bedrooms": 2}).patch["bedrooms"], 2)

    def test_illegal_fields_are_dropped(self):
        result = self.run_llm({"hack": 1, "commute_to": "Mars", "bedrooms": "两室", "budget_stretch_pct": 99,
                               "needs": {"pets": "yes", "pool": True}})
        self.assertEqual(result.patch, {"budget_weekly_max": 800.0})
        self.assertEqual(result.dropped, ("bedrooms", "budget_stretch_pct", "commute_to", "hack", "needs"))

    def test_bad_station_walk_is_dropped_not_raised(self):
        for bad in ({"status": "bogus"}, "near", {"status": "confirmed", "max_m": -5}):
            with self.subTest(bad=bad):
                result = self.run_llm({"station_walk": bad})
                self.assertNotIn("station_walk", result.patch)
                self.assertIn("station_walk", result.dropped)

    def test_booleans_are_not_numbers(self):
        result = self.run_llm({"budget_stretch_pct": True})
        self.assertNotIn("budget_stretch_pct", result.patch)

    def test_llm_cannot_write_learned_weights(self):
        result = self.run_llm({"weight_adjust": {"value": 4}})
        self.assertNotIn("weight_adjust", result.patch)
        self.assertIn("weight_adjust", result.dropped)

    def test_failure_falls_back_to_rules(self):
        def boom(prompt):
            raise RuntimeError("timeout")
        for llm in (boom, lambda prompt: "not json", lambda prompt: "[1, 2]"):
            result = extract_needs("预算800一周", llm=llm)
            self.assertEqual(result.source, "rules")
            self.assertEqual(result.patch, {"budget_weekly_max": 800.0})

    def test_prompt_contains_user_text(self):
        seen = []
        extract_needs("想住 Ultimo", llm=lambda prompt: seen.append(prompt) or "{}")
        self.assertIn("想住 Ultimo", seen[0])


class PatchTest(unittest.TestCase):
    def test_patch_returns_a_copy_and_merges(self):
        before = state(other_confirmed={"needs": {"pets": True}, "excluded_districts": ["Ultimo"]})
        after = apply_state_patch(before, {"needs": {"furnished": True}, "excluded_districts": ["Redfern", "Ultimo"]})
        self.assertEqual(after.other_confirmed["needs"], {"pets": True, "furnished": True})
        self.assertEqual(after.other_confirmed["excluded_districts"], ["Ultimo", "Redfern"])
        self.assertEqual(before.other_confirmed["needs"], {"pets": True})

    def test_weight_factor_is_clamped(self):
        self.assertEqual(validate_patch({"weight_adjust": {"value": 100, "groceries": 0.001}})["weight_adjust"],
                         {"value": 4.0, "groceries": 0.25})


# ---------------------------------------------------------------------------
class ListingFeaturesTest(unittest.TestCase):
    def test_false_positives_stay_unknown(self):
        self.assertIsNone(listing_features("Walk to pet-friendly parks nearby")["pets"])
        self.assertIsNone(listing_features("Pet-friendly park at your door")["pets"])
        self.assertIsNone(listing_features("Photos are virtually furnished")["furnished"])
        self.assertIsNone(listing_features("Virtually staged, furnished for illustration")["furnished"])

    def test_virtual_staging_does_not_hide_a_real_statement(self):
        self.assertIs(listing_features("Virtually furnished photos. Property is unfurnished.")["furnished"], False)

    def test_explicit_statements(self):
        self.assertIs(listing_features("Pets considered on application")["pets"], True)
        self.assertIs(listing_features("Sorry, no pets")["pets"], False)
        self.assertIs(listing_features("Fully furnished apartment")["furnished"], True)
        self.assertIs(listing_features("Unfurnished two bedder")["furnished"], False)

    def test_no_pets_beats_a_pet_friendly_mention(self):
        self.assertIs(listing_features("Pet-friendly building but no pets in this unit")["pets"], False)

    def test_missing_is_none_never_false(self):
        features = listing_features(None)
        self.assertFalse(features["has_description"])
        for key in ("pets", "furnished", "parking", "aircon", "dishwasher", "internal_laundry", "balcony", "gym"):
            self.assertIsNone(features[key], key)

    def test_amenities_never_false(self):
        features = listing_features("Bright unit with dishwasher and balcony")
        self.assertIs(features["dishwasher"], True)
        self.assertIs(features["balcony"], True)
        self.assertIsNone(features["gym"])

    def test_parking_comes_from_garage_spaces(self):
        self.assertIs(listing_features("x", car_spaces=1)["parking"], True)
        self.assertIs(listing_features("x", car_spaces=0)["parking"], False)
        self.assertIsNone(listing_features("x", car_spaces=None)["parking"])


class HardFilterTest(unittest.TestCase):
    def test_budget_stretch(self):
        listing = home("A", rent=860)
        self.assertFalse(matches_hard_requirements(state(), listing))
        self.assertTrue(matches_hard_requirements(state(other_confirmed={"budget_stretch_pct": 10.0}), listing))
        self.assertFalse(matches_hard_requirements(state(other_confirmed={"budget_stretch_pct": 5.0}), listing))

    def test_excluded_district(self):
        st = state(other_confirmed={"excluded_districts": ["Ultimo"]})
        self.assertFalse(matches_hard_requirements(st, home("A", suburb="Ultimo")))
        self.assertTrue(matches_hard_requirements(st, home("B", suburb="Redfern")))

    def test_needs_only_exclude_explicit_false(self):
        st = state(other_confirmed={"needs": {"pets": True, "parking": True}})
        self.assertFalse(matches_hard_requirements(st, home("A", features={"pets": False})))
        self.assertFalse(matches_hard_requirements(st, home("B", features={"parking": False})))
        self.assertTrue(matches_hard_requirements(st, home("C", features={"pets": None})))
        self.assertTrue(matches_hard_requirements(st, home("D", features={"pets": True, "parking": True})))

    def test_not_needing_something_excludes_nothing(self):
        st = state(other_confirmed={"needs": {"furnished": False}})
        self.assertTrue(matches_hard_requirements(st, home("A", features={"furnished": True})))
        self.assertTrue(matches_hard_requirements(st, home("B", features={"furnished": False})))


class RankerExtensionsTest(unittest.TestCase):
    def test_new_terms_are_zero_by_default(self):
        parts = ranker().score_breakdown(state(), home("A"))
        self.assertEqual((parts["station"], parts["commute"], parts["unknown_needs"]), (0.0, 0.0, 0.0))

    def test_unknown_need_costs_points_but_known_does_not(self):
        st = state(other_confirmed={"needs": {"pets": True}})
        self.assertEqual(ranker().score_breakdown(st, home("A"))["unknown_needs"], UNKNOWN_NEED_PENALTY)
        self.assertEqual(ranker().score_breakdown(st, home("B", features={"pets": True}))["unknown_needs"], 0.0)

    def test_commute_prefers_the_closer_listing(self):
        st = state(soft_preferences={"commute_to": "UTS"})
        near = home("A", lat=-33.8832, lng=151.2005)
        far = home("B", lat=-33.9173, lng=151.2313)
        self.assertEqual(ranker().rank(st, [far, near], SNAP), ["A", "B"])

    def test_missing_coordinates_are_not_treated_as_closest(self):
        st = state(soft_preferences={"commute_to": "UTS"})
        self.assertEqual(ranker().score_breakdown(st, home("A"))["commute_km"], 5.0)

    def test_station_weight_starts_from_feedback(self):
        st = state(soft_preferences={"weight_adjust": {"station": 2.0}})
        self.assertGreater(ranker().score_breakdown(st, home("A", walk=500))["station"], 0.0)


# ---------------------------------------------------------------------------
class QuestionValueTest(unittest.TestCase):
    def test_infeasible_branch_costs_infeasible_cost(self):
        st, pool = state(), pets_pool()
        value = question_value(spec_of("needs.pets", st, pool), st, pool, ranker(), SNAP, "A")
        rows = {row["branch"]: row for row in value.branches}
        self.assertEqual(rows["yes"]["regret"], INFEASIBLE_COST)
        self.assertEqual(rows["yes"]["top"], "B")
        self.assertEqual(rows["no"]["regret"], 0.0)
        self.assertAlmostEqual(value.value, DEFAULT_PRIORS["needs.pets"]["yes"] * INFEASIBLE_COST)

    def test_branch_with_nothing_feasible_is_still_infeasible_cost(self):
        st, pool = state(), [home("A", features={"pets": False})]
        value = question_value(spec_of("needs.pets", st, pool), st, pool, ranker(), SNAP, "A")
        rows = {row["branch"]: row for row in value.branches}
        self.assertEqual(rows["yes"]["regret"], INFEASIBLE_COST)
        self.assertIsNone(rows["yes"]["top"])
        self.assertEqual(rows["yes"]["feasible"], 0)

    def test_regret_is_score_gap_when_default_stays_feasible(self):
        """UTS 分支下 near 反超：遗憾 = 默认房源与该分支最优的分差。"""
        st = state()
        default = home("A", rent=590, lat=-33.9173, lng=151.2313)
        near = home("B", rent=600, lat=-33.8832, lng=151.2005)
        pool = [default, near]
        value = question_value(spec_of("commute_to", st, pool), st, pool, ranker(), SNAP, "A")
        rows = {row["branch"]: row for row in value.branches}
        branch = apply_state_patch(st, {"commute_to": "UTS"})
        expected = ranker().score(branch, default) - ranker().score(branch, near)
        self.assertGreater(expected, 0)
        self.assertAlmostEqual(rows["UTS"]["regret"], expected, places=2)
        self.assertEqual(rows["none"]["regret"], 0.0)

    def test_priors_change_the_value(self):
        st, pool = state(), pets_pool()
        spec = next(item for item in build_question_bank(st, pool, ranker(), SNAP,
                                                         priors={"needs.pets": {"yes": 0.5, "no": 0.5}})
                    if item.key == "needs.pets")
        self.assertAlmostEqual(question_value(spec, st, pool, ranker(), SNAP, "A").value, 12.5)

    def test_simulating_branches_does_not_touch_the_real_state(self):
        st, pool = state(), pets_pool()
        before = st.fingerprint()
        plan_multi(st, pool, ranker(), SNAP)
        self.assertEqual(st.fingerprint(), before)

    def test_robust_station_value_takes_the_minimum_across_the_band(self):
        st = state()
        pool = [home("A", rent=500, walk=1100, low=900, high=1300), home("B", rent=640, walk=300)]
        value = _robust_station_value(spec_of("station_walk_max_m", st, pool), st, pool, ranker(), SNAP, "A")
        views = value.branches[-1]["views"]
        self.assertEqual(len(views), 3)
        self.assertAlmostEqual(round(value.value, 2), min(views))
        self.assertGreater(value.value, 0.0)


class QuestionBankTest(unittest.TestCase):
    def test_known_fields_are_not_asked(self):
        st = state(other_confirmed={"needs": {"pets": False}, "budget_stretch_pct": 0.0},
                   soft_preferences={"commute_to": "none"},
                   station_walk=StationWalkRequirement(status="confirmed", max_m=800.0))
        keys = {item.key for item in build_question_bank(st, pets_pool(), ranker(), SNAP)}
        self.assertEqual(keys, {"needs.furnished", "needs.parking"})

    def test_budget_question_needs_a_budget(self):
        keys = {item.key for item in build_question_bank(UserState(), pets_pool(), ranker(), SNAP)}
        self.assertNotIn("budget_stretch", keys)


class PlanMultiTest(unittest.TestCase):
    def test_asks_the_most_valuable_question(self):
        plan = plan_multi(state(), two_question_pool(), ranker(), SNAP)
        self.assertEqual((plan.action, plan.reason_code), ("ask", "highest_expected_regret"))
        self.assertEqual(plan.question.key, "needs.furnished")
        self.assertEqual(plan.default_listing_id, "A")

    def test_below_threshold_recommends(self):
        plan = plan_multi(state(), pets_pool(), ranker(), SNAP, ask_threshold=4.0)
        self.assertEqual((plan.action, plan.reason_code), ("recommend", "no_question_worth_asking"))
        self.assertTrue(plan.recommendations)
        self.assertTrue(plan.followup)

    def test_value_equal_to_threshold_asks(self):
        plan = plan_multi(state(), pets_pool(), ranker(), SNAP, ask_threshold=3.75)
        self.assertEqual(plan.action, "ask")

    def test_question_budget(self):
        plan = plan_multi(state(), two_question_pool(), ranker(), SNAP, asked_keys=("commute_to", "budget_stretch"))
        self.assertEqual((plan.action, plan.reason_code), ("recommend", "question_budget_spent"))

    def test_asked_question_is_not_asked_again(self):
        plan = plan_multi(state(), two_question_pool(), ranker(), SNAP, asked_keys=("needs.furnished",))
        self.assertEqual(plan.question.key, "needs.pets")
        self.assertNotIn("needs.furnished", [item.key for item in plan.values])

    def test_no_feasible_listing(self):
        plan = plan_multi(state(budget_weekly_max=100), pets_pool(), ranker(), SNAP)
        self.assertEqual((plan.action, plan.reason_code), ("no_match", "no_feasible_listing"))


class RecommendSetTest(unittest.TestCase):
    def test_three_differentiated_roles(self):
        pool = [home("A", rent=600, market=1, walk=500), home("B", rent=540, market=12, walk=600),
                home("C", rent=620, market=3, walk=100)]
        picks = recommend_set(state(), pool, ranker(), SNAP)
        self.assertEqual([(item["role"], item["listing_id"]) for item in picks],
                         [("best", "A"), ("cheapest", "B"), ("closest_station", "C")])
        self.assertEqual(picks[0]["score_gap"], 0.0)

    def test_role_collisions_are_deduplicated_and_backfilled(self):
        pool = [home("A", rent=500, market=1, walk=100), home("B", rent=600), home("C", rent=650)]
        picks = recommend_set(state(), pool, ranker(), SNAP)
        ids = [item["listing_id"] for item in picks]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(ids, ["A", "B", "C"])
        self.assertEqual([item["role"] for item in picks], ["best", "alternative", "alternative"])

    def test_fewer_listings_than_k(self):
        self.assertEqual(len(recommend_set(state(), [home("A")], ranker(), SNAP)), 1)
        self.assertEqual(recommend_set(state(budget_weekly_max=100), [home("A")], ranker(), SNAP), ())

    def test_alternatives_must_be_within_slack(self):
        pool = [home("A", rent=600, market=1), home("B", rent=300, market=60), home("C", rent=610, market=2)]
        cheapest = [item for item in recommend_set(state(), pool, ranker(), SNAP) if item["role"] == "cheapest"]
        self.assertNotIn("B", [item["listing_id"] for item in cheapest])

    def test_unknown_need_is_called_out(self):
        st = state(other_confirmed={"needs": {"pets": True}})
        self.assertIn("宠物政策没写明", recommend_set(st, [home("A")], ranker(), SNAP)[0]["reason"])

    def test_suspicious_discount_gets_a_price_check(self):
        pool = [home("A", rent=600, fair=700, market=1), home("B", rent=385, fair=700, market=9)]
        picks = {item["listing_id"]: item for item in recommend_set(state(), pool, ranker(), SNAP)}
        self.assertTrue(picks["B"]["price_check"])
        self.assertIn("需核实", picks["B"]["reason"])
        self.assertFalse(picks["A"]["price_check"])
        self.assertNotIn("需核实", picks["A"]["reason"])

    def test_discount_at_the_cap_is_not_flagged(self):
        pick = recommend_set(state(), [home("A", rent=420, fair=700)], ranker(), SNAP)[0]
        self.assertFalse(pick["price_check"])


class FollowupTest(unittest.TestCase):
    def test_lists_highest_value_unknowns_first(self):
        values = [QuestionValue("needs.parking", 1.0, ()), QuestionValue("needs.pets", 2.0, ()),
                  QuestionValue("commute_to", 3.0, ()), QuestionValue("budget_stretch", 0.5, ())]
        text = followup_prompt(values)
        self.assertLess(text.index("平时去哪里"), text.index("有没有宠物"))
        self.assertLess(text.index("有没有宠物"), text.index("需不需要车位"))
        self.assertNotIn("预算能不能", text)

    def test_nothing_unknown_is_still_an_open_question(self):
        self.assertIn("还有什么必须满足的条件", followup_prompt([]))


class FeedbackTest(unittest.TestCase):
    """固定倍数的启发式调权：不再是默认，保留作评估对照（learner="heuristic"）。"""

    def setUp(self):
        self.best = home("A", rent=650, market=1)
        self.cheap = home("B", rent=600, market=10, suburb="Redfern")
        self.listings = {"A": self.best, "B": self.cheap}
        self.shown = ({"listing_id": "A", "role": "best"}, {"listing_id": "B", "role": "cheapest"})

    def feedback(self, st=None, **kwargs):
        kwargs.setdefault("learner", "heuristic")
        return apply_feedback(st or state(), self.shown, self.listings, ranker(), **kwargs)

    def test_choosing_the_cheaper_one_raises_value_weight(self):
        patch, notes = self.feedback(chosen_id="B")
        self.assertEqual(patch, {"weight_adjust": {"value": 1.5}})
        self.assertIn("更便宜", notes[0])

    def test_choosing_the_best_changes_nothing(self):
        self.assertEqual(self.feedback(chosen_id="A"), ({}, []))

    def test_choosing_closer_to_station_raises_station_weight(self):
        self.listings["B"] = home("B", rent=650, market=1, walk=100)
        self.listings["A"] = home("A", rent=650, market=1, walk=400)
        patch, _notes = self.feedback(chosen_id="B")
        self.assertEqual(patch["weight_adjust"], {"station": 1.5})

    def test_disliking_the_area_excludes_it(self):
        patch, notes = self.feedback(rejected_ids=["B"], reasons=["不喜欢这个区"])
        self.assertEqual(patch, {"excluded_districts": ["Redfern"]})
        self.assertIn("Redfern", notes[0])

    def test_reason_tags(self):
        self.assertEqual(self.feedback(reasons=["太贵"])[0]["weight_adjust"], {"value": 1.5})
        self.assertEqual(self.feedback(reasons=["离车站远"])[0]["weight_adjust"], {"station": 2.0})

    def test_commute_complaint_without_destination_is_only_a_note(self):
        patch, notes = self.feedback(reasons=["通勤太麻烦"])
        self.assertEqual(patch, {})
        self.assertIn("还不知道目的地", notes[0])

    def test_feedback_compounds_on_existing_weights(self):
        st = state(soft_preferences={"weight_adjust": {"value": 1.5}})
        self.assertEqual(self.feedback(st, reasons=["太贵"])[0]["weight_adjust"]["value"], 2.25)

    def test_feedback_never_touches_hard_requirements(self):
        patch, _notes = self.feedback(chosen_id="B", rejected_ids=["A"], reasons=["太贵", "离车站远"])
        self.assertEqual(set(patch), {"weight_adjust"})


# ---------------------------------------------------------------------------
class AdvisorFlowTest(unittest.TestCase):
    def advisor(self, pool=None, **kwargs):
        kwargs.setdefault("initial_state", state())
        return RentalAdvisor(pets_pool() if pool is None else pool, ranker(), suburbs=SUBURBS, **kwargs)

    def test_unusable_listings_never_enter_the_pool(self):
        flagged = Listing(listing_id="X", station_walk_m=100, weekly_rent=60, bedrooms=1, source="real",
                          extra={"price_flag": "implausibly_low_vs_fair_rent"})
        no_distance = Listing(listing_id="Y", weekly_rent=500, bedrooms=1, source="real")
        self.assertEqual(set(self.advisor(pets_pool() + [flagged, no_distance]).by_id), {"A", "B"})

    def test_intake_writes_the_profile(self):
        advisor = RentalAdvisor(pets_pool(), ranker())
        result = advisor.intake("想找一室，预算800一周")
        self.assertEqual(advisor.state.budget_weekly_max, 800.0)
        self.assertEqual(advisor.state.bedrooms, 1)
        self.assertEqual(result["extracted"]["source"], "rules")

    def test_answer_filters_and_moves_on(self):
        advisor = self.advisor()
        step = advisor.next()
        self.assertEqual((step["action"], step["question_key"]), ("ask", "needs.pets"))
        self.assertEqual(step["expected_regret"], 3.75)
        result = advisor.answer(step["question_id"], option_id="yes")
        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["next"]["action"], "recommend")
        self.assertEqual([item["listing_id"] for item in result["next"]["recommendations"]], ["B"])

    def test_next_restores_the_same_pending_question(self):
        advisor = self.advisor()
        first = advisor.next()
        second = advisor.next()
        self.assertEqual(first["question_id"], second["question_id"])
        self.assertEqual(second["reason_code"], "restored_pending")

    def test_event_id_is_idempotent(self):
        advisor = self.advisor()
        question_id = advisor.next()["question_id"]
        first = advisor.answer(question_id, option_id="yes", event_id="e1")
        version, asked = advisor.version, list(advisor.asked_keys)
        again = advisor.answer(question_id, option_id="no", event_id="e1")
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["patch"], first["patch"])
        self.assertEqual((advisor.version, advisor.asked_keys), (version, asked))
        self.assertTrue(advisor.state.other_confirmed["needs"]["pets"])

    def test_question_id_mismatch_changes_nothing(self):
        advisor = self.advisor()
        step = advisor.next()
        result = advisor.answer("q-999", option_id="yes")
        self.assertEqual((result["status"], result["reason_code"]), ("invalid_answer", "unknown_or_stale_question"))
        self.assertEqual(advisor.pending["question_id"], step["question_id"])
        self.assertEqual(advisor.asked_keys, [])

    def test_bad_answers_keep_the_question_open(self):
        advisor = self.advisor()
        question_id = advisor.next()["question_id"]
        self.assertEqual(advisor.answer(question_id, option_id="nope")["reason_code"], "unknown_option")
        self.assertEqual(advisor.answer(question_id)["reason_code"], "empty_answer")
        self.assertEqual(advisor.answer(question_id, text="你猜")["reason_code"], "unparsed_text")
        self.assertEqual(advisor.answer(question_id, text="有一只猫")["status"], "applied")

    def test_skip_counts_as_asked_but_writes_nothing(self):
        advisor = self.advisor()
        version = advisor.version
        result = advisor.answer(advisor.next()["question_id"], option_id="skip")
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(advisor.asked_keys, ["needs.pets"])
        self.assertEqual(advisor.version, version)
        self.assertEqual(result["next"]["action"], "recommend")

    def test_profile_change_invalidates_the_old_question(self):
        advisor = self.advisor()
        question_id = advisor.next()["question_id"]
        advisor.intake("预算700一周")
        result = advisor.answer(question_id, option_id="yes")
        self.assertEqual((result["status"], result["reason_code"]), ("stale_state", "profile_changed_since_question"))
        self.assertEqual(advisor.asked_keys, [])
        self.assertIsNone(advisor.pending)

    def test_next_does_not_show_a_question_from_an_old_profile(self):
        advisor = self.advisor(two_question_pool())
        first = advisor.next()
        result = advisor.feedback(reasons=["太贵"])
        self.assertNotEqual(result["next"].get("question_id"), first["question_id"])
        self.assertNotEqual(result["next"].get("reason_code"), "restored_pending")
        self.assertEqual(advisor.answer(result["next"]["question_id"], option_id="no")["status"], "applied")

    def test_tell_does_not_use_a_question_slot(self):
        advisor = self.advisor(max_questions=1)
        advisor.next()
        result = advisor.tell("我养了一只猫")
        self.assertEqual(advisor.asked_keys, [])
        self.assertIsNone(advisor.pending)
        self.assertIs(advisor.state.other_confirmed["needs"]["pets"], True)
        self.assertEqual(result["next"]["recommendations"][0]["listing_id"], "B")

    def test_tell_with_nothing_extracted_keeps_the_pending_question(self):
        advisor = self.advisor()
        question_id = advisor.next()["question_id"]
        result = advisor.tell("随便说说")
        self.assertEqual(result["next"]["question_id"], question_id)

    def test_question_cap_holds_across_the_conversation(self):
        advisor = self.advisor(two_question_pool(), max_questions=1)
        step = advisor.next()
        self.assertEqual(step["question_key"], "needs.furnished")
        result = advisor.answer(step["question_id"], option_id="no")
        self.assertEqual((result["next"]["action"], result["next"]["reason_code"]),
                         ("recommend", "question_budget_spent"))

    def test_feedback_excludes_the_area_end_to_end(self):
        pool = [home("A", rent=600), home("B", rent=620, suburb="Redfern")]
        advisor = self.advisor(pool)
        step = advisor.next()
        self.assertEqual(step["action"], "recommend")
        result = advisor.feedback(rejected_ids=["A"], reasons=["不喜欢这个区"])
        self.assertEqual([item["listing_id"] for item in result["next"]["recommendations"]], ["B"])

    def test_confirmed_station_limit_applies_before_the_pool_is_cut(self):
        far = [home(f"F{i}", rent=500 + i, walk=1500) for i in range(5)]
        near = home("N", rent=780, walk=300)
        st = state(station_walk=StationWalkRequirement(status="confirmed", max_m=400.0))
        advisor = self.advisor(far + [near], initial_state=st, pool_size=3)
        self.assertEqual([item.listing_id for item in advisor.candidates()], ["N"])
        self.assertEqual(advisor.next()["recommendations"][0]["listing_id"], "N")

    def test_pool_keeps_stretch_room_until_budget_is_settled(self):
        pool = [home("A", rent=780), home("B", rent=860)]
        advisor = self.advisor(pool)
        self.assertEqual({item.listing_id for item in advisor.candidates()}, {"A", "B"})
        advisor._apply({"budget_stretch_pct": 0.0}, "test")
        self.assertEqual({item.listing_id for item in advisor.candidates()}, {"A"})

    def test_budget_stretch_text_answers(self):
        advisor = self.advisor()
        spec = QuestionSpec("budget_stretch", "", (), ())
        for text, expected in (("可以", {"budget_stretch_pct": 10.0}), ("ok", {"budget_stretch_pct": 10.0}),
                               ("不行", {"budget_stretch_pct": 0.0}), ("no", {"budget_stretch_pct": 0.0}),
                               ("I don't know", None), ("不知道", None), ("可能吧", None)):
            with self.subTest(text=text):
                self.assertEqual(advisor._parse_text_answer(spec, text), expected)

    def test_station_text_answer(self):
        st = state()
        pool = [home("A", rent=500, walk=1100, low=900, high=1300), home("B", rent=640, walk=300)]
        advisor = self.advisor(pool, initial_state=st)
        step = advisor.next()
        self.assertEqual(step["question_key"], "station_walk_max_m")
        result = advisor.answer(step["question_id"], text="最多走 500 米")
        self.assertEqual(result["status"], "applied")
        self.assertEqual(advisor.state.station_walk.max_m, 500.0)
        self.assertEqual(result["next"]["recommendations"][0]["listing_id"], "B")

    def test_station_skip_option_and_text_skip_return_skipped_status(self):
        pool = [home("A", rent=500, walk=1100, low=900, high=1300), home("B", rent=640, walk=300)]
        advisor1 = self.advisor(pool)
        step1 = advisor1.next()
        self.assertEqual(step1["question_key"], "station_walk_max_m")
        res1 = advisor1.answer(step1["question_id"], option_id="skip")
        self.assertEqual(res1["status"], "skipped")
        self.assertEqual(advisor1.state.station_walk.status, "deferred")

        advisor2 = self.advisor()
        step2 = advisor2.next()
        self.assertEqual(step2["question_key"], "needs.pets")
        res2 = advisor2.answer(step2["question_id"], text="暂时跳过")
        self.assertEqual(res2["status"], "skipped")
        self.assertIn("needs.pets", advisor2.asked_keys)

    def test_repeated_invalid_answers_auto_skip_instead_of_deadlocking(self):
        advisor = self.advisor(max_invalid_attempts=3)
        qid = advisor.next()["question_id"]
        for _ in range(3):
            res = advisor.answer(qid, text="听不懂的话")
            self.assertEqual(res["status"], "invalid_answer")
        fourth = advisor.answer(qid, text="还是听不懂")
        self.assertEqual((fourth["status"], fourth["reason_code"]), ("skipped", "max_retries_exceeded"))
        self.assertIn("needs.pets", advisor.asked_keys)
        self.assertEqual(fourth["next"]["action"], "recommend")

    def test_repeated_profile_invalidation_cannot_loop_forever(self):
        advisor = self.advisor(two_question_pool())
        first = advisor.next()
        self.assertEqual(first["question_key"], "needs.furnished")
        advisor.feedback(reasons=["太贵"])
        second = advisor.next()
        self.assertEqual(second["question_key"], "needs.furnished")
        advisor.feedback(reasons=["太贵"])
        third = advisor.next()
        self.assertNotEqual(third.get("question_key"), "needs.furnished")

    def test_budget_stretch_asked_when_strict_budget_has_no_match(self):
        pool = [home("A", rent=850, fair=950, market=2, walk=300)]
        advisor = self.advisor(pool, initial_state=state(budget_weekly_max=800))
        step = advisor.next()
        self.assertEqual((step["action"], step["question_key"]), ("ask", "budget_stretch"))
        res = advisor.answer(step["question_id"], option_id="stretch")
        self.assertEqual(res["next"]["action"], "recommend")
        self.assertEqual(res["next"]["recommendations"][0]["listing_id"], "A")

    def test_feedback_commute_complaint_triggers_commute_question_next(self):
        pool = [home("A", rent=600), home("B", rent=620)]
        advisor = self.advisor(pool)
        step = advisor.next()
        self.assertEqual(step["action"], "recommend")
        result = advisor.feedback(reasons=["通勤太麻烦"])
        self.assertEqual((result["next"]["action"], result["next"]["question_key"]), ("ask", "commute_to"))
        ans = advisor.answer(result["next"]["question_id"], text="不固定")
        self.assertEqual(ans["status"], "applied")
        self.assertEqual(advisor.state.soft_preferences["commute_to"], "none")

    def test_single_feedback_does_not_double_multiply_same_weight(self):
        best = home("A", rent=650, market=1)
        cheap = home("B", rent=600, market=10, suburb="Redfern")
        shown = ({"listing_id": "A", "role": "best"}, {"listing_id": "B", "role": "cheapest"})
        patch, notes = apply_feedback(state(), shown, {"A": best, "B": cheap}, ranker(),
                                      chosen_id="B", reasons=["太贵"], learner="heuristic")
        self.assertEqual(patch["weight_adjust"]["value"], 1.5)
        self.assertEqual(len(notes), 2)

    def test_indifferent_and_english_needs_extraction(self):
        self.assertIs(extract_needs("对宠物过敏，车位无所谓").patch["needs"]["pets"], False)
        self.assertIs(extract_needs("对宠物过敏，车位无所谓").patch["needs"]["parking"], False)
        patch = extract_needs("Want two bedrooms, 每周650刀, 预算可以稍微放宽").patch
        self.assertEqual(patch["bedrooms"], 2)
        self.assertEqual(patch["budget_weekly_max"], 650.0)
        self.assertEqual(patch["budget_stretch_pct"], 10.0)
        self.assertNotIn("station_walk", extract_needs("我在B站看房，预算700m").patch)

    def test_text_answer_with_trailing_skip_phrase_extracts_answer_first(self):
        advisor = self.advisor()
        step = advisor.next()
        self.assertEqual(step["question_key"], "needs.pets")
        res = advisor.answer(step["question_id"], text="有一只猫，别的再说")
        self.assertEqual(res["status"], "applied")
        self.assertIs(advisor.state.other_confirmed["needs"]["pets"], True)

    def test_needs_negation_and_bus_stop_guards(self):
        self.assertEqual(extract_needs("预算800不可以多").patch.get("budget_stretch_pct"), 0.0)
        self.assertNotIn("budget_stretch_pct", extract_needs("预算能不能放宽？").patch)
        self.assertNotIn("station_walk", extract_needs("离公交站300米").patch)
        self.assertEqual(extract_needs("离火车站300米").patch["station_walk"]["max_m"], 300.0)
        self.assertIs(extract_needs("养狗没有问题吧").patch["needs"]["pets"], True)
        self.assertIs(extract_needs("宠物没有限制的最好").patch["needs"]["pets"], True)

    def test_recommend_set_handles_zero_walk_distance_correctly(self):
        pool = [
            home("A", rent=650, fair=780, walk=200),
            home("B", rent=660, fair=760, walk=0),
            home("C", rent=600, fair=700, walk=800),
        ]
        rk = ranker()
        recs = recommend_set(state(), pool, rk, rk.snapshot_id, k=3)
        by_role = {r["role"]: r["listing_id"] for r in recs}
        self.assertEqual(by_role.get("closest_station"), "B")

    def test_stretch_listings_do_not_starve_within_budget_candidates(self):
        pool = [
            home("S1", rent=870, fair=1100, market=1, lat=-33.88, lng=151.20),
            home("S2", rent=860, fair=1080, market=1, lat=-33.89, lng=151.19),
            home("S3", rent=850, fair=1060, market=1, lat=-33.91, lng=151.23),
            home("IN1", rent=780, fair=820, market=10, lat=-33.87, lng=151.21),
        ]
        advisor = self.advisor(pool, initial_state=state(budget_weekly_max=800), pool_size=3)
        cand_ids = [item.listing_id for item in advisor.candidates()]
        self.assertIn("IN1", cand_ids)
        res = advisor.feedback(reasons=["通勤太麻烦"])
        self.assertEqual(res["next"]["question_key"], "commute_to")
        self.assertEqual(advisor.pending["plan"].default_listing_id, "IN1")

    def test_candidates_reserve_sparse_true_features_and_ask_unconfirmed_needs(self):
        # 10 套未写明宠物/家具的低价房源 + 1 套明确允许宠物和带家具的房源
        cheap_none = [home(f"N{i}", rent=550 + i * 2, fair=750, walk=300) for i in range(10)]
        pet_furn = home("PF", rent=640, fair=750, walk=300, features={"pets": True, "furnished": True})
        advisor = self.advisor(cheap_none + [pet_furn], pool_size=6)
        cand_ids = [item.listing_id for item in advisor.candidates()]
        self.assertIn("PF", cand_ids)
        step = advisor.next()
        self.assertEqual(step["action"], "ask")
        self.assertIn(step["question_key"], ("needs.furnished", "needs.pets"))

    def test_feedback_unlocks_remaining_questions_and_never_loops_on_rejected_cards(self):
        # 三道高价值问题：车位、家具、宠物；默认首轮最多问 2 题后进入推荐，但用户反馈后会继续追问第 3 题
        pool = [
            home("A", rent=520, fair=800, walk=300, features={"parking": False, "furnished": False, "pets": False}),
            home("B", rent=600, fair=780, walk=300, features={"parking": True, "furnished": True, "pets": True}),
            home("C", rent=620, fair=780, walk=300, features={"parking": True, "furnished": True, "pets": True}),
        ]
        advisor = self.advisor(pool)
        s1 = advisor.next()
        self.assertEqual((s1["action"], s1["question_key"]), ("ask", "needs.parking"))
        s2 = advisor.answer(s1["question_id"], option_id="no")["next"]
        self.assertEqual((s2["action"], s2["question_key"]), ("ask", "needs.furnished"))
        s3 = advisor.answer(s2["question_id"], option_id="no")["next"]
        self.assertEqual(s3["action"], "recommend")
        # 用户在前端对推荐结果给出反馈：应解锁第 3 个高价值问题 needs.pets，而不是卡在二选一推荐里
        fb1 = advisor.feedback(chosen_id="B")
        self.assertEqual((fb1["next"]["action"], fb1["next"]["question_key"]), ("ask", "needs.pets"))
        s4 = advisor.answer(fb1["next"]["question_id"], option_id="no")["next"]
        self.assertEqual(s4["action"], "recommend")
        self.assertEqual(s4["recommendations"][0]["listing_id"], "A")
        # 再次在前端点选 B（跳过榜首 A）。A 在每个可建模的维度上都不差于 B，偏好再怎么更新也排第一：
        # 被跳过累计到 skip_patience 次后才移出，既不死循环重复推 A，也不因一次随手的选择就删掉它。
        tops = []
        for _ in range(advisor.skip_patience):
            step = advisor.feedback(chosen_id="B")["next"]
            self.assertEqual(step["action"], "recommend")
            tops.append(step["recommendations"][0]["listing_id"])
        self.assertEqual(tops[-1], "B")
        self.assertTrue(all(top == "A" for top in tops[:-1]))
        self.assertIn("A", advisor.rejected_listing_ids)

    def test_skip_patience_one_restores_drop_on_first_skip(self):
        pool = [home("A", rent=520, fair=800), home("B", rent=600, fair=780), home("C", rent=620, fair=780)]
        st = state(other_confirmed={"needs": {"pets": False, "furnished": False, "parking": False},
                                    "budget_stretch_pct": 0.0}, soft_preferences={"commute_to": "none"},
                   station_walk=StationWalkRequirement(status="confirmed", max_m=None))
        advisor = self.advisor(pool, initial_state=st, skip_patience=1)
        self.assertEqual(advisor.next()["recommendations"][0]["listing_id"], "A")
        self.assertEqual(advisor.feedback(chosen_id="B")["next"]["recommendations"][0]["listing_id"], "B")
        never = self.advisor(pool, initial_state=st, skip_patience=0)
        never.next()
        for _ in range(5):
            self.assertEqual(never.feedback(chosen_id="B")["next"]["recommendations"][0]["listing_id"], "A")
        self.assertEqual(never.rejected_listing_ids, set())


class PreferenceLearningTest(unittest.TestCase):
    """默认学习器：选择记成证据，权重取偏好后验均值；推荐集合按 EUS 选。"""

    def setUp(self):
        self.listings = {"A": home("A", rent=650, market=1), "B": home("B", rent=600, market=10, suburb="Redfern")}
        self.shown = ({"listing_id": "A", "role": "best"}, {"listing_id": "B", "role": "cheapest"})

    def feedback(self, st=None, **kwargs):
        return apply_feedback(st or state(), self.shown, self.listings, ranker(), **kwargs)

    def test_particles_are_deterministic_and_centred(self):
        from world_model import preference
        rows = preference.particles()
        self.assertEqual(len(rows), preference.N_PARTICLES)
        self.assertIs(rows, preference.particles())
        self.assertTrue(all(0.25 <= value <= 4.0 for row in rows for value in row[:4]))
        prior = preference.posterior_adjust([])
        for key in ("value", "groceries", "commute"):
            self.assertAlmostEqual(prior[key], 1.0, places=3)
        self.assertLess(prior["station"], 1.0)

    def test_choice_moves_weights_towards_what_the_chosen_home_is_better_at(self):
        patch, _notes = self.feedback(chosen_id="B")          # B 更便宜、买菜更远
        self.assertGreater(patch["weight_adjust"]["value"], 1.0)
        self.assertLess(patch["weight_adjust"]["groceries"], 1.0)
        self.assertEqual(len(patch["preference_evidence"]), 1)
        confirm, _notes = self.feedback(chosen_id="A")        # 选首选也是证据：方向相反
        self.assertLess(confirm["weight_adjust"]["value"], 1.0)
        self.assertGreater(confirm["weight_adjust"]["groceries"], 1.0)

    def test_evidence_accumulates_instead_of_compounding_a_fixed_factor(self):
        st = state()
        values = []
        for _ in range(4):
            patch, _notes = self.feedback(st, chosen_id="B")
            st = apply_state_patch(st, patch)
            values.append(st.soft_preferences["weight_adjust"]["value"])
        self.assertEqual(values, sorted(values))
        self.assertLess(values[-1] - values[-2], values[1] - values[0])      # 收益递减，不是每次 ×1.5
        self.assertLessEqual(values[-1], 4.0)
        self.assertEqual(len(st.soft_preferences["preference_evidence"]), 4)

    def test_same_evidence_gives_the_same_weights(self):
        first, _ = self.feedback(chosen_id="B")
        second, _ = self.feedback(chosen_id="B")
        self.assertEqual(first, second)

    def test_stated_reason_is_evidence_without_a_choice(self):
        patch, notes = self.feedback(reasons=["太贵"])
        self.assertGreater(patch["weight_adjust"]["value"], 1.15)
        self.assertEqual(patch["preference_evidence"], [{"r": "value"}])
        self.assertEqual(notes, ["更看重价格"])
        station, _ = self.feedback(reasons=["离车站远"])
        from world_model.preference import posterior_adjust
        self.assertGreater(station["weight_adjust"]["station"], posterior_adjust([])["station"])

    def test_choosing_closer_to_station_raises_station_weight(self):
        self.listings = {"A": home("A", rent=650, market=1, walk=900), "B": home("B", rent=650, market=1, walk=100)}
        from world_model.preference import posterior_adjust
        patch, _notes = self.feedback(chosen_id="B")
        self.assertGreater(patch["weight_adjust"]["station"], posterior_adjust([])["station"])

    def test_area_and_unknown_commute_still_handled(self):
        patch, notes = self.feedback(rejected_ids=["B"], reasons=["不喜欢这个区"])
        self.assertEqual(patch, {"excluded_districts": ["Redfern"]})
        patch, notes = self.feedback(reasons=["通勤太麻烦"])
        self.assertEqual(patch, {})
        self.assertIn("还不知道目的地", notes[0])

    def test_feedback_never_touches_hard_requirements(self):
        patch, _notes = self.feedback(chosen_id="B", rejected_ids=["A"], reasons=["太贵", "离车站远"])
        self.assertEqual(set(patch), {"weight_adjust", "preference_evidence"})

    def test_evidence_is_validated_bounded_and_never_written_by_the_llm(self):
        good = {"c": [1, 2, 3, 4, 0], "o": [[1, 2, 3, 4, 0]]}
        bad = [{"c": [1, 2], "o": [[1, 2, 3, 4, 0]]}, {"c": [1, 2, 3, 4, float("nan")], "o": [[1, 2, 3, 4, 0]]},
               {"c": [1, 2, 3, 4, 0], "o": []}, {"r": "rent"}, "x", {"c": [1, 2, 3, 4, True], "o": [[1, 2, 3, 4, 0]]}]
        self.assertEqual(len(validate_patch({"preference_evidence": bad + [good, {"r": "value"}]})["preference_evidence"]), 2)
        st = state()
        for _ in range(40):
            st = apply_state_patch(st, {"preference_evidence": [good]})
        self.assertEqual(len(st.soft_preferences["preference_evidence"]), 30)
        result = extract_needs("预算800", llm=lambda prompt: {"preference_evidence": [good]})
        self.assertNotIn("preference_evidence", result.patch)
        self.assertIn("preference_evidence", result.dropped)

    def test_state_with_evidence_survives_json(self):
        patch, _notes = self.feedback(chosen_id="B")
        st = apply_state_patch(state(), patch)
        restored = json.loads(json.dumps(st.to_dict(), allow_nan=False))
        self.assertEqual(restored["soft_preferences"]["preference_evidence"], patch["preference_evidence"])

    def test_eus_set_covers_different_plausible_preferences(self):
        # A 综合最优；B 明显更省钱但买菜远；C 与 A 几乎一样（只差一点）。EUS 应选 B 而不是近似重复的 C。
        pool = [home("A", rent=600, market=2), home("C", rent=602, market=2), home("B", rent=545, market=11)]
        picks = recommend_set(state(), pool, ranker(), SNAP, k=2, selector="eus")
        self.assertEqual([item["listing_id"] for item in picks], ["A", "B"])
        self.assertEqual([item["role"] for item in picks], ["best", "cheapest"])
        roles = recommend_set(state(), pool, ranker(), SNAP, k=2, selector="roles")
        self.assertEqual(roles[0]["listing_id"], "A")

    def test_eus_first_pick_is_always_the_ranker_top_and_respects_slack(self):
        pool = [home("A", rent=600, market=1), home("B", rent=300, market=60), home("C", rent=610, market=2)]
        picks = recommend_set(state(), pool, ranker(), SNAP, selector="eus")
        self.assertEqual(picks[0]["listing_id"], ranker().rank(state(), pool, SNAP)[0])
        self.assertEqual(picks[0]["role"], "best")
        self.assertNotIn("cheapest", [item["role"] for item in picks if item["listing_id"] == "B"])
        ids = [item["listing_id"] for item in picks]
        self.assertEqual(len(ids), len(set(ids)))

    def test_advisor_learns_from_repeated_choices(self):
        pool = [home("A", rent=600, market=2), home("B", rent=560, market=9), home("C", rent=640, market=1)]
        st = state(other_confirmed={"needs": {"pets": False, "furnished": False, "parking": False},
                                    "budget_stretch_pct": 0.0}, soft_preferences={"commute_to": "none"},
                   station_walk=StationWalkRequirement(status="confirmed", max_m=None))
        advisor = RentalAdvisor(pool, ranker(), initial_state=st)
        self.assertEqual(advisor.next()["recommendations"][0]["listing_id"], "A")
        step = advisor.feedback(chosen_id="B")["next"]
        step = advisor.feedback(chosen_id="B")["next"]
        self.assertEqual(step["recommendations"][0]["listing_id"], "B")
        self.assertEqual(advisor.rejected_listing_ids, set())       # 是学出来的，不是靠移除 A
        self.assertGreater(advisor.state.soft_preferences["weight_adjust"]["value"], 1.0)


if __name__ == "__main__":
    unittest.main()
