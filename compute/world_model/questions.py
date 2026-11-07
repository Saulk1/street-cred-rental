"""多问题规划：从"问不问"升级为"问哪个"（方向①），并给出多样化推荐集合（方向③）与开放追问（方向④）。

问题价值 = 期望遗憾：
    不问时会推荐 d（当前档案下的首选）。对问题 q 的每个回答分支 b（先验 p_b）：
        regret_b = 分支 b 下 d 的分数 − 分支 b 下最优房源的分数        （d 在 b 下仍可行）
                 = INFEASIBLE_COST                                       （d 在 b 下不可行）
    value(q) = Σ p_b · regret_b / Σ p_b
只在 max value ≥ ask_threshold 且本任务问过的问题 < max_questions 时提问，问价值最高的那个。
分数单位来自排序器（ValueRanker：1 分 ≈ 贵 1% / 超市远 1 分钟 / 通勤远 250 米）。

先验 DEFAULT_PRIORS 是可调的人工设定，不是统计结果；上线后应换成真实回答分布。
车站问题沿用自适应阈值，并在距离误差带两端各算一次，取最小值（保守，避免为估算误差提问）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .needs import (
    COMMUTE_NONE,
    DESTINATIONS,
    apply_state_patch,
    budget_stretch_of,
    commute_of,
    needs_of,
    weight_adjust_of,
)
from .scenarios import build_adaptive_question
from .transition import DISTANCE_VIEW_HIGH, DISTANCE_VIEW_LOW, distance_view, filter_feasible
from .types import STATION_DEFERRED, STATION_UNKNOWN, Listing, UserState
from .value_ranker import MAX_DISCOUNT_PCT, commute_distance_km

INFEASIBLE_COST = 25.0
DEFAULT_ASK_THRESHOLD = 3.0
DEFAULT_MAX_QUESTIONS = 2
BUDGET_STRETCH_PCT = 10.0

DEFAULT_PRIORS: Dict[str, Dict[str, float]] = {
    "needs.pets": {"yes": 0.15, "no": 0.85},
    "needs.furnished": {"yes": 0.20, "no": 0.80},
    "needs.parking": {"yes": 0.25, "no": 0.75},
    "commute_to": {"none": 0.40, "CBD": 0.25, "UTS": 0.15, "USYD": 0.15, "UNSW": 0.05},
    "budget_stretch": {"strict": 0.50, "stretch": 0.50},
    "station_walk_max_m": {},   # 空 = 各分支均匀
}

QUESTION_HINTS: Dict[str, str] = {
    "station_walk_max_m": "能走多远到车站",
    "needs.pets": "有没有宠物",
    "needs.furnished": "要不要带家具",
    "needs.parking": "需不需要车位",
    "commute_to": "平时去哪里上班或上课",
    "budget_stretch": "预算能不能稍微浮动",
}


@dataclass(frozen=True)
class AnswerOption:
    id: str
    label: str
    patch: Optional[Mapping[str, Any]]      # None = 暂时跳过（记为问过，不写档案）

    def to_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "label": self.label}


@dataclass(frozen=True)
class Branch:
    branch_id: str
    label: str
    patch: Mapping[str, Any]
    prior: float


@dataclass(frozen=True)
class QuestionSpec:
    key: str
    text: str
    options: Tuple[AnswerOption, ...]
    branches: Tuple[Branch, ...]
    meta: Mapping[str, Any] = field(default_factory=dict)

    def option(self, option_id: str) -> Optional[AnswerOption]:
        return next((item for item in self.options if item.id == option_id), None)


@dataclass(frozen=True)
class QuestionValue:
    key: str
    value: float
    branches: Tuple[Dict[str, Any], ...]

    def to_dict(self) -> Dict[str, Any]:
        return {"key": self.key, "value": round(self.value, 2), "branches": list(self.branches)}


@dataclass(frozen=True)
class MultiPlan:
    action: str                                   # ask / recommend / no_match
    reason_code: str
    default_listing_id: Optional[str] = None
    question: Optional[QuestionSpec] = None
    values: Tuple[QuestionValue, ...] = ()
    recommendations: Tuple[Dict[str, Any], ...] = ()
    followup: Optional[str] = None
    diagnostics: Mapping[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# 问题库
# ---------------------------------------------------------------------------
def _yes_no(key: str, text: str, need: str, priors: Mapping[str, float], yes_label: str, no_label: str) -> QuestionSpec:
    yes_patch = {"needs": {need: True}}
    no_patch = {"needs": {need: False}}
    return QuestionSpec(
        key=key, text=text,
        options=(AnswerOption("yes", yes_label, yes_patch), AnswerOption("no", no_label, no_patch),
                 AnswerOption("skip", "暂时跳过", None)),
        branches=(Branch("yes", yes_label, yes_patch, priors.get("yes", 0.5)),
                  Branch("no", no_label, no_patch, priors.get("no", 0.5))),
    )


def build_question_bank(state: UserState, candidates: Sequence[Listing], ranker: Any, snapshot_id: str,
                        *, priors: Optional[Mapping[str, Mapping[str, float]]] = None,
                        exclude: Sequence[str] = ()) -> List[QuestionSpec]:
    """当前档案下仍未知、且本任务没问过的问题。"""
    table = {**DEFAULT_PRIORS, **dict(priors or {})}
    skip = set(exclude)
    specs: List[QuestionSpec] = []

    if "station_walk_max_m" not in skip and state.station_walk.status == STATION_UNKNOWN:
        adaptive = build_adaptive_question(state, candidates, ranker, snapshot_id)
        if adaptive is not None:
            station_priors = table.get("station_walk_max_m") or {}
            branches = tuple(Branch(s.scenario_id, s.label, s.next_state_patch(),
                                    station_priors.get(s.scenario_id, 1.0)) for s in adaptive.scenarios)
            options = []
            for option in adaptive.options:
                if option.effect == "skip":
                    options.append(AnswerOption(option.id, option.label,
                                                {"station_walk": {"status": STATION_DEFERRED, "max_m": None}}))
                else:
                    options.append(AnswerOption(option.id, option.label,
                                                {"station_walk": {"status": "confirmed", "max_m": option.max_m}}))
            specs.append(QuestionSpec("station_walk_max_m", adaptive.question_text, tuple(options), branches,
                                      meta=dict(adaptive.meta)))

    known_needs = needs_of(state)
    for need, text, yes_label, no_label in (
            ("pets", "你有宠物要一起住吗？", "有宠物", "没有"),
            ("furnished", "需要带家具的房子吗？", "需要带家具", "不需要"),
            ("parking", "需要车位吗？", "需要车位", "不需要")):
        key = f"needs.{need}"
        if key not in skip and need not in known_needs:
            specs.append(_yes_no(key, text, need, table.get(key, {}), yes_label, no_label))

    if "commute_to" not in skip and commute_of(state) is None:
        commute_priors = table.get("commute_to", {})
        options = tuple(AnswerOption(dest, info["label"], {"commute_to": dest}) for dest, info in DESTINATIONS.items()) + (
            AnswerOption(COMMUTE_NONE, "不固定 / 无所谓", {"commute_to": COMMUTE_NONE}),
            AnswerOption("skip", "暂时跳过", None))
        branches = tuple(Branch(dest, info["label"], {"commute_to": dest}, commute_priors.get(dest, 0.1))
                         for dest, info in DESTINATIONS.items()) + (
            Branch(COMMUTE_NONE, "不固定", {"commute_to": COMMUTE_NONE}, commute_priors.get(COMMUTE_NONE, 0.4)),)
        specs.append(QuestionSpec("commute_to", "你平时主要去哪里上班或上课？", options, branches))

    if ("budget_stretch" not in skip and state.budget_weekly_max is not None
            and budget_stretch_of(state) is None):
        stretch_priors = table.get("budget_stretch", {})
        stretched = round(state.budget_weekly_max * (1 + BUDGET_STRETCH_PCT / 100.0))
        strict = {"budget_stretch_pct": 0.0}
        loose = {"budget_stretch_pct": BUDGET_STRETCH_PCT}
        specs.append(QuestionSpec(
            "budget_stretch", f"如果有明显更合适的房子，周租能放宽到 ${stretched} 吗？",
            (AnswerOption("stretch", f"可以，最多 ${stretched}", loose),
             AnswerOption("strict", f"不行，最多 ${state.budget_weekly_max:.0f}", strict),
             AnswerOption("skip", "暂时跳过", None)),
            (Branch("strict", "严格预算", strict, stretch_priors.get("strict", 0.5)),
             Branch("stretch", "可放宽 10%", loose, stretch_priors.get("stretch", 0.5))),
            meta={"stretched_budget": stretched}))
    return specs


# ---------------------------------------------------------------------------
# 价值计算
# ---------------------------------------------------------------------------
def _top(state: UserState, candidates: Sequence[Listing], ranker: Any, snapshot_id: str) -> Tuple[Optional[str], List[Listing]]:
    feasible = filter_feasible(state, candidates)
    if not feasible:
        return None, feasible
    ordered = list(ranker.rank(state, feasible, snapshot_id))
    return (str(ordered[0]) if ordered else None), feasible


def question_value(spec: QuestionSpec, state: UserState, candidates: Sequence[Listing], ranker: Any,
                   snapshot_id: str, default_id: str) -> QuestionValue:
    by_id = {listing.listing_id: listing for listing in candidates}
    rows: List[Dict[str, Any]] = []
    total, weight = 0.0, 0.0
    for branch in spec.branches:
        branch_state = apply_state_patch(state, branch.patch)
        top_id, feasible = _top(branch_state, candidates, ranker, snapshot_id)
        feasible_ids = {listing.listing_id for listing in feasible}
        if default_id not in feasible_ids:
            regret = INFEASIBLE_COST
        else:
            regret = max(0.0, ranker.score(branch_state, by_id[default_id]) - ranker.score(branch_state, by_id[top_id]))
        rows.append({"branch": branch.branch_id, "prior": branch.prior, "top": top_id,
                     "feasible": len(feasible), "regret": round(regret, 2)})
        total += branch.prior * regret
        weight += branch.prior
    return QuestionValue(spec.key, total / weight if weight else 0.0, tuple(rows))


def _robust_station_value(spec: QuestionSpec, state: UserState, candidates: Sequence[Listing], ranker: Any,
                          snapshot_id: str, default_id: str) -> QuestionValue:
    point = question_value(spec, state, candidates, ranker, snapshot_id, default_id)
    values = [point.value]
    for view in (DISTANCE_VIEW_LOW, DISTANCE_VIEW_HIGH):
        values.append(question_value(spec, state, distance_view(candidates, view), ranker, snapshot_id,
                                     default_id).value)
    return QuestionValue(spec.key, min(values), point.branches + ({"views": [round(v, 2) for v in values]},))


# ---------------------------------------------------------------------------
# 推荐集合（方向③）与开放追问（方向④）
# ---------------------------------------------------------------------------
_NEED_LABELS = {"pets": "宠物政策", "furnished": "是否带家具", "parking": "是否有车位"}


def _reason(state: UserState, listing: Listing, ranker: Any) -> str:
    parts = ranker.score_breakdown(state, listing)
    extra = listing.extra
    bits = [f"${listing.weekly_rent:.0f}/周"]
    gap = parts.get("gap_pct")
    if gap == gap:  # not NaN
        bits[-1] += f"（比同类{'便宜' if gap < 0 else '贵'} {abs(gap):.0f}%）"
    if listing.station_walk_m is not None:
        bits.append(f"离 {extra.get('station_name') or '车站'} 约 {listing.station_walk_m:.0f} 米")
    if listing.supermarket_walk_min is not None:
        bits.append(f"超市步行约 {listing.supermarket_walk_min:.0f} 分钟")
    km = parts.get("commute_km")
    if km == km:
        bits.append(f"到 {DESTINATIONS[state.soft_preferences['commute_to']]['label']} 约 {km:.1f} km")
    unknown = parts.get("unknown_need_keys") or []
    if unknown:
        bits.append("、".join(_NEED_LABELS[key] for key in unknown) + "没写明，需向中介确认")
    if _price_needs_check(parts):
        bits.append("价格异常偏低，可能是合租单间或数据有误，需核实")
    return "｜".join(bits)


def _price_needs_check(parts: Mapping[str, Any]) -> bool:
    """折扣超过排序器封顶线（40%）：还没到 50% 的筛查线，但已不能当成真实捡漏。NaN 比较恒为 False。"""
    return parts.get("gap_pct") < -MAX_DISCOUNT_PCT


def recommend_set(state: UserState, candidates: Sequence[Listing], ranker: Any, snapshot_id: str,
                  k: int = 3, slack: float = 15.0) -> Tuple[Dict[str, Any], ...]:
    """综合最优 + 若干"换一种取舍"的备选（分数不差于最优 slack 分以内），让用户的选择暴露偏好。"""
    feasible = filter_feasible(state, candidates)
    if not feasible:
        return ()
    ordered_ids = list(ranker.rank(state, feasible, snapshot_id))
    by_id = {listing.listing_id: listing for listing in feasible}
    scores = {listing_id: ranker.score(state, by_id[listing_id]) for listing_id in ordered_ids}
    best_id = ordered_ids[0]
    near = [listing_id for listing_id in ordered_ids if scores[listing_id] <= scores[best_id] + slack]

    def _or_far(value: Optional[float]) -> float:
        # 不能写 value or 1e9：离车站 0 米 / 周租 0 会被当成最远 / 最贵。
        return 1e9 if value is None else float(value)

    roles: List[Tuple[str, str, Any]] = [
        ("best", "综合最优", lambda ids: ids[0]),
        ("cheapest", "更省钱", lambda ids: min(ids, key=lambda i: (_or_far(by_id[i].weekly_rent), scores[i], i))),
        ("closest_station", "离车站更近", lambda ids: min(ids, key=lambda i: (_or_far(by_id[i].station_walk_m), scores[i], i))),
    ]
    if commute_of(state) not in (None, COMMUTE_NONE):
        roles.append(("closest_commute", "通勤更近",
                      lambda ids: min(ids, key=lambda i: (_or_far(commute_distance_km(state, by_id[i])), scores[i], i))))

    chosen: List[Tuple[str, str, str]] = []
    for role, label, pick in roles:
        if len(chosen) >= k:
            break
        listing_id = pick(near)
        if listing_id not in [item[2] for item in chosen]:
            chosen.append((role, label, listing_id))
    for listing_id in ordered_ids:  # 角色撞车时用次优补足
        if len(chosen) >= k:
            break
        if listing_id not in [item[2] for item in chosen]:
            chosen.append(("alternative", "备选", listing_id))
    return tuple({"listing_id": listing_id, "role": role, "label": label,
                  "score": round(scores[listing_id], 2), "score_gap": round(scores[listing_id] - scores[best_id], 2),
                  "reason": _reason(state, by_id[listing_id], ranker),
                  "price_check": _price_needs_check(ranker.score_breakdown(state, by_id[listing_id])),
                  "address": by_id[listing_id].extra.get("address"), "district": by_id[listing_id].district}
                 for role, label, listing_id in chosen)


def followup_prompt(remaining: Sequence[QuestionValue], limit: int = 3) -> str:
    hints = [QUESTION_HINTS[item.key] for item in sorted(remaining, key=lambda v: (-v.value, v.key))
             if item.key in QUESTION_HINTS][:limit]
    if not hints:
        return "还有什么必须满足的条件吗？直接告诉我，我会重新筛一遍。"
    return "还有什么必须满足的条件吗？比如" + "、".join(hints) + "。直接告诉我，我会重新筛一遍。"


# ---------------------------------------------------------------------------
# 规划
# ---------------------------------------------------------------------------
def plan_multi(state: UserState, candidates: Sequence[Listing], ranker: Any, snapshot_id: str, *,
               asked_keys: Sequence[str] = (), max_questions: int = DEFAULT_MAX_QUESTIONS,
               ask_threshold: float = DEFAULT_ASK_THRESHOLD,
               priors: Optional[Mapping[str, Mapping[str, float]]] = None,
               robust: bool = True, k: int = 3) -> MultiPlan:
    default_id, _feasible = _top(state, candidates, ranker, snapshot_id)
    if default_id is None:
        # 严格预算下无房，但若预算尚未确认且放宽 10% 后有房源，应主动询问能否放宽预算，而非直接判无解。
        if ("budget_stretch" not in asked_keys and len(asked_keys) < max_questions
                and state.budget_weekly_max is not None and budget_stretch_of(state) is None):
            stretched_state = apply_state_patch(state, {"budget_stretch_pct": BUDGET_STRETCH_PCT})
            stretched_top, stretched_feasible = _top(stretched_state, candidates, ranker, snapshot_id)
            if stretched_top is not None:
                specs = [item for item in build_question_bank(state, candidates, ranker, snapshot_id,
                                                              priors=priors, exclude=asked_keys)
                         if item.key == "budget_stretch"]
                if specs:
                    spec = specs[0]
                    p_strict = spec.branches[0].prior
                    p_stretch = spec.branches[1].prior
                    total_p = p_strict + p_stretch
                    val = (p_stretch * INFEASIBLE_COST / total_p) if total_p else 0.0
                    qv = QuestionValue(
                        "budget_stretch", val,
                        ({"branch": "strict", "prior": p_strict, "top": None, "feasible": 0, "regret": INFEASIBLE_COST},
                         {"branch": "stretch", "prior": p_stretch, "top": stretched_top,
                          "feasible": len(stretched_feasible), "regret": 0.0}),
                    )
                    if qv.value >= ask_threshold:
                        diagnostics = {"question_values": [qv.to_dict()], "asked_keys": list(asked_keys),
                                       "ask_threshold": ask_threshold, "max_questions": max_questions,
                                       "weight_adjust": weight_adjust_of(state), "pool_size": len(candidates)}
                        return MultiPlan(action="ask", reason_code="highest_expected_regret",
                                         default_listing_id=stretched_top, question=spec,
                                         values=(qv,), diagnostics=diagnostics)
        return MultiPlan(action="no_match", reason_code="no_feasible_listing",
                         followup="当前没有同时满足这些条件的房源。可以放宽预算、区域或其他要求再试。")
    specs = build_question_bank(state, candidates, ranker, snapshot_id, priors=priors, exclude=asked_keys)
    values: List[QuestionValue] = []
    for spec in specs:
        if robust and spec.key == "station_walk_max_m":
            values.append(_robust_station_value(spec, state, candidates, ranker, snapshot_id, default_id))
        else:
            values.append(question_value(spec, state, candidates, ranker, snapshot_id, default_id))
    ranked = sorted(values, key=lambda item: (-item.value, item.key))
    diagnostics = {"question_values": [item.to_dict() for item in ranked], "asked_keys": list(asked_keys),
                   "ask_threshold": ask_threshold, "max_questions": max_questions,
                   "weight_adjust": weight_adjust_of(state), "pool_size": len(candidates)}

    if ranked and len(asked_keys) < max_questions and ranked[0].value >= ask_threshold:
        spec = next(item for item in specs if item.key == ranked[0].key)
        return MultiPlan(action="ask", reason_code="highest_expected_regret", default_listing_id=default_id,
                         question=spec, values=tuple(ranked), diagnostics=diagnostics)

    reason = ("question_budget_spent" if ranked and len(asked_keys) >= max_questions and ranked[0].value >= ask_threshold
              else "no_question_worth_asking")
    recommendations = recommend_set(state, candidates, ranker, snapshot_id, k=k)
    return MultiPlan(action="recommend", reason_code=reason, default_listing_id=default_id, values=tuple(ranked),
                     recommendations=recommendations, followup=followup_prompt(ranked), diagnostics=diagnostics)


# ---------------------------------------------------------------------------
# 选择 / 拒绝反馈（方向③）
# ---------------------------------------------------------------------------
_REASON_TAGS: Dict[str, Tuple[str, ...]] = {
    "value": ("太贵", "贵", "too expensive", "expensive", "pricey"),
    "station": ("离车站远", "车站远", "太远", "too far", "far from station"),
    "commute": ("通勤", "上学远", "上班远", "commute"),
    "groceries": ("买菜", "超市", "groceries", "supermarket"),
    "area": ("不喜欢这个区", "区域", "这一带", "area", "suburb", "neighbourhood", "neighborhood"),
}


_REASON_NOTES = {"value": "更看重价格", "station": "更看重离车站近", "commute": "更看重通勤距离",
                 "groceries": "更看重买菜方便"}


def apply_feedback(state: UserState, shown: Sequence[Mapping[str, Any]], listings: Mapping[str, Listing],
                   ranker: Any, *, chosen_id: Optional[str] = None, rejected_ids: Sequence[str] = (),
                   reasons: Sequence[str] = ()) -> Tuple[Dict[str, Any], List[str]]:
    """把"选了哪套 / 拒了哪套 / 为什么"转成档案补丁（权重倍数、排除区域）。只调软权重，不改硬要求。"""
    adjust = dict(weight_adjust_of(state))
    notes: List[str] = []
    patch: Dict[str, Any] = {}
    bumped_in_turn: set = set()

    def bump(key: str, factor: float, why: str) -> None:
        if key not in bumped_in_turn:
            adjust[key] = adjust.get(key, 1.0) * factor
            bumped_in_turn.add(key)
        notes.append(why)

    text = " ".join(reasons).lower()
    for key, words in _REASON_TAGS.items():
        if any(word in text for word in words):
            if key == "area":
                districts = sorted({listings[i].district for i in rejected_ids if i in listings and listings[i].district})
                if districts:
                    patch["excluded_districts"] = districts
                    notes.append("不再推荐：" + "、".join(districts))
            elif key == "commute" and commute_of(state) in (None, COMMUTE_NONE):
                notes.append("提到通勤，但还不知道目的地，下一步会问")
            else:
                bump(key, 2.0 if key == "station" else 1.5, _REASON_NOTES[key])

    best = next((item for item in shown if item.get("role") == "best"), shown[0] if shown else None)
    if chosen_id and best and chosen_id != best["listing_id"] and chosen_id in listings and best["listing_id"] in listings:
        chosen, top = listings[chosen_id], listings[best["listing_id"]]
        a, b = ranker.score_breakdown(state, chosen), ranker.score_breakdown(state, top)
        advantages = {
            "value": b["value"] - a["value"],
            "groceries": b["groceries"] - a["groceries"],
            "station": ((top.station_walk_m or 0) - (chosen.station_walk_m or 0)) / 100.0,
            "commute": b["commute"] - a["commute"],
        }
        key, gain = max(advantages.items(), key=lambda item: (item[1], item[0]))
        if gain > 0.5:
            bump(key, 1.5, {"value": "你选了更便宜的那套：更看重价格", "station": "你选了离车站更近的那套：更看重车站",
                            "commute": "你选了通勤更近的那套：更看重通勤", "groceries": "你选了买菜更方便的那套"}[key])
    if adjust != weight_adjust_of(state):
        patch["weight_adjust"] = adjust
    return patch, notes
