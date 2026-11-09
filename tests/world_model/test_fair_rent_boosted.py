"""公平租金 v2：提升树、只用过去数据的历史特征、留一扣除、编号归一、与 v1 的接口兼容。"""

import json
import math
import os
import random
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "compute"))

from world_model.boosting import BoostedTrees, bin_row, make_bins  # noqa: E402
from world_model.fair_rent import FairRentModel, RentObservation, normalize_gnaf  # noqa: E402
from world_model.fair_rent_boosted import (  # noqa: E402
    AREA_FEATURES,
    FEATURES,
    AreaFeatures,
    BoostedFairRent,
    History,
    _keys,
    load_fair_rent_model,
)


def synthetic(n=1500, seed=3):
    """30 栋楼，各有固定溢价；同一套房会重复挂牌。溢价是 v1 的 250 m 网格分不开的（同一格里有多栋楼）。"""
    rng = random.Random(seed)
    buildings = [(-33.88 + (i % 6) * 0.0008, 151.20 + (i // 6) * 0.0008, rng.gauss(0.0, 0.18)) for i in range(30)]
    rows = []
    for index in range(n):
        number = rng.randrange(len(buildings))
        lat, lng, premium = buildings[number]
        beds = rng.choice([0, 1, 1, 2, 2, 3])
        unit = rng.randrange(12)
        day = rng.randrange(540)
        month, dom = divmod(day, 30)
        date_text = f"{2025 + month // 12}-{month % 12 + 1:02d}-{dom % 28 + 1:02d}"
        rent = math.exp(math.log(520) + 0.33 * beds + premium + 0.03 * (unit % 3) + rng.gauss(0.0, 0.04))
        rows.append(RentObservation(suburb="Testville", property_type="Unit", bedrooms=beds, bathrooms=1.0,
                                    car_spaces=float(beds > 1), weekly_rent=round(rent), listing_date=date_text,
                                    lat=lat, lng=lng, gnaf=f"GANSW7{number:02d}{unit:02d}{beds}"))
    return sorted(rows, key=lambda row: row.listing_date)


def mape(pairs):
    return sum(abs(prediction - row.weekly_rent) / row.weekly_rent for row, prediction in pairs) / len(pairs)


class BoostedTreesTest(unittest.TestCase):
    def data(self, n=600, seed=1):
        rng = random.Random(seed)
        rows = [[rng.uniform(0, 10), rng.uniform(0, 10), rng.choice([None, 0.0, 1.0])] for _ in range(n)]
        targets = [(2.0 if row[0] > 5 else -1.0) + (1.5 if row[1] > 7 and row[0] > 5 else 0.0) + rng.gauss(0, 0.05)
                   for row in rows]
        return rows, targets

    def test_learns_a_step_and_an_interaction(self):
        rows, targets = self.data()
        model = BoostedTrees.fit(rows, targets, n_trees=80, max_depth=3, learning_rate=0.2, min_leaf=10, subsample=1.0)
        self.assertAlmostEqual(model.predict([8.0, 9.0, 0.0]), 3.5, delta=0.25)
        self.assertAlmostEqual(model.predict([8.0, 2.0, 0.0]), 2.0, delta=0.25)
        self.assertAlmostEqual(model.predict([2.0, 9.0, 0.0]), -1.0, delta=0.25)
        gain = model.feature_gain()
        self.assertGreater(gain[0], gain[2])

    def test_fit_is_deterministic_and_survives_json(self):
        rows, targets = self.data()
        first = BoostedTrees.fit(rows, targets, n_trees=20, max_depth=3)
        second = BoostedTrees.fit(rows, targets, n_trees=20, max_depth=3)
        restored = BoostedTrees.from_dict(json.loads(json.dumps(first.to_dict())))
        for row in rows[:25]:
            self.assertEqual(first.predict(row), second.predict(row))
            self.assertAlmostEqual(first.predict(row), restored.predict(row), places=4)

    def test_missing_values_have_their_own_bin(self):
        thresholds = make_bins([[1.0], [2.0], [None], [3.0]], max_bins=4)
        self.assertEqual(bin_row([None], thresholds), [0])
        self.assertGreater(bin_row([0.5], thresholds)[0], 0)
        self.assertGreaterEqual(bin_row([99.0], thresholds)[0], bin_row([1.5], thresholds)[0])

    def test_early_stopping_keeps_the_best_prefix(self):
        rows, targets = self.data()
        noise = random.Random(9)
        valid = (rows[:150], [noise.gauss(0, 1) for _ in range(150)])        # 验证目标是纯噪声：越训越差
        model = BoostedTrees.fit(rows[150:], targets[150:], n_trees=200, max_depth=3, valid=valid, patience=10)
        self.assertLess(len(model.trees), 60)


class HistoryTest(unittest.TestCase):
    def features(self, history, day, gnaf="GANSW1", leave_own_out=False, lat=-33.88, beds=1):
        row, support = history.features(suburb="S", property_type="Unit", bedrooms=beds, bathrooms=1, car_spaces=0,
                                        lat=lat, lng=151.2, gnaf=gnaf, day=day, base=6.0, leave_own_out=leave_own_out)
        return dict(zip(FEATURES, row)), support

    def add(self, history, residual, day, gnaf="GANSW1", lat=-33.88, beds=1):
        history.add(gnaf, _keys("S", "Unit", beds, lat, 151.2), residual, day, str(beds))

    def test_empty_history_gives_missing_not_zero(self):
        row, support = self.features(History(), 100)
        for name in ("prev_res", "prev_gap_days", "bld_mean", "bldbeds_mean", "cell_mean", "grid_mean", "sub_mean"):
            self.assertIsNone(row[name], name)
        self.assertEqual((row["prev_count"], row["bld_n"], support), (0.0, 0.0, 0))

    def test_previous_listing_and_building_statistics(self):
        history = History()
        self.add(history, 0.10, 100)
        self.add(history, 0.30, 200, gnaf="GANSW2")          # 同一栋楼的另一套
        row, support = self.features(history, 300)
        self.assertEqual((row["prev_res"], row["prev_gap_days"], row["prev_count"], row["prev_same_beds"]),
                         (0.10, 200.0, 1.0, 1.0))
        self.assertAlmostEqual(row["bld_mean"], 0.20)
        self.assertEqual((row["bld_n"], support), (2.0, 2))
        other, _ = self.features(history, 300, gnaf="GANSW9", lat=-33.95)
        self.assertIsNone(other["bld_mean"])
        self.assertAlmostEqual(other["cell_mean"], 0.20)      # 不同楼，但同 suburb×类型×卧室

    def test_leave_one_out_removes_the_listing_itself(self):
        history = History()
        self.add(history, 0.10, 100)
        self.add(history, 0.50, 300)                          # 这次挂牌本身已经进了历史
        leaked, _ = self.features(history, 300)
        self.assertEqual(leaked["prev_res"], 0.50)
        clean, support = self.features(history, 300, leave_own_out=True)
        self.assertEqual((clean["prev_res"], clean["prev_gap_days"], clean["prev_count"]), (0.10, 200.0, 1.0))
        self.assertAlmostEqual(clean["bld_mean"], 0.10)
        self.assertAlmostEqual(clean["cell_mean"], 0.10)
        self.assertEqual((clean["bld_n"], support), (1.0, 1))

    def test_leave_one_out_with_no_earlier_record(self):
        history = History()
        self.add(history, 0.50, 300)
        clean, support = self.features(history, 300, leave_own_out=True)
        self.assertIsNone(clean["prev_res"])
        self.assertIsNone(clean["bld_mean"])
        self.assertEqual((clean["prev_count"], clean["bld_n"], support), (0.0, 0.0, 0))

    def test_an_earlier_record_is_not_removed(self):
        history = History()
        self.add(history, 0.10, 100)
        row, _ = self.features(history, 300, leave_own_out=True)
        self.assertEqual(row["prev_res"], 0.10)

    def test_prefixed_and_bare_ids_are_the_same_home(self):
        self.assertEqual(normalize_gnaf("GANSW720418858"), "720418858")
        self.assertEqual(normalize_gnaf("720418858"), "720418858")
        self.assertIsNone(normalize_gnaf(None))
        self.assertIsNone(normalize_gnaf(""))
        history = History()
        self.add(history, 0.10, 100, gnaf="720418858")
        row, _ = self.features(history, 300, gnaf="GANSW720418858")
        self.assertEqual(row["prev_res"], 0.10)


class BoostedFairRentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rows = synthetic()
        cls.train = [row for row in rows if row.listing_date < "2026-04-01"]
        cls.test = [row for row in rows if row.listing_date >= "2026-04-01"]
        cls.params = {"n_trees": 120, "max_depth": 4, "learning_rate": 0.1, "min_leaf": 10}
        cls.model = BoostedFairRent.fit(cls.train, **cls.params)
        cls.v1 = FairRentModel.fit(cls.train)

    def test_beats_the_layered_model_when_buildings_differ(self):
        v1 = [(row, self.v1.estimate(suburb=row.suburb, property_type=row.property_type, bedrooms=row.bedrooms,
                                     bathrooms=row.bathrooms, car_spaces=row.car_spaces, lat=row.lat, lng=row.lng,
                                     date_text=row.listing_date).hedonic_rent) for row in self.test]
        restored = BoostedFairRent.from_json(self.model.to_json())
        v2 = restored.walk_forward(self.test)
        self.assertLess(mape(v2), 0.75 * mape(v1))
        self.assertLess(mape(v2), 0.08)

    def test_walk_forward_never_sees_the_same_day(self):
        model = BoostedFairRent.fit(self.train, **self.params)
        twin = self.test[0]
        clone = RentObservation(**{**twin.__dict__, "weekly_rent": 5000.0, "gnaf": "GANSW999"})
        alone = dict(model.walk_forward([twin]))[twin]
        again = BoostedFairRent.fit(self.train, **self.params)
        together = dict(again.walk_forward([twin, clone]))[twin]
        self.assertEqual(alone, together)            # 同一天、同一栋楼的 $5000 挂牌不影响它

    def test_json_round_trip_gives_the_same_estimates(self):
        text = self.model.to_json()
        restored = load_fair_rent_model(text)
        self.assertIsInstance(restored, BoostedFairRent)
        self.assertEqual(restored.fingerprint(), self.model.fingerprint())
        self.assertEqual((restored.version, restored.n_train, restored.trained_through),
                         ("fair-rent-v2", len(self.train), self.train[-1].listing_date))
        for row in self.test[:20]:
            kwargs = dict(suburb=row.suburb, property_type=row.property_type, bedrooms=row.bedrooms,
                          bathrooms=row.bathrooms, car_spaces=row.car_spaces, lat=row.lat, lng=row.lng,
                          date_text=row.listing_date, gnaf=row.gnaf)
            self.assertAlmostEqual(restored.estimate(**kwargs).fair_rent, self.model.estimate(**kwargs).fair_rent, places=1)

    def test_loader_still_reads_v1(self):
        self.assertIsInstance(load_fair_rent_model(self.v1.to_json()), FairRentModel)

    def test_estimate_has_the_v1_shape_and_explains_its_evidence(self):
        row = next(item for item in self.test if normalize_gnaf(item.gnaf) in self.model.history.homes)
        estimate = self.model.estimate(suburb=row.suburb, property_type=row.property_type, bedrooms=row.bedrooms,
                                       lat=row.lat, lng=row.lng, date_text=row.listing_date, gnaf=row.gnaf)
        self.assertEqual(set(estimate.to_dict()), {"fair_rent", "hedonic_rent", "repeat_rent", "support", "level"})
        self.assertIn("boosted", estimate.level)
        self.assertGreater(estimate.fair_rent, 150)
        unknown = self.model.estimate(suburb="Nowhere", property_type=None, bedrooms=None)
        self.assertEqual((unknown.level, unknown.repeat_rent, unknown.support), ("boosted", None, 0))
        self.assertTrue(math.isfinite(unknown.fair_rent))

    def test_a_listing_does_not_value_itself(self):
        row = self.train[-1]
        overpriced = RentObservation(**{**row.__dict__, "weekly_rent": row.weekly_rent * 3.0, "gnaf": "GANSW424242",
                                        "lat": -33.70, "lng": 151.40})      # 一栋没有任何历史的新楼
        model = BoostedFairRent.fit(self.train + [overpriced], valid_days=0, repeat_weight=0.65, **self.params)
        kwargs = dict(suburb=overpriced.suburb, property_type=overpriced.property_type, bedrooms=overpriced.bedrooms,
                      bathrooms=overpriced.bathrooms, car_spaces=overpriced.car_spaces, lat=overpriced.lat,
                      lng=overpriced.lng, date_text=overpriced.listing_date, gnaf=overpriced.gnaf)
        clean = model.estimate(**kwargs).fair_rent
        leaked = model.estimate(**kwargs, exclude_same_date=False).fair_rent
        self.assertGreater(leaked, 1.5 * clean)       # 不扣除自身：估值被它自己的要价拉高
        self.assertLess(clean, 1.6 * row.weekly_rent)

    def test_feature_list_mismatch_is_rejected(self):
        payload = json.loads(self.model.to_json())
        payload["features"] = payload["features"][:-1]
        with self.assertRaises(ValueError):
            BoostedFairRent.from_json(json.dumps(payload))


class AreaFeaturesTest(unittest.TestCase):
    def areas(self):
        square = [[151.200, -33.880], [151.202, -33.880], [151.202, -33.878], [151.200, -33.878], [151.200, -33.880]]
        return AreaFeatures.from_mesh_blocks({"blocks": {"1": {"rings": [square], "income": 2000, "crime": 9000.5,
                                                               "livability": {"safety": 40, "hip": 90}}}})

    def test_lookup_inside_and_outside(self):
        areas = self.areas()
        inside = dict(zip(AREA_FEATURES, areas.lookup(-33.879, 151.201)))
        self.assertEqual((inside["mb_income"], inside["mb_crime"], inside["mb_safety"], inside["mb_hip"]),
                         (2000, 9000.5, 40, 90))
        self.assertIsNone(inside["mb_family"])
        self.assertEqual(areas.lookup(-33.870, 151.201), [None] * len(AREA_FEATURES))
        self.assertEqual(areas.lookup(None, 151.201), [None] * len(AREA_FEATURES))

    def test_model_with_areas_round_trips(self):
        rows = synthetic(n=500)
        model = BoostedFairRent.fit(rows, areas=self.areas(), valid_days=0, n_trees=10, max_depth=3)
        self.assertEqual(model.feature_names, FEATURES + AREA_FEATURES)
        restored = BoostedFairRent.from_json(model.to_json())
        kwargs = dict(suburb="Testville", property_type="Unit", bedrooms=1, lat=-33.879, lng=151.201)
        self.assertAlmostEqual(restored.estimate(**kwargs).fair_rent, model.estimate(**kwargs).fair_rent, places=1)


if __name__ == "__main__":
    unittest.main()
