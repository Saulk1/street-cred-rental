"""用户需求：从用户自己的话里抽取条件，并以补丁形式写入档案（方向②、④）。

档案里的存放位置（不与 v0.1 已有字段冲突）：
    other_confirmed["needs"]              {"pets": bool, "furnished": bool, "parking": bool}
    other_confirmed["excluded_districts"] [suburb, ...]
    other_confirmed["budget_stretch_pct"] 允许超出预算的百分比（0 = 严格）
    soft_preferences["commute_to"]        通勤目的地键（见 DESTINATIONS），"none" 表示不固定
    soft_preferences["weight_adjust"]     反馈学到的权重倍数 {"value"|"groceries"|"station"|"commute": x}

规则抽取只认明确说法；含糊的不填。提供 LLM 钩子：llm(prompt) -> JSON 字符串或字典，
结果与规则结果走同一套校验，不合法字段直接丢弃，绝不让模型输出绕过校验写进档案。
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from .types import (
    STATION_CONFIRMED,
    StationWalkRequirement,
    UserState,
    ValidationError,
)

# 通勤目的地（坐标为大致位置，用于估算距离，不是导航终点）
DESTINATIONS: Dict[str, Dict[str, Any]] = {
    "CBD": {"label": "CBD / Town Hall", "lat": -33.8732, "lng": 151.2069},
    "UTS": {"label": "UTS（Broadway）", "lat": -33.8832, "lng": 151.2005},
    "USYD": {"label": "悉尼大学（Camperdown）", "lat": -33.8886, "lng": 151.1873},
    "UNSW": {"label": "UNSW（Kensington）", "lat": -33.9173, "lng": 151.2313},
}
COMMUTE_NONE = "none"
NEED_KEYS = ("pets", "furnished", "parking")
WEIGHT_KEYS = ("value", "groceries", "station", "commute")
MAX_WEIGHT_FACTOR = 4.0


# ---------------------------------------------------------------------------
# 档案读取辅助
# ---------------------------------------------------------------------------
def needs_of(state: UserState) -> Dict[str, bool]:
    raw = state.other_confirmed.get("needs") or {}
    return {key: bool(raw[key]) for key in NEED_KEYS if key in raw and raw[key] is not None}


def budget_stretch_of(state: UserState) -> Optional[float]:
    value = state.other_confirmed.get("budget_stretch_pct")
    return None if value is None else float(value)


def commute_of(state: UserState) -> Optional[str]:
    value = state.soft_preferences.get("commute_to")
    return None if value is None else str(value)


def excluded_districts_of(state: UserState) -> Tuple[str, ...]:
    return tuple(state.other_confirmed.get("excluded_districts") or ())


def weight_adjust_of(state: UserState) -> Dict[str, float]:
    raw = state.soft_preferences.get("weight_adjust") or {}
    return {key: float(raw[key]) for key in WEIGHT_KEYS if key in raw}


# ---------------------------------------------------------------------------
# 通用补丁
# ---------------------------------------------------------------------------
PATCH_KEYS = ("station_walk", "needs", "excluded_districts", "commute_to", "budget_stretch_pct",
              "weight_adjust", "preference_evidence", "budget_weekly_max", "bedrooms", "districts")
MAX_PREFERENCE_EVIDENCE = 30


# 模型只能写用户说出来的条件；weight_adjust / preference_evidence 只由选择 / 拒绝反馈产生
LLM_PATCH_KEYS = tuple(key for key in PATCH_KEYS if key not in ("weight_adjust", "preference_evidence"))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_patch(patch: Mapping[str, Any]) -> Dict[str, Any]:
    """只保留合法键与合法值；返回清洗后的补丁（可能为空）。非法值直接丢弃，不猜。"""
    if not isinstance(patch, Mapping):
        raise ValidationError("patch 必须是对象")
    clean: Dict[str, Any] = {}
    for key, value in patch.items():
        if key not in PATCH_KEYS:
            continue
        if key == "station_walk":
            try:
                clean[key] = StationWalkRequirement.from_payload(value).to_dict()
            except ValidationError:
                continue
        elif key == "needs" and isinstance(value, Mapping):
            needs = {k: bool(v) for k, v in value.items() if k in NEED_KEYS and isinstance(v, bool)}
            if needs:
                clean[key] = needs
        elif key in ("excluded_districts", "districts") and isinstance(value, (list, tuple)):
            items = [str(item).strip() for item in value if str(item).strip()]
            if items or key == "districts":
                clean[key] = items
        elif key == "commute_to" and isinstance(value, str) and (value in DESTINATIONS or value == COMMUTE_NONE):
            clean[key] = value
        elif key == "budget_stretch_pct" and _is_number(value) and 0 <= value <= 50:
            clean[key] = float(value)
        elif key == "budget_weekly_max" and _is_number(value) and 100 <= value <= 20000:
            clean[key] = float(value)
        elif key == "bedrooms" and isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 8:
            clean[key] = value
        elif key == "weight_adjust" and isinstance(value, Mapping):
            weights = {k: min(MAX_WEIGHT_FACTOR, max(1.0 / MAX_WEIGHT_FACTOR, float(v)))
                       for k, v in value.items() if k in WEIGHT_KEYS and _is_number(v)}
            if weights:
                clean[key] = weights
        elif key == "preference_evidence":
            from .preference import clean_evidence  # 避免循环导入
            entries = clean_evidence(value)
            if entries:
                clean[key] = entries
    return clean


def apply_state_patch(state: UserState, patch: Mapping[str, Any]) -> UserState:
    """把清洗后的补丁应用到副本上；needs / weight_adjust 合并，excluded_districts 取并集。"""
    clean = validate_patch(patch)
    other = copy.deepcopy(dict(state.other_confirmed))
    soft = copy.deepcopy(dict(state.soft_preferences))
    station = state.station_walk
    budget, bedrooms, districts = state.budget_weekly_max, state.bedrooms, state.districts
    if "station_walk" in clean:
        station = StationWalkRequirement.from_payload(clean["station_walk"])
    if "needs" in clean:
        other["needs"] = {**dict(other.get("needs") or {}), **clean["needs"]}
    if "excluded_districts" in clean:
        merged = list(other.get("excluded_districts") or [])
        merged += [item for item in clean["excluded_districts"] if item not in merged]
        other["excluded_districts"] = merged
    if "budget_stretch_pct" in clean:
        other["budget_stretch_pct"] = clean["budget_stretch_pct"]
    if "commute_to" in clean:
        soft["commute_to"] = clean["commute_to"]
    if "weight_adjust" in clean:
        soft["weight_adjust"] = {**dict(soft.get("weight_adjust") or {}), **clean["weight_adjust"]}
    if "preference_evidence" in clean:   # 追加；只保留最近若干条
        merged_evidence = list(soft.get("preference_evidence") or []) + clean["preference_evidence"]
        soft["preference_evidence"] = merged_evidence[-MAX_PREFERENCE_EVIDENCE:]
    if "budget_weekly_max" in clean:
        budget = clean["budget_weekly_max"]
    if "bedrooms" in clean:
        bedrooms = clean["bedrooms"]
    if "districts" in clean:
        districts = tuple(clean["districts"])
    return UserState(station_walk=station, budget_weekly_max=budget, bedrooms=bedrooms, districts=districts,
                     soft_preferences=soft, other_confirmed=other)


# ---------------------------------------------------------------------------
# 从用户的话里抽取需求
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class NeedsExtraction:
    patch: Mapping[str, Any]
    evidence: Tuple[Tuple[str, str], ...] = ()      # (字段, 命中的原文片段)
    source: str = "rules"
    dropped: Tuple[str, ...] = ()                    # LLM 给了但没通过校验的字段

    def to_dict(self) -> Dict[str, Any]:
        return {"patch": dict(self.patch), "evidence": [list(item) for item in self.evidence],
                "source": self.source, "dropped": list(self.dropped)}


_L, _R = r"(?<![a-z0-9])", r"(?![a-z0-9])"   # 拉丁词边界：中文字符与英文相邻时 \b 不生效


def _w(word: str) -> str:
    return _L + word + _R


_CN_NUM = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "单": 1,
           "one": 1, "two": 2, "three": 3, "four": 4}

_PATTERNS: List[Tuple[str, str, Any]] = [
    # (字段, 正则, 值)；先写否定/无所谓，命中后同字段的肯定不再生效
    ("pets", r"(没有|没|不养|不带|不要|不用|不需要|无|不强求)(有)?(宠物|猫|狗)|"
             r"(宠物|猫|狗)(无所谓|不需要|不用|不强求|过敏)|对(宠物|猫|狗)过敏|"
             r"no pets?|without (a |any )?(pets?|cats?|dogs?)|"
             r"don'?t (have|need|want) (a |any )?(pets?|cats?|dogs?)", False),
    ("pets", r"养(了)?(一只|只|条|两只)?(猫|狗|宠物)|有(一只|只|条)?(猫|狗|宠物)|带(着)?(猫|狗|宠物)|宠物|"
             + _w(r"(my|a|our) (cat|dog|pet)") + "|" + _w("pets?") + "|" + _w("cats?") + "|" + _w("dogs?"), True),
    ("furnished", r"(不需要|不用|不要|不带|没有|无所谓|不强求)(带|有)?家具|家具(无所谓|不需要|不用|不强求)|un-?furnished|"
                  r"not furnished|no furniture|don'?t need (it )?furni", False),
    ("furnished", r"带家具|家具齐全|有家具|拎包入住|furnished", True),
    ("parking", r"(不需要|不用|不要|没有|无所谓|不强求)(有)?(车位|停车)|(车位|停车)(无所谓|不需要|不用|不强求)|"
                r"没(有)?车|不开车|no (car|parking)|"
                r"without (a )?(car|parking)|don'?t (need|have) (a )?(car|parking)", False),
    ("parking", r"车位|停车|有车|" + _w("parking") + r"|car ?space|garage", True),
]

_DEST_PATTERNS: List[Tuple[str, str]] = [
    ("UTS", _w("uts") + r"|悉尼科技大学|科技大学"),
    ("USYD", _w("usyd") + r"|悉尼大学|university of sydney|" + _w("sydney uni")),
    ("UNSW", _w("unsw") + r"|新南威尔士大学|新南"),
    ("CBD", _w("cbd") + r"|市中心|town hall|城里上班|市区上班|martin place|wynyard"),
]

_NUM = r"(\d{1,2},\d{3}|\d{3,4})"
_NOT_DISTANCE = r"(?!\d)(?!\s*(?:米|公里|分钟|km|m(?![a-z])|mins?(?![a-z])|minutes?))"   # "最多 800 米"是距离，不是预算
_BUDGET_RE = re.compile(r"(?:预算|budget|最多|不超过|上限|under|below|max(?:imum)?|within|up to)\s*[:：]?\s*"
                        r"(?:一周|每周|per week|weekly)?\s*[\$＄]?\s*" + _NUM + _NOT_DISTANCE, re.I)
_BUDGET_UNIT_RE = re.compile(
    r"[\$＄]?\s*" + _NUM + r"\s*(?:刀|澳元|澳币|块|元|dollars?|aud)?\s*"
    r"(?:/|每|一|per |a |p)\s*(?:周|星期|礼拜|week|wk|w(?![a-z]))|"
    r"(?:每|一|per |a )\s*(?:周|星期|礼拜|week|wk)\s*[\$＄]?\s*" + _NUM + r"\s*(?:刀|澳元|澳币|块|元|dollars?|aud)?",
    re.I,
)
_BUDGET_STRETCH_STRICT_RE = re.compile(
    r"预算(很)?严格|(不能|不可以|不)超(过)?预算|"
    r"预算[^。，,.;；]{0,6}(?:不能|不可以|不可|别)(?:稍微)?(?:超|放宽|浮动|多)(?![?？吗么])|strict budget",
    re.I,
)
_BUDGET_STRETCH_FLEX_RE = re.compile(
    r"预算[^。，,.;；]{0,6}(?:可以|能|可)(?:稍微)?(?:放宽|浮动|多出?|宽裕)(?:到?\s*(\d{1,2})\s*%)?|"
    r"budget\s+(?:is\s+)?flexible",
    re.I,
)
# 放宽说法里夹着否定或是在提问（“预算800不可以多”“预算能不能放宽？”），都不算用户同意放宽。
_STRETCH_NEGATION_RE = re.compile(r"不|没|别|能不能|可不可以|可否|吗|么|？|\?|not", re.I)
_STATION_RE = re.compile(
    # 只认火车 / 地铁 / 轻轨站：station_walk 是到轨交站的距离，公交站不算。
    r"(车站|地铁站?|火车站|轻轨站?|(?:离|距|到)站|station)[^0-9。，,.]{0,8}(\d+(?:\.\d+)?)\s*(米|m(?![a-z])|公里|km)|"
    r"(\d+(?:\.\d+)?)\s*(米|m(?![a-z])|公里|km)[^0-9。，,.]{0,10}(车站|地铁站?|火车站|轻轨站?|(?<!公交)站|station)",
    re.I,
)
_BED_RE = re.compile(
    r"(?:" + _L + r"(one|two|three|four)|([一两二三四单1-4]))\s*[-‐‑]?\s*(室|卧|房|居|bed(room)?s?|br(?![a-z]))", re.I
)
_STUDIO_RE = re.compile(_w("studio") + r"|开间|单间公寓", re.I)


def _extract_rules(text: str, suburbs: Sequence[str] = ()) -> NeedsExtraction:
    raw = text.strip()
    lower = raw.lower()
    patch: Dict[str, Any] = {}
    evidence: List[Tuple[str, str]] = []
    needs: Dict[str, bool] = {}
    for key, pattern, value in _PATTERNS:
        if key in needs:
            continue
        match = re.search(pattern, lower, re.I)
        if match:
            needs[key] = value
            evidence.append((f"needs.{key}", match.group(0)))
    if needs:
        patch["needs"] = needs

    for key, pattern in _DEST_PATTERNS:
        match = re.search(pattern, lower, re.I)
        if match:
            patch["commute_to"] = key
            evidence.append(("commute_to", match.group(0)))
            break

    match = _BUDGET_RE.search(raw) or _BUDGET_UNIT_RE.search(raw)
    if match:
        num_str = next(group for group in match.groups() if group is not None)
        value = float(num_str.replace(",", ""))
        if 150 <= value <= 10000:
            patch["budget_weekly_max"] = value
            evidence.append(("budget_weekly_max", match.group(0).strip()))

    if _BUDGET_STRETCH_STRICT_RE.search(raw):
        hit = _BUDGET_STRETCH_STRICT_RE.search(raw)
        patch["budget_stretch_pct"] = 0.0
        evidence.append(("budget_stretch_pct", hit.group(0)))
    elif _BUDGET_STRETCH_FLEX_RE.search(raw):
        hit = _BUDGET_STRETCH_FLEX_RE.search(raw)
        tail = raw[hit.end():hit.end() + 3]   # 紧跟的“吗 / ？”也算提问
        pct = float(hit.group(1)) if hit.group(1) else 10.0
        if 0 <= pct <= 50 and not _STRETCH_NEGATION_RE.search(hit.group(0) + tail):
            patch["budget_stretch_pct"] = pct
            evidence.append(("budget_stretch_pct", hit.group(0)))

    if _STUDIO_RE.search(raw):
        patch["bedrooms"] = 0
        evidence.append(("bedrooms", _STUDIO_RE.search(raw).group(0)))
    else:
        match = _BED_RE.search(raw)
        if match:
            token = (match.group(1) or match.group(2)).lower()
            patch["bedrooms"] = int(token) if token.isdigit() else _CN_NUM[token]
            evidence.append(("bedrooms", match.group(0)))

    match = _STATION_RE.search(raw)
    if match:
        number = match.group(2) or match.group(4)
        unit = (match.group(3) or match.group(5) or "").lower()
        metres = float(number) * (1000.0 if unit in ("公里", "km") else 1.0)
        if 50 <= metres <= 5000:
            patch["station_walk"] = {"status": STATION_CONFIRMED, "max_m": metres}
            evidence.append(("station_walk", match.group(0)))

    found = [suburb for suburb in suburbs if re.search(_w(re.escape(suburb.split(" (")[0].lower())), lower)]
    if found:
        negated = [suburb for suburb in found
                   if re.search(r"(不要|不想|不考虑|avoid|not)\s*(住)?\s*(在)?\s*" + re.escape(suburb.split(" (")[0].lower()),
                                lower)]
        keep = [suburb for suburb in found if suburb not in negated]
        if keep:
            patch["districts"] = keep
            evidence.append(("districts", ", ".join(keep)))
        if negated:
            patch["excluded_districts"] = negated
            evidence.append(("excluded_districts", ", ".join(negated)))
    return NeedsExtraction(patch=validate_patch(patch), evidence=tuple(evidence), source="rules")


NEEDS_EXTRACTION_PROMPT = """你是租房需求抽取器。只根据用户原话抽取明确说出的条件，没说的字段不要输出。
输出一个 JSON 对象，允许的字段：
  budget_weekly_max: 数字（澳元/周）
  bedrooms: 整数（studio 记 0）
  districts: 想住的 suburb 列表；excluded_districts: 明确不想住的 suburb 列表
  needs: {"pets": true/false, "furnished": true/false, "parking": true/false}
  commute_to: "CBD" | "UTS" | "USYD" | "UNSW" | "none"
  station_walk: {"status": "confirmed", "max_m": 数字或 null}
  budget_stretch_pct: 0–50 的数字（用户说预算能多出多少）
用户原话：
"""


def extract_needs(text: str, *, suburbs: Sequence[str] = (),
                  llm: Optional[Callable[[str], Any]] = None) -> NeedsExtraction:
    """先跑规则；给了 llm 时用 LLM 结果覆盖规则结果，但两者都必须通过 validate_patch。"""
    rules = _extract_rules(text or "", suburbs)
    if llm is None:
        return rules
    try:
        raw = llm(NEEDS_EXTRACTION_PROMPT + (text or ""))
        payload = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except Exception:  # noqa: BLE001 - LLM 失败就只用规则结果
        return rules
    if not isinstance(payload, Mapping):
        return rules
    clean = validate_patch({key: value for key, value in payload.items() if key in LLM_PATCH_KEYS})
    dropped = tuple(sorted(key for key in payload if key not in clean))
    merged = {**dict(rules.patch), **clean}
    if "needs" in rules.patch and "needs" in clean:
        merged["needs"] = {**rules.patch["needs"], **clean["needs"]}
    return NeedsExtraction(patch=validate_patch(merged), evidence=rules.evidence, source="rules+llm",
                           dropped=dropped)
