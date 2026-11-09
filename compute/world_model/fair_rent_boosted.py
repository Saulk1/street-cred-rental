"""公平周租 v2：在 v1 的"月份趋势 + 卧室×类型基准"之上，用梯度提升树学残差。

    log 租金 = 月份趋势 + 卧室×类型基准 + 提升树(特征)
若这套房以前以同样的卧室数挂过牌，再与"上次的残差"按 repeat_weight 混合（权重在验证窗口上选）。

特征除了房源自身属性和坐标，主要是"只用过去数据"的历史统计（时间感知的目标编码）：
    同一套房上次挂牌的残差与间隔、同一栋楼 / 同楼同卧室数 / suburb×类型×卧室 / 250 m 网格的历史平均残差与样本数。
训练时按日期逐日前滚：先用当时已有的历史给当天的样本算特征，再把当天样本记入历史，
因此训练特征与上线预测时的特征口径一致，不会用到未来的租金。

给当前在租房源估值时，如果它自己的这条挂牌已经在历史里，会先把它从各项统计中扣除（留一），
否则"公平租金"会被它自己的要价拉过去，折扣会被低估。

和 v1 一样：这是挂牌租金的基准，不是成交价；趋势不外推，超出训练窗口用最后一个月。
"""

from __future__ import annotations

import json
import math
from datetime import date
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .boosting import BoostedTrees
from .fair_rent import (MAX_RENT, MIN_RENT, FairRentEstimate, FairRentModel, RentObservation, _beds_key, _grid,
                        _type_key, normalize_gnaf)

BOOSTED_VERSION = "fair-rent-v2"
BURN_IN_DAYS = 180            # 训练集跳过最早半年：那时历史统计还是空的，和上线时的分布不一样
TARGET_CLIP = 1.2
GROUPS = ("bld", "bldbeds", "cell", "grid", "sub")
FEATURES = ("beds", "baths", "cars", "type", "lat", "lng", "lat_plus_lng", "lat_minus_lng", "base",
            "prev_res", "prev_gap_days", "prev_count", "prev2_res", "prev_same_beds",
            "bld_mean", "bld_n", "bldbeds_mean", "bldbeds_n", "cell_mean", "cell_n", "grid_mean", "grid_n", "sub_mean")
_TYPE_CODES = {"unit": 0.0, "apartment": 0.0, "studio": 1.0, "townhouse": 2.0, "house": 3.0}
_PREV_RES, _PREV_SAME_BEDS = FEATURES.index("prev_res"), FEATURES.index("prev_same_beds")


def _ordinal(text: str) -> int:
    return date.fromisoformat(text[:10]).toordinal()


def _keys(suburb: str, property_type: Optional[str], bedrooms: Optional[int],
          lat: Optional[float], lng: Optional[float]) -> Dict[str, Optional[str]]:
    beds, kind = _beds_key(bedrooms), _type_key(property_type)
    building = None if lat is None or lng is None else f"{round(lat, 4):.4f}:{round(lng, 4):.4f}"
    return {"bld": building, "bldbeds": None if building is None else f"{building}|{beds}",
            "cell": f"{suburb}|{kind}|{beds}", "grid": _grid(lat, lng), "sub": f"{suburb}|{kind}"}


LIVABILITY = ("affluence", "lifestyle", "hip", "convenience", "family", "safety", "tranquility")
AREA_FEATURES = ("mb_income", "mb_crime") + tuple("mb_" + name for name in LIVABILITY)


class AreaFeatures:
    """网格（mesh block）级的非价格属性：收入、犯罪率、七项宜居度。按坐标落在哪个网格取值。

    数据来自 scripts/fetch-mesh-block-features.py；都不是由租金算出来的，不会泄露目标。
    这些是抓取当时的静态值，用于两年历史时视为不随时间变化。
    """

    def __init__(self, blocks: Sequence[Dict[str, Any]]) -> None:
        self.blocks = list(blocks)             # {"rings": [[[lng, lat], ...]], "values": [...]}
        self._index: Dict[Tuple[int, int], List[int]] = {}
        self._cache: Dict[Tuple[float, float], List[Optional[float]]] = {}
        for number, block in enumerate(self.blocks):
            for ring in block["rings"]:
                lngs, lats = [point[0] for point in ring], [point[1] for point in ring]
                for i in range(math.floor(min(lats) / _CELL), math.floor(max(lats) / _CELL) + 1):
                    for j in range(math.floor(min(lngs) / _CELL), math.floor(max(lngs) / _CELL) + 1):
                        self._index.setdefault((i, j), []).append(number)

    @classmethod
    def from_mesh_blocks(cls, payload: Dict[str, Any]) -> "AreaFeatures":
        blocks = []
        for block in payload["blocks"].values():
            scores = block.get("livability") or {}
            blocks.append({"rings": block["rings"],
                           "values": [block.get("income"), block.get("crime")] + [scores.get(name) for name in LIVABILITY]})
        return cls(blocks)

    def lookup(self, lat: Optional[float], lng: Optional[float]) -> List[Optional[float]]:
        if lat is None or lng is None:
            return [None] * len(AREA_FEATURES)
        key = (round(lat, 5), round(lng, 5))
        if key not in self._cache:
            found: List[Optional[float]] = [None] * len(AREA_FEATURES)
            for number in self._index.get((math.floor(lat / _CELL), math.floor(lng / _CELL)), ()):
                if any(_inside(lng, lat, ring) for ring in self.blocks[number]["rings"]):
                    found = list(self.blocks[number]["values"])
                    break
            self._cache[key] = found
        return self._cache[key]

    def to_dict(self) -> Dict[str, Any]:
        return {"names": list(AREA_FEATURES), "blocks": self.blocks}


