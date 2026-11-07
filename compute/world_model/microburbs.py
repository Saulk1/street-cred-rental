"""Microburbs Hackathon API 适配层：把真实房源转成世界模型的 Listing。

口径说明（都会写进 listing.extra，便于审计）：
- API 的 transport / amenities 距离是**直线距离**（与坐标的球面距离一致）。世界模型要的是步行距离，
  这里按城市路网绕路系数估算：点估计 = 直线 × 1.30，误差带 = [直线 × 1.15, 直线 × 1.55 + 30 m]。
  distance_kind 记为 walking_estimated，规划器会用误差带两端检查决策是否稳健。
  系数未经本地标定；接入步行路线服务后应换成实测值（distance_kind = walking）。
- "train" 最近站包含轻轨站（API 标签统一为 Train station）。
- 超市：先用网格探针汇总 amenities 里 category = Supermarket 的坐标，再按球面距离取最近一家
  （amenities 单次最多 80 条，直接取会漏掉餐厅密集区 550 m 外的超市）。该类别含部分便利店，买菜时间可能偏乐观。
- 公平租金由 FairRentModel 估算后写入 extra["fair_rent"]，排序器只读这个字段。

客户端只用标准库 urllib；key 从环境变量 MICROBURBS_API_KEY 读取，不写进代码。
"""

from __future__ import annotations

import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .fair_rent import FairRentModel
from .transition import filter_feasible
from .types import (
    DATA_MODE_REAL,
    DISTANCE_KIND_WALKING_ESTIMATED,
    MAX_CANDIDATES,
    STATION_CONFIRMED,
    WALK_HIGH_KEY,
    WALK_LOW_KEY,
    Listing,
    StationWalkRequirement,
    UserState,
)

BASE_URL = "https://api-ht.microburbs.com.au"
API_KEY_ENV = "MICROBURBS_API_KEY"

DETOUR_POINT = 1.30
DETOUR_LOW = 1.15
DETOUR_HIGH = 1.55
ACCESS_PAD_M = 30.0
WALK_SPEED_M_PER_MIN = 80.0

# 价格合理性筛查（基于 2026-11 快照人工核对）：
# - 周租不到公平租金一半的，多是车位广告（$50–100、带车位、无单元号）或合租单间；
# - 6 卧以上却标成 Unit / Studio 的，多是寄宿屋整栋按间出租。
# 被标记的房源不进候选池，原因写在 extra["price_flag"]，供人工复核。
LOW_PRICE_RATIO = 0.5
HIGH_PRICE_RATIO = 3.0
BOARDING_MIN_BEDS = 6


# ---------------------------------------------------------------------------
# 房源描述 → 结构化特征（True / False / None=没写，None 绝不当成 False）
# ---------------------------------------------------------------------------
_PET_YES = re.compile(r"pets?\s+(are\s+)?(considered|allowed|welcome|permitted|ok|on application|upon application)"
                      r"|pet[- ]friendly(?!\s+parks?)|pet application|pets? negotiable")
_PET_NO = re.compile(r"no pets|pet[- ]free|pets?\s+(are\s+)?not\s+(allowed|permitted|accepted)|strictly no pet")
_FURN_NO = re.compile(r"unfurnished|un-furnished|not furnished")
_FURN_YES = re.compile(r"(fully|partly|partially|part|semi)[- ]furnished|furnished\s+(apartment|studio|unit|room|home|"
                       r"throughout|with)|comes furnished|is furnished|furniture (included|provided)")
_FURN_FAKE = re.compile(r"virtually (furnished|staged)|furnished for (display|illustration)")
_FEATURE_PATTERNS = {
    "aircon": re.compile(r"air[- ]?con|split[- ]system|ducted (air|reverse)|reverse[- ]cycle"),
    "dishwasher": re.compile(r"dishwasher"),
    "internal_laundry": re.compile(r"internal laundry|laundry (in|inside)|washing machine|washer"),
    "balcony": re.compile(r"balcon"),
    "gym": re.compile(r"\bgym"),
}


