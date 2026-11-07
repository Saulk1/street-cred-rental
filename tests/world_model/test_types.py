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
    StationWalkRequirement,
    UserState,
    ValidationError,
    build_scenarios,
    standard_question,
)
from world_model.types import MAX_CANDIDATES, STATION_CONFIRMED, STATION_DEFERRED, STATION_UNKNOWN


def load_fixture(name):
    with open(os.path.join(_FIXTURES, name), encoding="utf-8") as handle:
        return json.load(handle)


def demo_state(**overrides):
    payload = dict(budget_weekly_max=750, bedrooms=2, districts=("西湖",),
                   soft_preferences={"emphasis": "groceries"}, other_confirmed={"pets_allowed": False})
    payload.update(overrides)
    return UserState(**payload)


def demo_listing(listing_id="A", **overrides):
    payload = dict(listing_id=listing_id, station_walk_m=500, weekly_rent=700,
                   supermarket_walk_min=4, bedroom_count=None)
    payload.pop("bedroom_count")
    payload.update(overrides)
    return Listing(**payload)


class StationWalkStatusTest(unittest.TestCase):
    """Task 1：confirmed / unknown / deferred 三种状态不可混淆。"""

    def test_confirmed_null_differs_from_unknown_null(self):
        self.assertNotEqual(StationWalkRequirement(STATION_CONFIRMED, None),
                            StationWalkRequirement(STATION_UNKNOWN, None))

    def test_deferred_null_differs_from_both(self):
        deferred = StationWalkRequirement(STATION_DEFERRED, None)
        self.assertNotEqual(deferred, StationWalkRequirement(STATION_UNKNOWN, None))
        self.assertNotEqual(deferred, StationWalkRequirement(STATION_CONFIRMED, None))

    def test_unknown_and_deferred_cannot_carry_a_limit(self):
        for status in (STATION_UNKNOWN, STATION_DEFERRED):
            with self.assertRaises(ValidationError):
                StationWalkRequirement(status, 400)

    def test_zero_is_a_legal_distance(self):
        self.assertEqual(StationWalkRequirement(STATION_CONFIRMED, 0).max_m, 0.0)

    def test_numeric_limit_filters_boundary_inclusive(self):
        requirement = StationWalkRequirement(STATION_CONFIRMED, 400)
        self.assertTrue(requirement.allows(400))
        self.assertTrue(requirement.allows(399.9))
        self.assertFalse(requirement.allows(401))
        self.assertFalse(requirement.allows(None), "缺失距离不得当成 0 通过")

    def test_confirmed_without_limit_filters_nothing(self):
        requirement = StationWalkRequirement(STATION_CONFIRMED, None)
        self.assertTrue(requirement.allows(None))
        self.assertTrue(requirement.allows(9000))

    def test_unknown_filters_nothing(self):
        self.assertTrue(StationWalkRequirement().allows(9000))


