"""一步规划器：比较三个分支的首选是否一致，决定问还是推荐（实施策划 §6.2、§6.3）。

顺序严格按 §6.3 伪代码：版本 -> 空池 -> 已知/已问/已跳过 -> 数据完整性 -> 三分支模拟 -> 决策。
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, Optional, Sequence, Tuple

from .scenarios import AdaptiveQuestion, build_adaptive_question, standard_question
from .transition import (
    DISTANCE_VIEW_HIGH,
    DISTANCE_VIEW_LOW,
    ReadOnlyRanker,
    branch_tops,
    data_problems,
    has_distance_uncertainty,
    ranker_fingerprint,
    simulate_question,
)
from .types import (
    ACTION_ASK,
    ACTION_FALLBACK,
    ACTION_NEEDS_DATA,
    ACTION_NO_MATCH,
    ACTION_RECOMMEND,
    MODEL_VERSION,
    QUESTION_KEY,
    STATION_CONFIRMED,
    STATION_DEFERRED,
    PlanInput,
    PlanResult,
    RankingContractError,
    Scenario,
    ScenarioResult,
    SimulationIntegrityError,
)

def _boot_diagnostics(request: PlanInput, simulation_id: str) -> Dict[str, Any]:
    return {
        "simulation_id": simulation_id,
        "session_id": request.session_id,
        "search_id": request.search_id,
        "state_version": request.state_version,
        "candidate_snapshot_id": request.candidate_snapshot_id,
        "ranker_snapshot_id": request.ranker_snapshot_id,
        "model_version": MODEL_VERSION,
        "candidate_count": len(request.candidates),
    }


def _finish(action: str, reason_code: str, request: PlanInput, diagnostics: Dict[str, Any], started: float,
            *, results: Sequence[ScenarioResult] = (), divergence: Optional[float] = None,
            question: bool = False, payload_error: Optional[str] = None,
            adaptive: Optional[AdaptiveQuestion] = None) -> PlanResult:
    diagnostics = dict(diagnostics)
    diagnostics["duration_ms"] = round((time.perf_counter() - started) * 1000.0, 3)
    diagnostics["action"] = action
    diagnostics["reason_code"] = reason_code
    if payload_error is not None:
        diagnostics["payload_error"] = payload_error
    if results:
        diagnostics["branch_tops"] = list(branch_tops(results))
        diagnostics["branch_tops_by_scenario"] = {
            result.scenario_id: result.top_listing_id for result in results
        }
        diagnostics["feasible_counts"] = [len(result.feasible_listing_ids) for result in results]
    plan = PlanResult(
        action=action,
        reason_code=reason_code,
        base_state_version=request.state_version,
        divergence=divergence,
        scenarios=tuple(results),
        diagnostics=diagnostics,
    )
    if question:
        question_key, question_text, options = standard_question()
        if adaptive is not None:
            question_text, options = adaptive.question_text, adaptive.options
        plan = PlanResult(
            action=plan.action,
            reason_code=plan.reason_code,
            base_state_version=plan.base_state_version,
            question_key=question_key,
            question_text=question_text,
            options=options,
            divergence=plan.divergence,
            scenarios=plan.scenarios,
            diagnostics=plan.diagnostics,
        )
    return plan


def compute_divergence(results: Sequence[ScenarioResult]) -> float:
    """§6.2 诊断值 1 - 最常见首选出现次数 / 3；不是回答概率，也不是置信度。"""
    if not results:
        return 0.0
    tops = branch_tops(results)
    most_common = max(tops.count(value) for value in set(tops))
    return 1.0 - most_common / float(len(tops))


def _is_divergent(results: Sequence[ScenarioResult]) -> bool:
    return len(set(branch_tops(results))) > 1


def _boundary_listing_ids(request: PlanInput, results: Sequence[ScenarioResult]) -> list:
    """误差带跨过任一分支阈值的房源：它们算进还是算出，取决于估算误差。"""
    limits = [result.assumption.get("station_walk_max_m") for result in results]
    limits = [float(value) for value in limits if value is not None]
    out = []
    for listing in request.candidates:
        low, high = listing.walk_band()
        if low is None or high is None:
            continue
        if any(low <= limit < high for limit in limits):
            out.append(listing.listing_id)
    return sorted(out)


def _low_regret_choice(request: PlanInput, ranker: Any, results: Sequence[ScenarioResult],
                       tolerance: float) -> Optional[Dict[str, Any]]:
    """所有分支都可行、且在每个分支里离该分支首选不超过 tolerance 分的房源（取最大遗憾最小者）。

    需要排序器提供 score(state, listing)；没有就返回 None（照常提问）。
    """
    score = getattr(ranker, "score", None)
    if not callable(score) or any(result.top_listing_id is None for result in results):
        return None
    by_id = {listing.listing_id: listing for listing in request.candidates}
    common = set.intersection(*(set(result.feasible_listing_ids) for result in results))
    if not common:
        return None
    state = request.user_state
    best = {result.scenario_id: score(state, by_id[result.top_listing_id]) for result in results}
    regrets = {listing_id: max(score(state, by_id[listing_id]) - best_score for best_score in best.values())
               for listing_id in common}
    choice = min(sorted(regrets), key=lambda listing_id: regrets[listing_id])
    if regrets[choice] > tolerance + 1e-9:
        return None
    return {"listing_id": choice, "max_regret": round(regrets[choice], 3), "tolerance": tolerance}


def plan_next_step(request: PlanInput, ranker: ReadOnlyRanker, *,
                   current_state_version: Optional[int] = None,
                   scenarios: Optional[Sequence[Scenario]] = None,
                   adaptive: bool = False,
                   robust: bool = True,
                   regret_tolerance: Optional[float] = None) -> PlanResult:
    """返回 ask / recommend / no_match / needs_data / fallback 之一。

    adaptive=True：按候选池挑阈值（见 scenarios.build_adaptive_question），否则用标准 400/1000/不设限。
    robust=True：候选带估算误差时，再用误差带两端各模拟一遍；"问不问"的结论被误差翻转时
    返回 needs_data / walk_estimate_ambiguous，并列出需要实测步行路线的房源。
    regret_tolerance：分支首选不同时，若存在一套"每个分支都可行、且离各分支首选都不超过
    tolerance 分"的房源，直接推荐它（recommend / low_regret_choice），不打扰用户。
    分数单位来自排序器（ValueRanker：1 分 ≈ 贵 1% 或超市远 1 分钟）。None 表示关闭。
    """
    started = time.perf_counter()
    simulation_id = uuid.uuid4().hex
    diagnostics = _boot_diagnostics(request, simulation_id)

    if request.payload_error:
        return _finish(ACTION_NEEDS_DATA, "invalid_input", request, diagnostics, started,
                       payload_error=request.payload_error)

    ranker_snapshot = getattr(ranker, "snapshot_id", None)
    if ranker_snapshot != request.ranker_snapshot_id:
        diagnostics["ranker_snapshot_available"] = False
        return _finish(ACTION_FALLBACK, "stale_ranker_snapshot", request, diagnostics, started)

    if current_state_version is not None and current_state_version != request.state_version:
        diagnostics["current_state_version"] = current_state_version
        return _finish(ACTION_FALLBACK, "stale_state", request, diagnostics, started)

    if not request.candidates:
        return _finish(ACTION_NO_MATCH, "base_candidates_empty", request, diagnostics, started)

    requirement = request.station_walk
    if requirement.status == STATION_CONFIRMED:
        diagnostics["station_walk"] = requirement.to_dict()
        return _finish(ACTION_RECOMMEND, "already_confirmed", request, diagnostics, started)
    if requirement.status == STATION_DEFERRED:
        # 跳过必须报 already_skipped：它和 "问过但没记下答案" 是不同原因，日志要能区分。
        return _finish(ACTION_RECOMMEND, "already_skipped", request, diagnostics, started)
    if QUESTION_KEY in request.asked_question_keys:
        return _finish(ACTION_RECOMMEND, "already_asked", request, diagnostics, started)

    problems = data_problems(request.candidates)
    if problems:
        diagnostics["data_problems"] = problems
        return _finish(ACTION_NEEDS_DATA, "data_missing", request, diagnostics, started)

    ranker_before = ranker_fingerprint(ranker)
    adaptive_question: Optional[AdaptiveQuestion] = None
    views: Dict[str, Tuple[ScenarioResult, ...]] = {}
    try:
        if adaptive and scenarios is None:
            adaptive_question = build_adaptive_question(
                request.user_state, request.candidates, ranker, request.ranker_snapshot_id)
            if adaptive_question is not None:
                scenarios = adaptive_question.scenarios
                diagnostics["adaptive"] = dict(adaptive_question.meta)
        results: Tuple[ScenarioResult, ...] = simulate_question(request, ranker, scenarios)
        if robust and results and has_distance_uncertainty(request.candidates):
            for view in (DISTANCE_VIEW_LOW, DISTANCE_VIEW_HIGH):
                views[view] = simulate_question(request, ranker, scenarios, view=view)
    except SimulationIntegrityError as error:
        diagnostics["error"] = str(error)
        return _finish(ACTION_FALLBACK, "simulation_contaminated", request, diagnostics, started)
    except RankingContractError as error:
        diagnostics["error"] = str(error)
        return _finish(ACTION_FALLBACK, "ranker_invalid_output", request, diagnostics, started)
    except Exception as error:  # noqa: BLE001 - 排序器异常一律降级，不伪造成功
        diagnostics["error"] = f"{type(error).__name__}: {error}"
        return _finish(ACTION_FALLBACK, "ranker_error", request, diagnostics, started)

    if ranker_fingerprint(ranker) != ranker_before:
        return _finish(ACTION_FALLBACK, "simulation_contaminated", request, diagnostics, started,
                       results=results)

    if not results:
        # 没有任何分支就没有"一致"可言；空口返回 recommend 等于凭空造结论。
        return _finish(ACTION_FALLBACK, "no_scenarios", request, diagnostics, started)

    tops = branch_tops(results)
    divergence = compute_divergence(results)
    diagnostics["real_state_fingerprint"] = request.user_state.fingerprint()
    if views:
        diagnostics["branch_tops_by_view"] = {view: list(branch_tops(found)) for view, found in views.items()}
        decisions = {_is_divergent(results)} | {_is_divergent(found) for found in views.values()}
        diagnostics["decision_robust"] = len(decisions) == 1
        boundary = _boundary_listing_ids(request, results)
        if boundary:
            diagnostics["boundary_listing_ids"] = boundary
        if len(decisions) > 1:
            # 问不问取决于估算误差：先补实测步行路线，而不是拿一个可能多余的问题打扰用户。
            return _finish(ACTION_NEEDS_DATA, "walk_estimate_ambiguous", request, diagnostics, started,
                           results=results, divergence=divergence)
    if len(set(tops)) > 1 and regret_tolerance is not None:
        try:
            choice = _low_regret_choice(request, ranker, results, float(regret_tolerance))
        except Exception as error:  # noqa: BLE001 - 打分失败就照常提问，不伪造推荐
            diagnostics["low_regret_error"] = f"{type(error).__name__}: {error}"
            choice = None
        if choice is not None:
            diagnostics["low_regret"] = choice
            return _finish(ACTION_RECOMMEND, "low_regret_choice", request, diagnostics, started,
                           results=results, divergence=divergence)
    if len(set(tops)) > 1:
        return _finish(ACTION_ASK, "different_top_choice", request, diagnostics, started,
                       results=results, divergence=divergence, question=True,
                       adaptive=adaptive_question)
    return _finish(ACTION_RECOMMEND, "all_branches_agree", request, diagnostics, started,
                   results=results, divergence=divergence)