_CELL = 0.0025


def _inside(x: float, y: float, ring: Sequence[Sequence[float]]) -> bool:
    """射线法：点 (x, y) 是否在多边形内。"""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi, xj, yj = ring[i][0], ring[i][1], ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class History:
    """到某一天为止的历史统计。只做加法；留一扣除在读取时处理。"""

    def __init__(self, groups: Optional[Dict[str, Dict[str, List[float]]]] = None,
                 homes: Optional[Dict[str, List[Any]]] = None) -> None:
        self.groups: Dict[str, Dict[str, List[float]]] = groups or {name: {} for name in GROUPS}
        self.homes: Dict[str, List[Any]] = homes or {}      # gnaf -> [次数, 最近一条, 再上一条]

    def add(self, gnaf: Optional[str], keys: Dict[str, Optional[str]], residual: float, day: int, beds: str) -> None:
        for name in GROUPS:
            key = keys[name]
            if key is not None:
                cell = self.groups[name].setdefault(key, [0.0, 0])
                cell[0] += residual
                cell[1] += 1
        gnaf = normalize_gnaf(gnaf)
        if gnaf:
            record = [round(residual, 5), day, beds, keys["bld"], keys["cell"], keys["grid"], keys["sub"]]
            entry = self.homes.setdefault(gnaf, [0, None, None])
            entry[0] += 1
            entry[2], entry[1] = entry[1], record

    def features(self, *, suburb: str, property_type: Optional[str], bedrooms: Optional[int],
                 bathrooms: Optional[float], car_spaces: Optional[float], lat: Optional[float], lng: Optional[float],
                 gnaf: Optional[str], day: int, base: float, leave_own_out: bool) -> Tuple[List[Optional[float]], int]:
        keys = _keys(suburb, property_type, bedrooms, lat, lng)
        beds = _beds_key(bedrooms)
        entry = self.homes.get(normalize_gnaf(gnaf) or "")
        count, prior, older, own = 0, None, None, None
        if entry is not None:
            count, prior, older = entry[0], entry[1], entry[2]
            if leave_own_out and prior is not None and prior[1] >= day:
                own, prior, older, count = prior, older, None, count - 1   # 最近一条就是这次挂牌本身

        def stat(name: str) -> Tuple[Optional[float], float]:
            key = keys[name]
            if own is not None and name != "bldbeds":
                key = own[{"bld": 3, "cell": 4, "grid": 5, "sub": 6}[name]] or key
            elif own is not None and own[3] is not None:
                key = f"{own[3]}|{own[2]}"
            cell = self.groups[name].get(key or "")
            if cell is None:
                return None, 0.0
            total, n = cell[0], cell[1]
            if own is not None:
                total, n = total - own[0], n - 1
            return (total / n if n > 0 else None), float(max(n, 0))

        kind = (property_type or "").strip().lower()
        row: List[Optional[float]] = [
            None if bedrooms is None else float(min(bedrooms, 6)),
            None if bathrooms is None else float(min(bathrooms, 4)),
            None if car_spaces is None else float(min(car_spaces, 3)),
            _TYPE_CODES.get(kind, 4.0), lat, lng,
            None if lat is None or lng is None else lat + lng,
            None if lat is None or lng is None else lat - lng,
            base,
            None if prior is None else prior[0],
            None if prior is None else float(min(day - prior[1], 1500)),
            float(count),
            None if older is None else older[0],
            None if prior is None else float(prior[2] == beds),
        ]
        support = 0
        for name in GROUPS:
            mean, n = stat(name)
            row.append(mean)
            if name != "sub":
                row.append(n)
            if name == "bldbeds":
                support = int(n)
        return row, support

    def to_dict(self) -> Dict[str, Any]:
        return {"groups": {name: {key: [round(cell[0], 5), cell[1]] for key, cell in table.items()}
                           for name, table in self.groups.items()}, "homes": self.homes}