def listing_features(description: Optional[str], car_spaces: Optional[float] = None) -> Dict[str, Optional[bool]]:
    """从英文房源描述里识别宠物 / 家具 / 设施；描述没写的项一律是 None（未知）。"""
    text = (description or "").lower()
    pets: Optional[bool] = None
    if _PET_NO.search(text):
        pets = False
    elif _PET_YES.search(text):
        pets = True
    furnished: Optional[bool] = None
    cleaned = _FURN_FAKE.sub(" ", text)
    if _FURN_NO.search(cleaned):
        furnished = False
    elif _FURN_YES.search(cleaned):
        furnished = True
    features: Dict[str, Optional[bool]] = {"pets": pets, "furnished": furnished}
    for name, pattern in _FEATURE_PATTERNS.items():
        features[name] = True if (text and pattern.search(text)) else None
    features["parking"] = None if car_spaces is None else bool(car_spaces >= 1)
    features["has_description"] = bool(text)
    return features


def estimate_walk_m(straight_m: Optional[float]) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """直线距离 → (步行点估计, 下界, 上界)，单位米。"""
    if straight_m is None or straight_m < 0:
        return None, None, None
    straight = float(straight_m)
    return (round(straight * DETOUR_POINT, 1), round(straight * DETOUR_LOW, 1),
            round(straight * DETOUR_HIGH + ACCESS_PAD_M, 1))


def straight_to_walk_min(straight_m: Optional[float]) -> Optional[float]:
    point, _low, _high = estimate_walk_m(straight_m)
    return None if point is None else round(point / WALK_SPEED_M_PER_MIN, 1)


# ---------------------------------------------------------------------------
# 客户端
# ---------------------------------------------------------------------------
class MicroburbsError(RuntimeError):
    pass


class MicroburbsClient:
    """最小客户端：Bearer 认证、≤ 8 次/秒（API 上限 10）、429/5xx 退避重试、统一信封解包。"""

    def __init__(self, api_key: Optional[str] = None, *, base_url: str = BASE_URL,
                 max_rps: float = 8.0, timeout_s: float = 20.0) -> None:
        self.api_key = api_key or os.environ.get(API_KEY_ENV, "")
        if not self.api_key:
            raise MicroburbsError(f"缺少 API key：请设置环境变量 {API_KEY_ENV}")
        self.base_url = base_url.rstrip("/")
        self._min_interval = 1.0 / max_rps
        self._last = 0.0
        self.timeout_s = timeout_s

    def get(self, path: str, **params: Any) -> Any:
        query = {key: value for key, value in params.items() if value is not None}
        url = f"{self.base_url}{urllib.parse.quote(path)}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        for attempt in range(5):
            wait = self._min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            request = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.api_key}",
                                                           "Accept": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                return payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
            except urllib.error.HTTPError as error:
                if error.code in (429, 500, 502, 503, 504) and attempt < 4:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise MicroburbsError(f"GET {path} -> HTTP {error.code}") from error
        raise MicroburbsError(f"GET {path} 重试耗尽")

    # 便捷方法
    def suburbs(self) -> List[str]:
        return list(self.get("/v1/me")["area"]["suburbs"])

    def for_rent(self, suburb: str, limit: int = 1000) -> List[Dict[str, Any]]:
        data = self.get(f"/v1/suburbs/{suburb}/listings/for-rent", limit=limit) or {}
        return list(data.get("results") or [])

    def rent_history(self, suburb: str, from_date: str, page: int = 1000) -> Iterable[Dict[str, Any]]:
        if page <= 0:
            raise MicroburbsError(f"page 必须为正整数，收到 {page}")
        offset = 0
        while True:
            data = self.get(f"/v1/suburbs/{suburb}/listings/rent-history",
                            from_date=from_date, limit=page, offset=offset) or {}
            rows = data.get("results") or []
            if not rows:
                return
            yield from rows
            offset += len(rows)
            total = (data.get("meta") or {}).get("total")
            if len(rows) < page or (total is not None and offset >= int(total)):
                return

    def transport(self, gnaf_id: str) -> Dict[str, Any]:
        return self.get(f"/v1/properties/{gnaf_id}/transport/nearby", radius_m=2500) or {}

    def supermarket_map(self, probe_gnaf_ids: Iterable[str]) -> List[Dict[str, Any]]:
        """用一批"探针"房产调用 amenities，汇总所有 Supermarket 的坐标（去重）。

        amenities 每次最多返回 80 个最近设施（餐厅多的地方 550 m 外的超市会被挤掉），
        所以不能直接拿它当"最近超市"；探针按约 200 m 网格铺开，任何超市都离某个探针很近。
        """
        found: Dict[str, Dict[str, Any]] = {}
        for gnaf_id in probe_gnaf_ids:
            data = self.get(f"/v1/properties/{gnaf_id}/amenities/nearby", radius_m=1500) or {}
            for item in data.get("results") or []:
                if str(item.get("category", "")).lower() == "supermarket" and item.get("lat") is not None:
                    key = f"{item.get('name')}|{float(item['lat']):.5f}|{float(item['lng']):.5f}"
                    found[key] = {"name": item.get("name"), "lat": float(item["lat"]), "lng": float(item["lng"])}
        return sorted(found.values(), key=lambda item: (item["lat"], item["lng"], item["name"] or ""))


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


