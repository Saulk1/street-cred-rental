"""三个标准演示情景与固定问句（实施策划 §4.1、§6.1）。

这三个情景是覆盖用的演示分支，不代表用户回答概率。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .types import (
    OPTION_CONFIRM_LIMIT,
    OPTION_CONFIRM_NO_LIMIT,
    OPTION_SKIP,
    QUESTION_KEY,
    STATION_CONFIRMED,
    Listing,
    QuestionOption,
    Scenario,
    StationWalkRequirement,
    UserState,
)

QUESTION_TEXT = "你能接受步行多远到车站？"
QUESTION_TEXT_LONG = "你能接受步行多远到车站？可以选 400 米以内、1000 米以内，或不设硬限制；也可以直接告诉我其他距离。"

SCENARIO_LE_400 = "station-le-400"
SCENARIO_LE_1000 = "station-le-1000"
SCENARIO_NO_LIMIT = "station-no-limit"

# 固定顺序：400 -> 1000 -> 不设硬限制，诊断输出与测试都依赖这个顺序。
_STANDARD_SCENARIOS: Tuple[Scenario, ...] = (
    Scenario(SCENARIO_LE_400, "400 米以内", 400.0),
    Scenario(SCENARIO_LE_1000, "1000 米以内", 1000.0),
    Scenario(SCENARIO_NO_LIMIT, "不设车站距离硬限制", None),
)

STANDARD_OPTIONS: Tuple[QuestionOption, ...] = (
    QuestionOption("le_400", "400 米以内", 400.0, OPTION_CONFIRM_LIMIT),
    QuestionOption("le_1000", "1000 米以内", 1000.0, OPTION_CONFIRM_LIMIT),
    QuestionOption("no_limit", "不设硬限制", None, OPTION_CONFIRM_NO_LIMIT),
    QuestionOption("skip", "暂时跳过", None, OPTION_SKIP),
)


def build_scenarios() -> List[Scenario]:
    """返回三个标准情景（新列表，调用方改动不影响模块常量）。"""
    return list(_STANDARD_SCENARIOS)


def standard_question() -> Tuple[str, str, Tuple[QuestionOption, ...]]:
    """返回 (question_key, question_text, options)，内容固定、可复现。"""
    return QUESTION_KEY, QUESTION_TEXT, STANDARD_OPTIONS


def option_by_id(option_id: str, options: Sequence[QuestionOption] = STANDARD_OPTIONS) -> QuestionOption:
    for option in options or STANDARD_OPTIONS:
        if option.id == option_id:
            return option
    raise KeyError(option_id)


# ---------------------------------------------------------------------------
# 自适应问句：阈值由当前候选池决定（真实数据版）
# ---------------------------------------------------------------------------

# 用户可能给出的车站距离上限菜单。下限 400 米与标准问句最严格的选项一致：
# 首选房源在 400 米以内时，任何合理回答都不会把它排除，就不必打扰用户。
DEFAULT_LIMIT_MENU: Tuple[float, ...] = (400.0, 500.0, 600.0, 800.0, 1000.0, 1200.0, 1500.0, 2000.0)


@dataclass(frozen=True)
class AdaptiveQuestion:
    scenarios: Tuple[Scenario, ...]
    question_text: str
    options: Tuple[QuestionOption, ...]
    meta: Dict[str, Any]


def scenario_id_for(max_m: Optional[float]) -> str:
    return SCENARIO_NO_LIMIT if max_m is None else f"station-le-{int(round(max_m))}"


def _limit_option(max_m: float) -> QuestionOption:
    value = int(round(max_m))
    return QuestionOption(f"le_{value}", f"{value} 米以内", float(value), OPTION_CONFIRM_LIMIT)


def build_adaptive_question(state: UserState, candidates: Sequence[Listing], ranker: Any, snapshot_id: str,
                            menu: Sequence[float] = DEFAULT_LIMIT_MENU) -> Optional[AdaptiveQuestion]:
    """围绕"不设限时的首选 A"挑两个阈值：一个肯定排除 A，一个肯定保留 A。

    - t_cut  = 菜单里严格小于 A 误差带下界的最大值 → 该分支一定不含 A；
    - t_keep = 菜单里不小于 A 误差带上界的最小值   → 该分支一定含 A；
    - 落在 A 误差带内部的阈值故意不用：估算误差会让那个分支的结果不可信。
    若 A 近到菜单最小值都排除不了它（没有 t_cut），三个分支必然一致，规划器会直接推荐。
    返回 None 表示无法构造（无可行房源 / A 缺距离），调用方退回标准三分支。
    """
    from .transition import filter_feasible  # 避免循环导入

    unconstrained = state.with_station_walk(StationWalkRequirement(status=STATION_CONFIRMED, max_m=None))
    feasible = filter_feasible(unconstrained, candidates)
    if not feasible:
        return None
    ordered = list(ranker.rank(unconstrained, feasible, snapshot_id))
    if not ordered:
        return None
    by_id = {listing.listing_id: listing for listing in feasible}
    top = by_id.get(str(ordered[0]))
    if top is None or top.station_walk_m is None:
        return None
    low, high = top.walk_band()
    menu_sorted = sorted(float(value) for value in menu)
    cut = [value for value in menu_sorted if value < float(low)]           # type: ignore[arg-type]
    keep = [value for value in menu_sorted if value >= float(high)]        # type: ignore[arg-type]
    t_cut = cut[-1] if cut else None
    t_keep = keep[0] if keep else None

    # 若排除 A 后的次优房源 B 自身也离车站较远，且菜单里存在能进一步排除 B 并选出更近房源 C 的阈值 t_tight，
    # 则用 (t_tight, t_cut, no_limit) 构成真正区分 C / B / A 三档的三分支，避免 t_keep 与 no_limit 恒等退化为二选一。
    t_tight: Optional[float] = None
    if t_cut is not None:
        cut_state = state.with_station_walk(StationWalkRequirement(status=STATION_CONFIRMED, max_m=t_cut))
        cut_feasible = filter_feasible(cut_state, candidates)
        if cut_feasible:
            cut_ordered = list(ranker.rank(cut_state, cut_feasible, snapshot_id))
            cut_top = by_id.get(str(cut_ordered[0])) if cut_ordered else None
            if cut_top is not None and cut_top.station_walk_m is not None:
                b_low, b_high = cut_top.walk_band()
                if b_low is not None and b_high is not None and t_cut >= float(b_high):
                    tight_candidates = [value for value in menu_sorted if value < float(b_low)]
                    if tight_candidates:
                        candidate_tight = tight_candidates[-1]
                        tight_state = state.with_station_walk(
                            StationWalkRequirement(status=STATION_CONFIRMED, max_m=candidate_tight)
                        )
                        if filter_feasible(tight_state, candidates):
                            t_tight = candidate_tight

    if t_tight is not None and t_cut is not None:
        limits: List[float] = [t_tight, t_cut]
    else:
        limits = [value for value in (t_cut, t_keep) if value is not None]
    if not limits:
        limits = [menu_sorted[0]]
    scenarios = tuple(Scenario(scenario_id_for(value), f"{int(value)} 米以内", value) for value in limits) + (
        Scenario(SCENARIO_NO_LIMIT, "不设车站距离硬限制", None),)
    options = tuple(_limit_option(value) for value in limits) + (
        QuestionOption("no_limit", "不设硬限制", None, OPTION_CONFIRM_NO_LIMIT),
        QuestionOption("skip", "暂时跳过", None, OPTION_SKIP),
    )
    approx = int(round(float(top.station_walk_m) / 10.0) * 10)
    text = f"目前最合适的一套离车站约 {approx} 米（估算步行）。你能接受步行多远到车站？"
    meta = {
        "anchor_listing_id": top.listing_id,
        "anchor_walk_m": top.station_walk_m,
        "anchor_walk_band": [low, high],
        "t_tight": t_tight,
        "t_cut": t_cut,
        "t_keep": t_keep,
        "menu": menu_sorted,
    }
    return AdaptiveQuestion(scenarios=scenarios, question_text=text, options=options, meta=meta)
