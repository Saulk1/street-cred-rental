"""公平周租估算（Microburbs rent-history 训练，纯标准库，可序列化为 JSON）。

用途：给候选房源一个"同类房在这里通常租多少"的参照，排序器据此判断房源是否划算。
它不是成交价预测，只是挂牌租金的稳健基准；所有分层都做收缩，样本少的格子会回落到上一层。

模型（对数空间、加性）：
    log 租金 = 月份趋势
             + 卧室×类型 基准                （全局）
             + suburb×类型×卧室 偏移         （按样本数收缩到 0）
             + 卫生间 / 车位 偏移            （按卧室分组的残差中位数）
             + 约 250 m 网格的空间偏移       （按样本数收缩到 0）
若同一 GNAF 在训练窗口内挂过牌，再与"上次租金 × 期间指数涨幅"按权重混合（重复挂牌信号）。
"""

from __future__ import annotations

import csv
import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from statistics import median
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

FAIR_RENT_MODEL_VERSION = "fair-rent-v1"

GRID_DEG = 0.0025          # 约 250–280 m 一格
MAX_BEDS = 5               # 5 及以上并成一档
MIN_RENT, MAX_RENT = 150.0, 8000.0


@dataclass(frozen=True)
class RentObservation:
    suburb: str
    property_type: str
    bedrooms: Optional[int]
    bathrooms: Optional[float]
    car_spaces: Optional[float]
    weekly_rent: float
    listing_date: str            # YYYY-MM-DD
    lat: Optional[float] = None
    lng: Optional[float] = None
    gnaf: Optional[str] = None


@dataclass(frozen=True)
class FairRentEstimate:
    fair_rent: float
    hedonic_rent: float
    repeat_rent: Optional[float]
    support: int                 # 最细一层格子的样本量，供界面提示可信度
    level: str                   # 用到的最细分层

    def to_dict(self) -> Dict[str, Any]:
        return {"fair_rent": round(self.fair_rent, 1), "hedonic_rent": round(self.hedonic_rent, 1),
                "repeat_rent": None if self.repeat_rent is None else round(self.repeat_rent, 1),
                "support": self.support, "level": self.level}


def normalize_gnaf(gnaf: Optional[str]) -> Optional[str]:
    """房产编号统一成不带州前缀的数字串：在租接口给 "GANSW720418858"，租金历史里是 "720418858"。
    不统一的话两边永远对不上，重复挂牌信号在给实时房源估值时一次都用不上。"""
    if not gnaf:
        return None
    text = str(gnaf).strip()
    digits = text.lstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    return digits or text


def _type_key(property_type: Optional[str]) -> str:
    text = (property_type or "").strip().lower()
    if text in ("house", "townhouse"):
        return text
    return "unit"  # Unit / Studio / Apartment / Other 一律按公寓口径


def _beds_key(bedrooms: Optional[int]) -> str:
    if bedrooms is None:
        return "na"
    return str(min(int(bedrooms), MAX_BEDS))


def _month(date_text: str) -> str:
    return date_text[:7]