class BoostedFairRent:
    """与 FairRentModel 相同的 estimate / to_json / from_json / fingerprint 接口，可直接替换。"""

    def __init__(self, base: FairRentModel, booster: BoostedTrees, history: History,
                 trained_through: str = "", n_train: int = 0, version: str = BOOSTED_VERSION,
                 repeat_weight: float = 0.0, areas: Optional[AreaFeatures] = None) -> None:
        self.base, self.booster, self.history = base, booster, history
        self.trained_through, self.n_train, self.version = trained_through, n_train, version
        self.repeat_weight = repeat_weight
        self.areas = areas

    @property
    def feature_names(self) -> Tuple[str, ...]:
        return FEATURES + (AREA_FEATURES if self.areas is not None else ())

    def _area(self, lat: Optional[float], lng: Optional[float]) -> List[Optional[float]]:
        return [] if self.areas is None else self.areas.lookup(lat, lng)

    def _blend(self, features: Sequence[Optional[float]]) -> float:
        """提升树的残差；同一套房、同样卧室数挂过牌时，与上次的残差混合。"""
        boosted = self.booster.predict(features)
        prior, same_beds = features[_PREV_RES], features[_PREV_SAME_BEDS]
        if prior is None or not same_beds or not self.repeat_weight:
            return boosted
        return self.repeat_weight * prior + (1.0 - self.repeat_weight) * boosted

    # ------------------------------------------------------------------ fit
    def _base_log(self, property_type: Optional[str], bedrooms: Optional[int]) -> float:
        beds = _beds_key(bedrooms)
        value = self.base.base.get(f"{_type_key(property_type)}|{beds}")
        return self.base.base.get(f"unit|{beds}", self.base.global_log) if value is None else value

    def _residual(self, row: RentObservation) -> float:
        return (math.log(row.weekly_rent) - self.base.trend_for(row.listing_date)
                - self._base_log(row.property_type, row.bedrooms))

    def _walk(self, rows: Sequence[RentObservation]) -> List[Tuple[List[Optional[float]], float, int]]:
        """按日期前滚：同一天的样本互相看不到。返回 (特征, 残差, 日期序号)，并把这些样本记入历史。"""
        out: List[Tuple[List[Optional[float]], float, int]] = []
        ordered = sorted(rows, key=lambda row: row.listing_date)
        start = 0
        while start < len(ordered):
            end = start
            while end < len(ordered) and ordered[end].listing_date == ordered[start].listing_date:
                end += 1
            day = _ordinal(ordered[start].listing_date)
            batch = ordered[start:end]
            for row in batch:
                features, _support = self.history.features(
                    suburb=row.suburb, property_type=row.property_type, bedrooms=row.bedrooms, bathrooms=row.bathrooms,
                    car_spaces=row.car_spaces, lat=row.lat, lng=row.lng, gnaf=row.gnaf, day=day,
                    base=self._base_log(row.property_type, row.bedrooms), leave_own_out=False)
                out.append((features + self._area(row.lat, row.lng), self._residual(row), day))
            for row in batch:
                self.history.add(row.gnaf, _keys(row.suburb, row.property_type, row.bedrooms, row.lat, row.lng),
                                 self._residual(row), day, _beds_key(row.bedrooms))
            start = end
        return out

    @classmethod
    def fit(cls, rows: Iterable[RentObservation], *, valid_days: int = 90, log: Any = None,
            repeat_weight: Optional[float] = None, areas: Optional[AreaFeatures] = None,
            **params: Any) -> "BoostedFairRent":
        """valid_days > 0：留出训练窗口最后若干天做早停，并在其上选 repeat_weight。
        valid_days = 0：用给定的 n_trees 和 repeat_weight 全量训练。"""
        data = sorted((row for row in rows if MIN_RENT <= row.weekly_rent <= MAX_RENT), key=lambda row: row.listing_date)
        base = FairRentModel.fit(data)
        base.last_seen = {}                    # v2 用自己的历史，不需要 v1 的重复挂牌表
        model = cls(base, BoostedTrees([]), History(), data[-1].listing_date, len(data), areas=areas)
        walked = model._walk(data)
        first, last = walked[0][2], walked[-1][2]
        usable = [item for item in walked if item[2] >= first + BURN_IN_DAYS]
        clip = lambda value: max(-TARGET_CLIP, min(TARGET_CLIP, value))  # noqa: E731
        if valid_days:
            split = last - valid_days
            train = [item for item in usable if item[2] <= split]
            valid = [item for item in usable if item[2] > split]
            model.booster = BoostedTrees.fit([item[0] for item in train], [clip(item[1]) for item in train],
                                             valid=([item[0] for item in valid], [item[1] for item in valid]),
                                             log=log, **params)
            if repeat_weight is None:
                boosted = [(item, model.booster.predict(item[0])) for item in valid
                           if item[0][_PREV_RES] is not None and item[0][_PREV_SAME_BEDS]]

                def loss(weight: float) -> float:
                    return sum(abs(item[1] - (weight * item[0][_PREV_RES] + (1 - weight) * value))
                               for item, value in boosted) / max(1, len(boosted))
                repeat_weight = min((step / 20.0 for step in range(0, 20)), key=lambda weight: (loss(weight), weight))
                if log:
                    log(f"  repeat weight {repeat_weight:.2f} chosen on {len(boosted)} validation listings "
                        f"(MAE(log) {loss(repeat_weight):.4f}; trees only {loss(0.0):.4f})")
        else:
            model.booster = BoostedTrees.fit([item[0] for item in usable], [clip(item[1]) for item in usable],
                                             log=log, **params)
        model.repeat_weight = float(repeat_weight or 0.0)
        return model

    def walk_forward(self, rows: Sequence[RentObservation]) -> List[Tuple[RentObservation, float]]:
        """回测用：按日期前滚预测 rows（每条只用它之前的历史），并把它们记入历史。"""
        ordered = sorted(rows, key=lambda row: row.listing_date)
        walked = self._walk(ordered)
        return [(row, math.exp(self.base.trend_for(row.listing_date) + self._base_log(row.property_type, row.bedrooms)
                               + self._blend(features)))
                for row, (features, _residual, _day) in zip(ordered, walked)]

    # -------------------------------------------------------------- predict
    def estimate(self, *, suburb: str, property_type: Optional[str], bedrooms: Optional[int],
                 bathrooms: Optional[float] = None, car_spaces: Optional[float] = None,
                 lat: Optional[float] = None, lng: Optional[float] = None,
                 date_text: Optional[str] = None, gnaf: Optional[str] = None,
                 exclude_same_date: bool = True) -> FairRentEstimate:
        day = _ordinal(date_text) if date_text else _ordinal(self.trained_through) + 1
        base = self._base_log(property_type, bedrooms)
        features, support = self.history.features(
            suburb=suburb, property_type=property_type, bedrooms=bedrooms, bathrooms=bathrooms, car_spaces=car_spaces,
            lat=lat, lng=lng, gnaf=gnaf, day=day, base=base, leave_own_out=exclude_same_date)
        features = features + self._area(lat, lng)
        trend = self.base.trend_for(date_text)
        fair = math.exp(trend + base + self._blend(features))
        hedonic = self.base.estimate(suburb=suburb, property_type=property_type, bedrooms=bedrooms, bathrooms=bathrooms,
                                     car_spaces=car_spaces, lat=lat, lng=lng, date_text=date_text).hedonic_rent
        prior = features[_PREV_RES]
        repeat = None if prior is None else math.exp(trend + base + prior)
        level = "boosted" + ("+repeat" if repeat is not None else "") + ("+building" if support else "")
        return FairRentEstimate(fair, hedonic, repeat, support, level)

    # ------------------------------------------------------------- persist
    def to_json(self) -> str:
        return json.dumps({"version": self.version, "trained_through": self.trained_through, "n_train": self.n_train,
                           "repeat_weight": self.repeat_weight,
                           "areas": None if self.areas is None else self.areas.to_dict(),
                           "features": list(self.feature_names), "base": json.loads(self.base.to_json()),
                           "booster": self.booster.to_dict(), "history": self.history.to_dict()},
                          ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    @classmethod
    def from_json(cls, text: str) -> "BoostedFairRent":
        payload = json.loads(text)
        areas = payload.get("areas")
        expected = list(FEATURES) + (list(AREA_FEATURES) if areas else [])
        if payload.get("features") != expected or (areas and areas.get("names") != list(AREA_FEATURES)):
            raise ValueError("fair rent model was fitted with a different feature list")
        history = History(payload["history"]["groups"], payload["history"]["homes"])
        return cls(FairRentModel.from_json(json.dumps(payload["base"])), BoostedTrees.from_dict(payload["booster"]),
                   history, payload["trained_through"], payload["n_train"], payload["version"],
                   payload.get("repeat_weight", 0.0), AreaFeatures(areas["blocks"]) if areas else None)

    def fingerprint(self) -> str:
        from .types import sha256_fingerprint  # 避免循环导入
        return sha256_fingerprint({"version": self.version, "trained_through": self.trained_through,
                                   "n_train": self.n_train, "trees": len(self.booster.trees),
                                   "repeat_weight": self.repeat_weight, "features": list(self.feature_names)})


def load_fair_rent_model(text: str) -> Any:
    """按 JSON 里的 version 读出 v1 或 v2；两者的 estimate 接口相同。"""
    version = json.loads(text).get("version", "")
    return BoostedFairRent.from_json(text) if version == BOOSTED_VERSION else FairRentModel.from_json(text)
