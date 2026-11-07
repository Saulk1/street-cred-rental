"""情景转移：只在副本上模拟，绝不写回真实档案（实施策划 §6.1、§6.3）。

约束：
- 深复制真实档案，只把 station_walk 写成 confirmed + max_m，其余条件原样保留；
- 三个分支用同一候选快照与同一推荐器快照，互不共享可变状态；
- 模拟前后校验真实档案、候选数据、推荐器参数摘要不变，否则抛 SimulationIntegrityError。
"""

from __future__ import annotations

import copy
from typing import Any, List, Mapping, Optional, Protocol, Sequence, Tuple

from .scenarios import build_scenarios
from .types import (
    MAX_CANDIDATES,
    OUTCOME_HAS_MATCH,
    OUTCOME_NO_MATCH,
    STATION_CONFIRMED,
    DISTANCE_KIND_WALKING,
    DISTANCE_KIND_WALKING_ESTIMATED,
    SOURCE_SIMULATION,
    Listing,
    PlanInput,
    RankingContractError,
    WALK_HIGH_KEY,
    WALK_LOW_KEY,
    Scenario,
    ScenarioResult,
    SimulationIntegrityError,
    StationWalkRequirement,
    UserState,
    ValidationError,
    candidates_fingerprint,
    sha256_fingerprint,
)


class ReadOnlyRanker(Protocol):
    """唯一必要能力：只读排序，返回输入集合内的 ID。"""

    snapshot_id: str

    def rank(self, state: UserState, candidates: Sequence[Listing], snapshot_id: str) -> Sequence[str]:
        ...


def clone_state(state: UserState) -> UserState:
    """深复制；模拟只允许改副本里的 station_walk。"""
    return UserState(
        station_walk=copy.deepcopy(state.station_walk),
        budget_weekly_max=state.budget_weekly_max,
        bedrooms=state.bedrooms,
        districts=tuple(state.districts),
        soft_preferences=copy.deepcopy(dict(state.soft_preferences)),
        other_confirmed=copy.deepcopy(dict(state.other_confirmed)),
    )


def _assert_only_station_walk_changed(before: UserState, after: UserState) -> None:
    for name in ("budget_weekly_max", "bedrooms", "districts", "soft_preferences", "other_confirmed"):
        if getattr(before, name) != getattr(after, name):
            raise SimulationIntegrityError(f"模拟不允许修改 {name}")


def apply_station_walk(state: UserState, requirement: StationWalkRequirement) -> UserState:
    updated = state.with_station_walk(requirement)
    _assert_only_station_walk_changed(state, updated)
    return updated


def apply_patch(state: UserState, patch: Mapping[str, Any]) -> UserState:
    """把 station_walk 补丁应用到给定状态；其他字段一律拒绝。"""
    if not isinstance(patch, Mapping):
        raise ValidationError("patch 必须是对象")
    unknown = set(patch) - {"station_walk"}
    if unknown:
        raise ValidationError(f"本版补丁只允许修改 station_walk，收到 {sorted(unknown)}")
    if "station_walk" not in patch:
        raise ValidationError("patch 缺少 station_walk")
    requirement = StationWalkRequirement.from_payload(patch["station_walk"])
    return apply_station_walk(state, requirement)


def matches_hard_requirements(state: UserState, listing: Listing) -> bool:
    """按已确认硬要求筛选：预算（含允许超出比例）、卧室、区域、排除区域、宠物/家具/车位、车站距离。

    宠物 / 家具 / 车位只排除**明确不满足**的房源（描述写了 no pets、unfurnished、0 车位）；
    描述没写的保留，由排序器扣分并提示"需向中介确认"——否则大多数房源会因为没写而被误删。
    """
    other = state.other_confirmed
    budget = state.budget_weekly_max
    if budget is not None:
        stretch = float(other.get("budget_stretch_pct") or 0.0)
        limit = budget * (1.0 + stretch / 100.0)
        if listing.weekly_rent is None or float(listing.weekly_rent) > limit + 1e-9:
            return False
    excluded = other.get("excluded_districts") or ()
    if excluded and listing.district in excluded:
        return False
    needs = other.get("needs") or {}
    if needs:
        features = listing.extra.get("features") or {}
        for key in ("pets", "furnished", "parking"):
            if needs.get(key) is True and features.get(key) is False:
                return False
    if state.bedrooms is not None:
        if listing.bedrooms is None or int(listing.bedrooms) != int(state.bedrooms):
            return False
    if state.districts:
        if listing.district is None or listing.district not in state.districts:
            return False
    return state.station_walk.allows(listing.station_walk_m)


def filter_feasible(state: UserState, candidates: Sequence[Listing]) -> List[Listing]:
    return [listing for listing in candidates if matches_hard_requirements(state, listing)]


def data_problems(candidates: Sequence[Listing]) -> List[str]:
    """候选池数据完整性；不为缺失距离猜值，也不把数据缺口包装成用户偏好。"""
    problems: List[str] = []
    if len(candidates) > MAX_CANDIDATES:
        problems.append(f"pool_too_large:{len(candidates)}")
    seen = set()
    for listing in candidates:
        if listing.listing_id in seen:
            problems.append(f"duplicate_listing_id:{listing.listing_id}")
        seen.add(listing.listing_id)
        if listing.station_walk_m is None:
            problems.append(f"missing_station_walk:{listing.listing_id}")
        elif listing.distance_kind == DISTANCE_KIND_WALKING_ESTIMATED:
            # 估算口径可以用，但必须带误差带，否则无法判断"差一点点"的房源会不会翻转决策。
            if listing.extra.get(WALK_LOW_KEY) is None or listing.extra.get(WALK_HIGH_KEY) is None:
                problems.append(f"missing_walk_band:{listing.listing_id}")
                continue
            low, high = listing.walk_band()
            if not (0 <= low <= listing.station_walk_m <= high):  # type: ignore[operator]
                problems.append(f"invalid_walk_band:{listing.listing_id}")
        elif listing.distance_kind != DISTANCE_KIND_WALKING:
            problems.append(f"non_walking_distance:{listing.listing_id}:{listing.distance_kind}")
    return problems