def _grid(lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    if lat is None or lng is None:
        return None
    return f"{math.floor(lat / GRID_DEG)}:{math.floor(lng / GRID_DEG)}"


def _bath_key(bedrooms: Optional[int], bathrooms: Optional[float]) -> Optional[str]:
    if bathrooms is None:
        return None
    return f"{_beds_key(bedrooms)}|{min(int(bathrooms), 3)}"


def _car_key(bedrooms: Optional[int], cars: Optional[float]) -> Optional[str]:
    if cars is None:
        return None
    return f"{_beds_key(bedrooms)}|{min(int(cars), 2)}"


def _shrunk_mean(values: Sequence[float], k: float) -> float:
    if not values:
        return 0.0
    return sum(values) / (len(values) + k)


@dataclass
class FairRentModel:
    """拟合结果全部是小字典，可 to_json / from_json，运行时不需要原始数据。"""

    month_index: Dict[str, float] = field(default_factory=dict)
    base: Dict[str, float] = field(default_factory=dict)          # type|beds
    base_n: Dict[str, int] = field(default_factory=dict)
    cell: Dict[str, float] = field(default_factory=dict)          # suburb|type|beds
    cell_n: Dict[str, int] = field(default_factory=dict)
    bath: Dict[str, float] = field(default_factory=dict)
    car: Dict[str, float] = field(default_factory=dict)
    grid: Dict[str, float] = field(default_factory=dict)
    grid_n: Dict[str, int] = field(default_factory=dict)
    last_seen: Dict[str, Tuple[float, str]] = field(default_factory=dict)  # gnaf -> (rent, date)
    repeat_weight: float = 0.8
    global_log: float = math.log(900.0)
    trained_through: str = ""
    n_train: int = 0
    version: str = FAIR_RENT_MODEL_VERSION

    # ------------------------------------------------------------------ fit
    @classmethod
    def fit(cls, rows: Iterable[RentObservation], *, k_cell: float = 8.0, k_grid: float = 15.0,
            repeat_weight: float = 0.8) -> "FairRentModel":
        data = [row for row in rows if MIN_RENT <= row.weekly_rent <= MAX_RENT]
        data.sort(key=lambda row: row.listing_date)
        model = cls(repeat_weight=repeat_weight)
        if not data:
            return model
        logs = [math.log(row.weekly_rent) for row in data]
        model.global_log = median(logs)
        model.n_train = len(data)
        model.trained_through = data[-1].listing_date

        # 1) 卧室×类型 基准（中位数，抗离群）
        groups: Dict[str, List[float]] = defaultdict(list)
        for row, value in zip(data, logs):
            groups[f"{_type_key(row.property_type)}|{_beds_key(row.bedrooms)}"].append(value)
        model.base = {key: median(values) for key, values in groups.items()}
        model.base_n = {key: len(values) for key, values in groups.items()}

        def base_of(row: RentObservation) -> float:
            return model.base.get(f"{_type_key(row.property_type)}|{_beds_key(row.bedrooms)}", model.global_log)

        # 2) 月份趋势：去掉结构差异后的月残差中位数，再做 3 个月滑动平均
        month_res: Dict[str, List[float]] = defaultdict(list)
        for row, value in zip(data, logs):
            month_res[_month(row.listing_date)].append(value - base_of(row))
        months = sorted(month_res)
        raw = {month: median(month_res[month]) if len(month_res[month]) >= 30 else None for month in months}
        anchor = median([value for value in raw.values() if value is not None] or [0.0])
        smoothed: Dict[str, float] = {}
        for index, month in enumerate(months):
            window = [raw[m] for m in months[max(0, index - 1): index + 2] if raw[m] is not None]
            smoothed[month] = (median(window) if window else anchor) - anchor
        model.month_index = smoothed

        def trend(row: RentObservation) -> float:
            return model.trend_for(row.listing_date)

        # 3) suburb×类型×卧室 偏移（收缩）
        residual = [value - base_of(row) - trend(row) for row, value in zip(data, logs)]
        cells: Dict[str, List[float]] = defaultdict(list)
        for row, value in zip(data, residual):
            cells[f"{row.suburb}|{_type_key(row.property_type)}|{_beds_key(row.bedrooms)}"].append(value)
        model.cell = {key: _shrunk_mean(values, k_cell) for key, values in cells.items()}
        model.cell_n = {key: len(values) for key, values in cells.items()}
        residual = [value - model.cell.get(f"{row.suburb}|{_type_key(row.property_type)}|{_beds_key(row.bedrooms)}", 0.0)
                    for row, value in zip(data, residual)]

        # 4) 卫生间 / 车位：同卧室数内的残差中位数（至少 20 个样本才采用）
        for attr, key_fn in (("bath", lambda r: _bath_key(r.bedrooms, r.bathrooms)),
                             ("car", lambda r: _car_key(r.bedrooms, r.car_spaces))):
            buckets: Dict[str, List[float]] = defaultdict(list)
            for row, value in zip(data, residual):
                key = key_fn(row)
                if key is not None:
                    buckets[key].append(value)
            table = {key: median(values) for key, values in buckets.items() if len(values) >= 20}
            setattr(model, attr, table)
            residual = [value - table.get(key_fn(row) or "", 0.0) for row, value in zip(data, residual)]

        # 5) 空间网格偏移（收缩）
        grids: Dict[str, List[float]] = defaultdict(list)
        for row, value in zip(data, residual):
            key = _grid(row.lat, row.lng)
            if key is not None:
                grids[key].append(value)
        model.grid = {key: _shrunk_mean(values, k_grid) for key, values in grids.items()}
        model.grid_n = {key: len(values) for key, values in grids.items()}

        # 6) 重复挂牌：每个 GNAF 最近一次租金
        for row in data:
            if row.gnaf:
                model.last_seen[normalize_gnaf(row.gnaf)] = (row.weekly_rent, row.listing_date)
        return model

    # -------------------------------------------------------------- predict
    def trend_for(self, date_text: Optional[str]) -> float:
        if not self.month_index:
            return 0.0
        if not date_text:
            return self.month_index[max(self.month_index)]
        month = _month(date_text)
        if month in self.month_index:
            return self.month_index[month]
        # 超出训练窗口：用最近一个月（不外推趋势）
        known = sorted(self.month_index)
        return self.month_index[known[-1] if month > known[-1] else known[0]]

    def hedonic_log(self, *, suburb: str, property_type: Optional[str], bedrooms: Optional[int],
                    bathrooms: Optional[float], car_spaces: Optional[float],
                    lat: Optional[float], lng: Optional[float], date_text: Optional[str]) -> Tuple[float, int, str]:
        type_key, beds_key = _type_key(property_type), _beds_key(bedrooms)
        base_key = f"{type_key}|{beds_key}"
        value = self.base.get(base_key)
        level, support = "type_beds", self.base_n.get(base_key, 0)
        if value is None:
            value, level, support = self.base.get(f"unit|{beds_key}", self.global_log), "beds", 0
        value += self.trend_for(date_text)
        cell_key = f"{suburb}|{type_key}|{beds_key}"
        if cell_key in self.cell:
            value += self.cell[cell_key]
            level, support = "suburb_type_beds", self.cell_n.get(cell_key, 0)
        value += self.bath.get(_bath_key(bedrooms, bathrooms) or "", 0.0)
        value += self.car.get(_car_key(bedrooms, car_spaces) or "", 0.0)
        grid_key = _grid(lat, lng)
        if grid_key is not None and grid_key in self.grid:
            value += self.grid[grid_key]
            level = level + "+grid"
        return value, support, level

    def estimate(self, *, suburb: str, property_type: Optional[str], bedrooms: Optional[int],
                 bathrooms: Optional[float] = None, car_spaces: Optional[float] = None,
                 lat: Optional[float] = None, lng: Optional[float] = None,
                 date_text: Optional[str] = None, gnaf: Optional[str] = None,
                 exclude_same_date: bool = True) -> FairRentEstimate:
        log_value, support, level = self.hedonic_log(
            suburb=suburb, property_type=property_type, bedrooms=bedrooms, bathrooms=bathrooms,
            car_spaces=car_spaces, lat=lat, lng=lng, date_text=date_text)
        hedonic = math.exp(log_value)
        repeat: Optional[float] = None
        seen = self.last_seen.get(normalize_gnaf(gnaf) or "")
        if seen is not None:
            prior_rent, prior_date = seen
            if not (exclude_same_date and date_text and prior_date >= date_text):
                repeat = prior_rent * math.exp(self.trend_for(date_text) - self.trend_for(prior_date))
        if repeat is None:
            return FairRentEstimate(hedonic, hedonic, None, support, level)
        blended = math.exp(self.repeat_weight * math.log(repeat) + (1 - self.repeat_weight) * log_value)
        return FairRentEstimate(blended, hedonic, repeat, support, level + "+repeat")

    # ------------------------------------------------------------- persist
    def to_json(self) -> str:
        payload = {key: getattr(self, key) for key in (
            "month_index", "base", "base_n", "cell", "cell_n", "bath", "car", "grid", "grid_n",
            "repeat_weight", "global_log", "trained_through", "n_train", "version")}
        payload["last_seen"] = {key: list(value) for key, value in self.last_seen.items()}
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    @classmethod
    def from_json(cls, text: str) -> "FairRentModel":
        payload = json.loads(text)
        payload["last_seen"] = {key: (float(v[0]), str(v[1])) for key, v in payload.get("last_seen", {}).items()}
        return cls(**payload)

    def fingerprint(self) -> str:
        from .types import sha256_fingerprint  # 避免循环导入
        return sha256_fingerprint({"version": self.version, "trained_through": self.trained_through,
                                   "n_train": self.n_train, "repeat_weight": self.repeat_weight})


# ------------------------------------------------------------------ IO
def _opt_float(text: str) -> Optional[float]:
    return float(text) if text not in ("", None) else None


def load_rent_history_csv(path: str) -> List[RentObservation]:
    """读取 scripts/fetch_microburbs.py 导出的 CSV（列见脚本），去掉同一 GNAF 同日重复挂牌。"""
    rows: List[RentObservation] = []
    seen = set()
    with open(path, newline="", encoding="utf-8") as handle:
        for record in csv.DictReader(handle):
            key = (record["gnaf"], record["date"])
            if key in seen:
                continue
            seen.add(key)
            beds = _opt_float(record["beds"])
            if beds is not None and beds > 8:
                continue  # 明显的整栋 / 录入错误
            rows.append(RentObservation(
                suburb=record["suburb"], property_type=record["ptype"],
                bedrooms=None if beds is None else int(beds),
                bathrooms=_opt_float(record["baths"]), car_spaces=_opt_float(record["cars"]),
                weekly_rent=float(record["rent"]), listing_date=record["date"],
                lat=_opt_float(record["lat"]), lng=_opt_float(record["lng"]),
                gnaf=record["gnaf"] or None))
    return rows