class ListingValidationTest(unittest.TestCase):
    """Task 1：拒绝负数、NaN、无穷大、重复 ID 与超长候选池。"""

    def test_rejects_negative_distance(self):
        with self.assertRaises(ValidationError):
            demo_listing(station_walk_m=-1)

    def test_rejects_nan_and_infinity(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(ValidationError):
                demo_listing(station_walk_m=value)

    def test_missing_distance_stays_none(self):
        self.assertIsNone(demo_listing(station_walk_m=None).station_walk_m)

    def test_rejects_empty_listing_id(self):
        with self.assertRaises(ValidationError):
            demo_listing(listing_id="   ")

    def test_rejects_unknown_data_mode(self):
        with self.assertRaises(ValidationError):
            demo_listing(source="maybe")

    def test_rejects_duplicate_listing_ids(self):
        with self.assertRaises(ValidationError):
            PlanInput(session_id="s", search_id="q", state_version=1,
                      candidate_snapshot_id="c", ranker_snapshot_id="r",
                      user_state=demo_state(),
                      candidates=(demo_listing("A"), demo_listing("A", station_walk_m=100)))

    def test_rejects_more_than_twenty_candidates(self):
        many = tuple(demo_listing(f"L{index}") for index in range(MAX_CANDIDATES + 1))
        with self.assertRaises(ValidationError):
            PlanInput(session_id="s", search_id="q", state_version=1,
                      candidate_snapshot_id="c", ranker_snapshot_id="r",
                      user_state=demo_state(), candidates=many)

    def test_accepts_exactly_twenty_candidates(self):
        pool = tuple(demo_listing(f"L{index}") for index in range(MAX_CANDIDATES))
        request = PlanInput(session_id="s", search_id="q", state_version=1,
                            candidate_snapshot_id="c", ranker_snapshot_id="r",
                            user_state=demo_state(), candidates=pool)
        self.assertEqual(len(request.candidates), MAX_CANDIDATES)


class UserStateTest(unittest.TestCase):
    def test_keeps_existing_conditions(self):
        state = demo_state()
        self.assertEqual(state.budget_weekly_max, 750.0)
        self.assertEqual(state.bedrooms, 2)
        self.assertEqual(state.districts, ("西湖",))
        self.assertEqual(state.other_confirmed["pets_allowed"], False)

    def test_fingerprint_changes_only_with_content(self):
        self.assertEqual(demo_state().fingerprint(), demo_state().fingerprint())
        self.assertNotEqual(demo_state().fingerprint(),
                            demo_state(station_walk=StationWalkRequirement(STATION_CONFIRMED, 400)).fingerprint())

    def test_fingerprint_survives_non_json_values(self):
        import datetime
        state = demo_state(other_confirmed={"move_in": datetime.date(2026, 12, 1)})
        self.assertIsInstance(state.fingerprint(), str)
        self.assertNotEqual(state.fingerprint(),
                            demo_state(other_confirmed={"move_in": datetime.date(2026, 12, 2)}).fingerprint())

    def test_with_station_walk_keeps_other_fields(self):
        updated = demo_state().with_station_walk(StationWalkRequirement(STATION_CONFIRMED, 400))
        self.assertEqual(updated.budget_weekly_max, 750.0)
        self.assertEqual(updated.districts, ("西湖",))
        self.assertEqual(updated.other_confirmed["pets_allowed"], False)


class PayloadContractTest(unittest.TestCase):
    """§5.1：真实快照的既有条件必须保留；坏数据不抛异常而是标记 payload_error。"""

    def test_unknown_state_fields_are_preserved(self):
        payload = load_fixture("decisive.json")["request"]
        payload = json.loads(json.dumps(payload))
        payload["user_state"]["has_pet"] = True
        request = PlanInput.from_payload(payload)
        self.assertIsNone(request.payload_error)
        self.assertIs(request.user_state.other_confirmed["has_pet"], True)

    def test_bad_candidate_marks_payload_error_instead_of_crashing(self):
        payload = json.loads(json.dumps(load_fixture("decisive.json")["request"]))
        payload["candidates"][0]["station_walk_m"] = -5
        request = PlanInput.from_payload(payload)
        self.assertIsNotNone(request.payload_error)
        self.assertIn("invalid_candidate", request.payload_error)

    def test_invalid_state_marks_payload_error(self):
        payload = json.loads(json.dumps(load_fixture("decisive.json")["request"]))
        payload["user_state"]["budget_weekly_max"] = -1
        request = PlanInput.from_payload(payload)
        self.assertIn("invalid_user_state", request.payload_error or "")


class ScenarioTest(unittest.TestCase):
    """Task 1：三个标准情景与固定问句内容。"""

    def test_three_standard_scenarios_in_order(self):
        scenarios = build_scenarios()
        self.assertEqual([item.scenario_id for item in scenarios],
                         ["station-le-400", "station-le-1000", "station-no-limit"])
        self.assertEqual([item.max_m for item in scenarios], [400.0, 1000.0, None])

    def test_scenario_patch_only_touches_station_walk(self):
        for scenario in build_scenarios():
            self.assertEqual(set(scenario.next_state_patch()), {"station_walk"})
            self.assertEqual(scenario.next_state_patch()["station_walk"]["status"], STATION_CONFIRMED)

    def test_build_scenarios_returns_a_fresh_list(self):
        build_scenarios().clear()
        self.assertEqual(len(build_scenarios()), 3)

    def test_question_and_options_are_fixed(self):
        key, text, options = standard_question()
        self.assertEqual(key, "station_walk_max_m")
        self.assertTrue(text.startswith("你能接受步行多远到车站"))
        self.assertEqual([option.id for option in options], ["le_400", "le_1000", "no_limit", "skip"])
        self.assertEqual([option.to_dict().get("max_m") for option in options], [400.0, 1000.0, None, None])
        self.assertNotIn("max_m", options[3].to_dict(), "跳过不是距离，不应带 max_m")


class FixtureShapeTest(unittest.TestCase):
    """Task 1：四组演示数据必须标明来源与数据模式，并带预期结果。"""

    names = ("decisive.json", "unchanged.json", "no_match.json", "missing_data.json")

    def test_every_fixture_is_labelled_demo(self):
        for name in self.names:
            fixture = load_fixture(name)
            self.assertEqual(fixture["data_mode"], "demo", name)
            for candidate in fixture["request"]["candidates"]:
                self.assertEqual(candidate["source"], "demo", f"{name}/{candidate['listing_id']}")
            self.assertIn("演示", fixture["notice"], name)

    def test_every_fixture_has_expected_block(self):
        for name in self.names:
            expected = load_fixture(name)["expected"]
            self.assertIn(expected["action"], ("ask", "recommend", "needs_data"), name)
            self.assertIn("reason_code", expected, name)

    def test_fixtures_parse_into_plan_input(self):
        for name in self.names:
            request = PlanInput.from_payload(load_fixture(name)["request"])
            self.assertIsNone(request.payload_error, name)
            self.assertEqual(len(request.candidates), 2, name)


class PayloadRobustnessTest(unittest.TestCase):
    """审计回归：不可信快照的坏字段必须是 payload_error，不能让解析崩掉。"""

    def base(self, name="decisive.json"):
        return json.loads(json.dumps(load_fixture(name)["request"]))

    def test_unknown_station_walk_status_becomes_payload_error(self):
        payload = self.base()
        payload["station_walk"] = {"status": "maybe", "max_m": 400}
        request = PlanInput.from_payload(payload)
        self.assertIn("invalid_station_walk", request.payload_error or "")

    def test_non_mapping_station_walk_becomes_payload_error(self):
        payload = self.base()
        payload["station_walk"] = "unknown"
        request = PlanInput.from_payload(payload)
        self.assertIn("invalid_station_walk", request.payload_error or "")

    def test_negative_station_walk_becomes_payload_error(self):
        payload = self.base()
        payload["station_walk"] = {"status": "confirmed", "max_m": -400}
        self.assertIn("invalid_station_walk", PlanInput.from_payload(payload).payload_error or "")

    def test_non_mapping_user_state_becomes_payload_error(self):
        payload = self.base()
        payload["user_state"] = ["budget_weekly_max", 750]
        request = PlanInput.from_payload(payload)
        self.assertIn("invalid_user_state", request.payload_error or "")

    def test_nested_station_walk_is_used_when_top_level_missing(self):
        payload = self.base()
        payload.pop("station_walk")
        payload["user_state"]["station_walk"] = {"status": "confirmed", "max_m": 400}
        request = PlanInput.from_payload(payload)
        self.assertIsNone(request.payload_error)
        self.assertEqual(request.station_walk, StationWalkRequirement(STATION_CONFIRMED, 400),
                         "内嵌的已确认要求不能被静默丢弃成未知")

    def test_conflicting_station_walk_is_refused(self):
        payload = self.base()
        payload["user_state"]["station_walk"] = {"status": "confirmed", "max_m": 1000}
        request = PlanInput.from_payload(payload)
        self.assertIn("不一致", request.payload_error or "")

    def test_asked_question_keys_as_string_is_not_split_into_characters(self):
        payload = self.base()
        payload["asked_question_keys"] = "station_walk_max_m"
        request = PlanInput.from_payload(payload)
        self.assertIn("invalid_asked_question_keys", request.payload_error or "")
        self.assertEqual(request.asked_question_keys, ())

    def test_asked_question_keys_list_still_works(self):
        payload = self.base()
        payload["asked_question_keys"] = ["station_walk_max_m"]
        request = PlanInput.from_payload(payload)
        self.assertIsNone(request.payload_error)
        self.assertEqual(request.asked_question_keys, ("station_walk_max_m",))

    def test_districts_as_string_is_not_split_into_characters(self):
        payload = self.base()
        payload["user_state"]["districts"] = "Ultimo"
        request = PlanInput.from_payload(payload)
        self.assertIn("invalid_user_state", request.payload_error or "")
        self.assertEqual(request.user_state.districts, ())

    def test_envelope_fields_still_raise(self):
        payload = self.base()
        del payload["state_version"]
        with self.assertRaises(ValidationError):
            PlanInput.from_payload(payload)