def nearest_supermarket(lat: Optional[float], lng: Optional[float],
                        supermarkets: Sequence[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    if lat is None or lng is None or not supermarkets:
        return None
    best = min(supermarkets, key=lambda item: haversine_m(lat, lng, item["lat"], item["lng"]))
    return {"name": best.get("name"), "distance_m": round(haversine_m(lat, lng, best["lat"], best["lng"]))}


def enrichment_from_responses(transport: Mapping[str, Any], amenities: Optional[Mapping[str, Any]] = None,
                              *, supermarkets: Optional[Sequence[Mapping[str, Any]]] = None,
                              lat: Optional[float] = None, lng: Optional[float] = None) -> Dict[str, Any]:
    """组装一套房的交通与买菜信息。

    超市优先用汇总后的超市地图（supermarkets + 坐标）算最近一家；没有地图时才退回
    amenities 列表里的最近超市——后者可能因为 80 条上限漏掉稍远的超市。
    """
    nearest = (transport or {}).get("nearest") or {}
    station = nearest.get("train")
    market: Optional[Dict[str, Any]] = None
    if supermarkets:
        market = nearest_supermarket(lat if lat is not None else (transport or {}).get("center_lat"),
                                     lng if lng is not None else (transport or {}).get("center_lng"), supermarkets)
    elif amenities:
        listed = [item for item in amenities.get("results") or []
                  if str(item.get("category", "")).lower() == "supermarket" and item.get("distance_m") is not None]
        listed.sort(key=lambda item: item["distance_m"])
        if listed:
            market = {"name": listed[0].get("name"), "distance_m": listed[0]["distance_m"]}
    return {
        "train": {"name": station.get("name"), "distance_m": station.get("distance_m")} if station else None,
        "bus_m": (nearest.get("bus") or {}).get("distance_m"),
        "supermarket": market,
    }


# ---------------------------------------------------------------------------
# 转换
# ---------------------------------------------------------------------------
def listing_from_microburbs(row: Mapping[str, Any], enrichment: Optional[Mapping[str, Any]],
                            fair_model: Optional[FairRentModel] = None,
                            collected_at: Optional[str] = None) -> Listing:
    """for-rent 结果 + 交通/设施 → Listing。缺什么就留 None，绝不补 0。"""
    attrs = row.get("attributes") or {}
    address = row.get("address") or {}
    coords = row.get("coordinates") or {}
    suburb = address.get("sal") or row.get("suburb")
    beds = attrs.get("bedrooms")
    bedrooms = None if beds is None else int(beds)
    cars = attrs.get("garage_spaces", attrs.get("car_spaces"))
    station = (enrichment or {}).get("train")
    station_straight = None if not station else station.get("distance_m")
    walk, walk_low, walk_high = estimate_walk_m(station_straight)
    market = (enrichment or {}).get("supermarket")
    market_min = straight_to_walk_min(None if not market else market.get("distance_m"))

    extra: Dict[str, Any] = {
        "gnaf_id": row.get("gnaf_pid"),
        "address": address.get("street") or row.get("area_name"),
        "property_type": row.get("property_type"),
        "bathrooms": attrs.get("bathrooms"),
        "car_spaces": cars,
        "lat": coords.get("latitude"),
        "lng": coords.get("longitude"),
        "listing_date": row.get("listing_date"),
        "station_name": None if not station else station.get("name"),
        "station_straight_m": station_straight,
        "supermarket_name": None if not market else market.get("name"),
        "distance_method": f"straight×{DETOUR_POINT} (band ×{DETOUR_LOW}–×{DETOUR_HIGH}+{int(ACCESS_PAD_M)}m)",
        "features": listing_features(attrs.get("description"), cars),
    }
    if walk is not None:
        extra[WALK_LOW_KEY] = walk_low
        extra[WALK_HIGH_KEY] = walk_high
    if fair_model is not None and suburb:
        estimate = fair_model.estimate(
            suburb=suburb, property_type=row.get("property_type"), bedrooms=bedrooms,
            bathrooms=attrs.get("bathrooms"), car_spaces=cars,
            lat=coords.get("latitude"), lng=coords.get("longitude"),
            date_text=row.get("listing_date"), gnaf=row.get("gnaf_pid"))
        extra["fair_rent"] = round(estimate.fair_rent, 1)
        extra["fair_rent_detail"] = estimate.to_dict()
        extra["fair_rent_model"] = fair_model.version
    rent = row.get("price", row.get("weekly_rent"))
    extra["price_flag"] = price_flag(None if rent is None else float(rent), extra.get("fair_rent"),
                                     bedrooms, row.get("property_type"))
    return Listing(
        listing_id=str(row.get("gnaf_pid")),
        station_walk_m=walk,
        distance_kind=DISTANCE_KIND_WALKING_ESTIMATED,
        weekly_rent=None if rent is None else float(rent),
        bedrooms=bedrooms,
        district=suburb,
        supermarket_walk_min=market_min,
        source=DATA_MODE_REAL,
        collected_at=collected_at,
        extra=extra,
    )


def price_flag(rent: Optional[float], fair_rent: Optional[float], bedrooms: Optional[int],
               property_type: Optional[str]) -> Optional[str]:
    """返回 None（看起来正常）或一个可读的标记。"""
    if rent is None:
        return "missing_rent"
    if bedrooms is not None and bedrooms >= BOARDING_MIN_BEDS and (property_type or "").lower() in ("unit", "studio"):
        return "likely_boarding_house"
    if fair_rent:
        ratio = rent / float(fair_rent)
        if ratio < LOW_PRICE_RATIO:
            return "implausibly_low_vs_fair_rent"
        if ratio > HIGH_PRICE_RATIO:
            return "implausibly_high_vs_fair_rent"
    return None


def build_candidate_pool(state: UserState, listings: Sequence[Listing], ranker: Any,
                         max_candidates: int = MAX_CANDIDATES) -> Tuple[Listing, ...]:
    """模拟"现有系统"给出的候选池：按已确认硬要求（不含车站）过滤，再按排序器取前 N 套。

    车站要求故意不参与筛选——那正是世界模型要决定问不问的维度。缺车站距离或被价格筛查
    标记的房源剔除，避免整池因为一条脏数据被判 needs_data，或被车位广告"捡漏"。
    """
    open_state = state.with_station_walk(StationWalkRequirement(status=STATION_CONFIRMED, max_m=None))
    feasible = [listing for listing in filter_feasible(open_state, listings)
                if listing.station_walk_m is not None and not listing.extra.get("price_flag")]
    ordered = ranker.rank(open_state, feasible, ranker.snapshot_id)
    by_id = {listing.listing_id: listing for listing in feasible}
    return tuple(by_id[listing_id] for listing_id in ordered[:max_candidates])