DISTANCE_VIEW_POINT = "point"
DISTANCE_VIEW_LOW = "low"     # 乐观：每套房都按误差带下界算（离车站更近）
DISTANCE_VIEW_HIGH = "high"   # 悲观：每套房都按误差带上界算
DISTANCE_VIEWS = (DISTANCE_VIEW_POINT, DISTANCE_VIEW_LOW, DISTANCE_VIEW_HIGH)


def has_distance_uncertainty(candidates: Sequence[Listing]) -> bool:
    for listing in candidates:
        low, high = listing.walk_band()
        if low is not None and high is not None and high > low:
            return True
    return False


def distance_view(candidates: Sequence[Listing], view: str) -> Tuple[Listing, ...]:
    """把候选池换成某个距离视图的副本；原候选对象保持不变。"""
    if view not in DISTANCE_VIEWS:
        raise ValidationError(f"未知距离视图：{view!r}")
    if view == DISTANCE_VIEW_POINT:
        return tuple(candidates)
    out = []
    for listing in candidates:
        low, high = listing.walk_band()
        out.append(listing.with_station_walk_m(low if view == DISTANCE_VIEW_LOW else high))
    return tuple(out)


def ranker_fingerprint(ranker: Any) -> str:
    hook = getattr(ranker, "params_fingerprint", None)
    if callable(hook):
        return str(hook())
    params = getattr(ranker, "params", None)
    if callable(params):
        return sha256_fingerprint(params())
    return ""


def check_ranking(ordered_ids: Sequence[str], feasible: Sequence[Listing]) -> Optional[str]:
    """校验只读排序输出：不含池外 ID、不重复、非空候选至少给一个有效 ID。"""
    if isinstance(ordered_ids, (str, bytes)) or not isinstance(ordered_ids, (list, tuple)):
        raise RankingContractError(f"rank() 必须返回序列，收到 {type(ordered_ids).__name__}")
    feasible_ids = [listing.listing_id for listing in feasible]
    allowed = set(feasible_ids)
    ordered = [str(item) for item in ordered_ids]
    if len(set(ordered)) != len(ordered):
        raise RankingContractError(f"rank() 返回了重复 ID：{ordered}")
    outside = [item for item in ordered if item not in allowed]
    if outside:
        raise RankingContractError(f"rank() 返回了输入集合之外的 ID：{outside}")
    if feasible_ids and not ordered:
        raise RankingContractError("非空候选必须至少返回一个有效 ID")
    if not feasible_ids and ordered:
        raise RankingContractError("空候选集合不应返回任何 ID")
    return ordered[0] if ordered else None


def simulate_question(request: PlanInput, ranker: ReadOnlyRanker,
                      scenarios: Optional[Sequence[Scenario]] = None,
                      view: str = "point") -> Tuple[ScenarioResult, ...]:
    """对回答分支做一次只读模拟，返回互不污染的分支结果。

    view 选择车站距离口径：point（点估计）/ low / high（误差带两端），用于判断决策是否稳健。
    """
    branch_list = list(scenarios) if scenarios is not None else build_scenarios()
    pool = distance_view(request.candidates, view)
    real_state_fingerprint = request.user_state.fingerprint()
    real_candidates_fingerprint = candidates_fingerprint(request.candidates)
    ranker_before = ranker_fingerprint(ranker)
    ranker_snapshot = getattr(ranker, "snapshot_id", None)
    if ranker_snapshot != request.ranker_snapshot_id:
        raise RankingContractError(
            f"推荐器快照不可用：请求 {request.ranker_snapshot_id}，实际 {ranker_snapshot}"
        )

    results: List[ScenarioResult] = []
    for scenario in branch_list:
        simulated_state = apply_station_walk(
            clone_state(request.user_state),
            StationWalkRequirement(status=STATION_CONFIRMED, max_m=scenario.max_m),
        )
        feasible = filter_feasible(simulated_state, pool)
        ordered = ranker.rank(simulated_state, [listing for listing in feasible], request.ranker_snapshot_id)
        top_listing_id = check_ranking(ordered, feasible)
        results.append(ScenarioResult(
            scenario_id=scenario.scenario_id,
            assumption=scenario.assumption(),
            next_state_patch=scenario.next_state_patch(),
            feasible_listing_ids=tuple(listing.listing_id for listing in feasible),
            top_listing_id=top_listing_id,
            outcome=OUTCOME_HAS_MATCH if top_listing_id is not None else OUTCOME_NO_MATCH,
            source=SOURCE_SIMULATION,
            candidate_count=len(feasible),
            candidate_snapshot_id=request.candidate_snapshot_id,
            ranker_snapshot_id=request.ranker_snapshot_id,
        ))

    if request.user_state.fingerprint() != real_state_fingerprint:
        raise SimulationIntegrityError("模拟改动了真实档案")
    if candidates_fingerprint(request.candidates) != real_candidates_fingerprint:
        raise SimulationIntegrityError("模拟改动了候选快照")
    if ranker_fingerprint(ranker) != ranker_before:
        raise SimulationIntegrityError("模拟改动了推荐器参数")
    return tuple(results)


def branch_tops(results: Sequence[ScenarioResult]) -> Tuple[str, ...]:
    """分支首选序列；无房源记为 NO_MATCH 而不是删除该分支。"""
    return tuple(result.top_listing_id if result.top_listing_id is not None else "NO_MATCH"
                 for result in results)
