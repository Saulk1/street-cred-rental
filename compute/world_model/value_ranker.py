"""基于公平租金的只读推荐器（真实数据版，替换 FixedRanker 桩）。

分数越低越好，单位统一成"分"：
    价格分 = w_value × (周租 / 公平租金 − 1) × 100     # 比同类贵 1% 记 w_value 分
    买菜分 = w_groceries × 超市步行分钟
默认 w_value = 1、w_groceries = 1：便宜 5% 约等于超市近 5 分钟。
soft_preferences.emphasis = "groceries" 时买菜权重 ×3；= "value" 时价格权重 ×2。
折扣封顶 40%（见 MAX_DISCOUNT_PCT）。

公平租金不在这里算：由数据层（microburbs 适配器）预先写进 listing.extra["fair_rent"]，
排序器只读字段，保持毫秒级与确定性；分数相同按 listing_id 升序。
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import math

from .types import Listing, RankingContractError, UserState, sha256_fingerprint

FAIR_RENT_KEY = "fair_rent"
MISSING_PENALTY = 1.0e6
# 比同类便宜超过 40% 一律按 40% 计：更大的"折扣"多半是数据问题（车位、单间），不该无限加分。
MAX_DISCOUNT_PCT = 40.0

DEFAULT_VALUE_WEIGHTS: Dict[str, float] = {"value": 1.0, "groceries": 1.0, "station": 0.0, "commute": 1.0}
# 通勤：每公里（估算步行）8 分；车站软偏好：每 100 米 1 × station 权重（默认 0，靠反馈学）
COMMUTE_POINTS_PER_KM = 8.0
COMMUTE_DETOUR = 1.30
STATION_POINTS_PER_100M = 1.0
# 用户需要某项（宠物 / 家具 / 车位）但房源描述没写：扣 18 分，使明确满足（True）的房源优先于未写明（None）房源
UNKNOWN_NEED_PENALTY = 18.0
EMPHASIS_MULTIPLIERS: Dict[str, Dict[str, float]] = {
    "groceries": {"groceries": 3.0},
    "value": {"value": 2.0},
}


class ValueRanker:
    """按 (价格分 + 买菜分, listing_id) 排序；只读、确定性。"""

    def __init__(self, snapshot_id: str, *, weights: Optional[Mapping[str, float]] = None,
                 model_fingerprint: str = "") -> None:
        self.snapshot_id = snapshot_id
        self._weights = dict(DEFAULT_VALUE_WEIGHTS if weights is None else weights)
        self._model_fingerprint = model_fingerprint

    def params(self) -> Dict[str, Any]:
        return {"weights": dict(self._weights), "snapshot_id": self.snapshot_id,
                "fair_rent_model": self._model_fingerprint}

    def params_fingerprint(self) -> str:
        return sha256_fingerprint(self.params())

    def _weights_for(self, state: UserState) -> Dict[str, float]:
        weights = dict(self._weights)
        emphasis = str(state.soft_preferences.get("emphasis", "")).lower()
        for key, factor in EMPHASIS_MULTIPLIERS.get(emphasis, {}).items():
            weights[key] = weights.get(key, 0.0) * factor
        adjust = state.soft_preferences.get("weight_adjust") or {}
        for key, factor in adjust.items():
            if key in weights:
                weights[key] = weights[key] * float(factor)
        # 车站权重默认 0，乘法学不出来；反馈要求"车站近一点"时给一个起步值
        if "station" in adjust and weights.get("station", 0.0) == 0.0:
            weights["station"] = 0.5 * float(adjust["station"])
        return weights

    def score_breakdown(self, state: UserState, listing: Listing) -> Dict[str, float]:
        weights = self._weights_for(state)
        fair = listing.extra.get(FAIR_RENT_KEY)
        if listing.weekly_rent is None or fair in (None, 0):
            value = MISSING_PENALTY
            gap_pct = None
        else:
            gap_pct = (float(listing.weekly_rent) / float(fair) - 1.0) * 100.0
            value = weights.get("value", 0.0) * max(gap_pct, -MAX_DISCOUNT_PCT)
        minutes = listing.supermarket_walk_min
        groceries = MISSING_PENALTY if minutes is None else weights.get("groceries", 0.0) * float(minutes)

        station = 0.0
        if weights.get("station", 0.0) and listing.station_walk_m is not None:
            station = weights["station"] * STATION_POINTS_PER_100M * float(listing.station_walk_m) / 100.0

        commute = 0.0
        commute_km = commute_distance_km(state, listing)
        if commute_km is not None:
            commute = weights.get("commute", 0.0) * COMMUTE_POINTS_PER_KM * commute_km

        unknown_needs = []
        needs = state.other_confirmed.get("needs") or {}
        features = listing.extra.get("features") or {}
        for key in ("pets", "furnished", "parking"):
            if needs.get(key) is True and features.get(key) is None:
                unknown_needs.append(key)
        unknown = UNKNOWN_NEED_PENALTY * len(unknown_needs)

        total = value + groceries + station + commute + unknown
        return {"value": value, "groceries": groceries, "station": station, "commute": commute,
                "unknown_needs": unknown, "total": total,
                "gap_pct": gap_pct if gap_pct is not None else float("nan"),
                "commute_km": commute_km if commute_km is not None else float("nan"),
                "unknown_need_keys": unknown_needs}

    def score(self, state: UserState, listing: Listing) -> float:
        return self._total(state, listing)

    def _total(self, state: UserState, listing: Listing) -> float:
        return float(self.score_breakdown(state, listing)["total"])

    def rank(self, state: UserState, candidates: Sequence[Listing], snapshot_id: str) -> List[str]:
        if snapshot_id != self.snapshot_id:
            raise RankingContractError(
                f"ranker snapshot 不匹配：请求 {snapshot_id}，实际 {self.snapshot_id}"
            )
        pool: Tuple[Listing, ...] = tuple(candidates)
        scored = sorted(pool, key=lambda item: (round(self.score(state, item), 9), item.listing_id))
        return [listing.listing_id for listing in scored]


def commute_distance_km(state: UserState, listing: Listing) -> Optional[float]:
    """用户设了通勤目的地时，房源到目的地的估算步行距离（km）；未设或缺坐标返回 None。"""
    from .needs import COMMUTE_NONE, DESTINATIONS  # 避免循环导入
    key = state.soft_preferences.get("commute_to")
    if not key or key == COMMUTE_NONE or key not in DESTINATIONS:
        return None
    lat, lng = listing.extra.get("lat"), listing.extra.get("lng")
    if lat is None or lng is None:
        return 5.0  # 缺坐标：按 5 km 计，避免"没数据反而最近"
    dest = DESTINATIONS[key]
    p1, p2 = math.radians(float(lat)), math.radians(dest["lat"])
    dp, dl = p2 - p1, math.radians(dest["lng"] - float(lng))
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * 6371.0088 * math.asin(math.sqrt(h)) * COMMUTE_DETOUR, 3)
