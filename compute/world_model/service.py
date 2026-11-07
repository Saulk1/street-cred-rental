"""接入参考实现：问题登记、真实回答写入与重新推荐（实施策划 §5.3、§7、§9）。

生产环境由现有档案/编排服务承担同样职责；这里给出可运行、可测的最小参考实现：
- ask 只是一个提案，必须先按 (search_id, question_key) 原子登记并取得 question_id 才能展示；
- 并发请求复用同一条 pending 记录；刷新恢复同一 question_id，不重新规划；
- event_id 幂等、state_version 比较后原子写入；旧按钮不得覆盖新档案。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from .answer import resolve_answer
from .planner import plan_next_step
from .scenarios import (
    SCENARIO_LE_400,
    SCENARIO_LE_1000,
    SCENARIO_NO_LIMIT,
    standard_question,
)
from .transition import ReadOnlyRanker, apply_patch, check_ranking, filter_feasible
from .types import (
    ACTION_FALLBACK,
    ACTION_NEEDS_DATA,
    ACTION_NO_MATCH,
    ACTION_RECOMMEND,
    QUESTION_KEY,
    RESOLUTION_SKIPPED,
    RESOLUTION_STALE,
    STATION_CONFIRMED,
    AnswerInput,
    AnswerResolution,
    Listing,
    PlanInput,
    PlanResult,
    QuestionOption,
    UserState,
    ValidationError,
)

STATUS_PENDING = "pending"
STATUS_ANSWERED = "answered"
STATUS_SKIPPED = "skipped"
STATUS_INVALIDATED = "invalidated"

# §5.3 的 pending 问题是有寿命的：太久没人回答就恢复成一条正常推荐，而不是一直挂着。
DEFAULT_PENDING_TTL_S = 30 * 60.0

REASON_RESTORED_PENDING = "restored_pending"
REASON_UNKNOWN_QUESTION = "unknown_question"

# 真实回答落回哪个标准分支（None 表示“不设硬限制”）；自定义距离不参与一致性对比。
_STANDARD_BRANCH_BY_LIMIT: Dict[Optional[float], str] = {
    400.0: SCENARIO_LE_400,
    1000.0: SCENARIO_LE_1000,
    None: SCENARIO_NO_LIMIT,
}


class StaleProfileError(RuntimeError):
    """写入时档案版本已变化。"""


@dataclass
class QuestionRecord:
    question_id: str
    session_id: str
    search_id: str
    question_key: str
    base_state_version: int
    question_text: str
    options: Tuple[QuestionOption, ...]
    status: str = STATUS_PENDING
    created_at: float = field(default_factory=time.time)
    event_id: Optional[str] = None
    simulation: Optional[Dict[str, Any]] = None


@dataclass
class EventRecord:
    event_id: str
    question_id: str
    state_version: int
    resolution: AnswerResolution
    applied: bool


class ProfileStore:
    """真实档案参考存储：只由 apply_answer 改写，模拟永远碰不到它。"""

    def __init__(self, user_state: UserState, state_version: int = 1) -> None:
        self._lock = threading.RLock()
        self._state = user_state
        self._version = state_version
        self._events: Dict[str, EventRecord] = {}

    def snapshot(self) -> Tuple[int, UserState]:
        with self._lock:
            return self._version, self._state

    def replay(self, event_id: str) -> Optional[EventRecord]:
        with self._lock:
            return self._events.get(event_id)

    def apply_answer(self, *, expected_version: int, patch: Mapping[str, Any], event_id: str,
                     question_id: str, resolution: AnswerResolution) -> EventRecord:
        with self._lock:
            existing = self._events.get(event_id)
            if existing is not None:
                return existing
            if expected_version != self._version:
                raise StaleProfileError(
                    f"档案版本已变化：期望 {expected_version}，当前 {self._version}"
                )
            self._state = apply_patch(self._state, patch)
            self._version += 1
            record = EventRecord(event_id=event_id, question_id=question_id,
                                 state_version=self._version, resolution=resolution, applied=True)
            self._events[event_id] = record
            return record


class QuestionRegistry:
    """(search_id, question_key) 唯一键的问题登记表。"""

    def __init__(self, id_prefix: str = "question",
                 pending_ttl_s: Optional[float] = DEFAULT_PENDING_TTL_S) -> None:
        self._lock = threading.RLock()
        self._by_key: Dict[Tuple[str, str], QuestionRecord] = {}
        self._by_id: Dict[str, QuestionRecord] = {}
        self._id_prefix = id_prefix
        self._pending_ttl_s = pending_ttl_s

    def register(self, *, session_id: str, search_id: str, question_key: str,
                 base_state_version: int, question_text: str,
                 options: Sequence[QuestionOption],
                 simulation: Optional[Mapping[str, Any]] = None) -> Tuple[QuestionRecord, bool]:
        with self._lock:
            key = (search_id, question_key)
            existing = self._by_key.get(key)
            if existing is not None and existing.status == STATUS_PENDING:
                return existing, False
            if existing is not None and existing.status in (STATUS_ANSWERED, STATUS_SKIPPED):
                return existing, False
            question_id = f"{self._id_prefix}-{len(self._by_id) + 1:03d}"
            record = QuestionRecord(
                question_id=question_id, session_id=session_id, search_id=search_id,
                question_key=question_key, base_state_version=base_state_version,
                question_text=question_text, options=tuple(options),
                simulation=dict(simulation) if simulation else None,
            )
            self._by_key[key] = record
            self._by_id[question_id] = record
            return record, True

    def pending(self, search_id: str, question_key: str = QUESTION_KEY,
                now: Optional[float] = None) -> Optional[QuestionRecord]:
        with self._lock:
            record = self._by_key.get((search_id, question_key))
            if record is None or record.status != STATUS_PENDING:
                return None
            if self._pending_ttl_s is not None:
                current = time.time() if now is None else now
                if current - record.created_at > self._pending_ttl_s:
                    return None  # 过期不再恢复；记录仍留在账本里，保证同一任务不二次提问
            return record

    def get(self, question_id: str) -> Optional[QuestionRecord]:
        with self._lock:
            return self._by_id.get(question_id)

    def asked_keys(self, search_id: str) -> Tuple[str, ...]:
        """本任务问过的键：只要登记过就算问过（失效/过期也算）。

        §4.2 与全局约束要求"每次找房任务最多主动问一次"，失效记录若从账本里掉出去，
        档案版本一变就能再问一次，违反约束。
        """
        with self._lock:
            return tuple(
                record.question_key
                for (owner, _), record in self._by_key.items()
                if owner == search_id
            )

    def mark_resolved(self, question_id: str, status: str, event_id: str) -> None:
        with self._lock:
            record = self._by_id[question_id]
            record.status = STATUS_SKIPPED if status == RESOLUTION_SKIPPED else STATUS_ANSWERED
            record.event_id = event_id

    def invalidate(self, question_id: str) -> None:
        """只让 pending 失效。已答/已跳过的记录必须留着，它是"本次任务已问过"的凭据。"""
        with self._lock:
            record = self._by_id.get(question_id)
            if record is not None and record.status == STATUS_PENDING:
                record.status = STATUS_INVALIDATED

    def records(self) -> List[QuestionRecord]:
        with self._lock:
            return list(self._by_id.values())


class OrchestrationService:
    """把规划、登记、真实写入、重新推荐串起来的参考编排。"""

    def __init__(self, *, store: ProfileStore, ranker: ReadOnlyRanker,
                 candidate_provider: Callable[[str], Tuple[str, Sequence[Listing]]],
                 registry: Optional[QuestionRegistry] = None,
                 session_id: str = "demo-session",
                 adaptive_questions: bool = False,
                 regret_tolerance: Optional[float] = None) -> None:
        self._lock = threading.RLock()
        self.store = store
        self.ranker = ranker
        self.candidate_provider = candidate_provider
        self.registry = registry if registry is not None else QuestionRegistry()
        self.session_id = session_id
        self.adaptive_questions = adaptive_questions
        self.regret_tolerance = regret_tolerance

    # --- 发问 ---
    def request_plan(self, search_id: str, session_id: Optional[str] = None) -> PlanResult:
        session = session_id or self.session_id
        with self._lock:
            pending = self.registry.pending(search_id, QUESTION_KEY)
            version, state = self.store.snapshot()
            if pending is not None:
                if pending.base_state_version == version:
                    return self._restored_plan(pending)
                self.registry.invalidate(pending.question_id)

            ranker_snapshot = getattr(self.ranker, "snapshot_id", "")
            if not ranker_snapshot:
                return PlanResult(action=ACTION_FALLBACK, reason_code="stale_ranker_snapshot",
                                  base_state_version=version,
                                  diagnostics={"reason": "推荐器缺少 snapshot_id", "search_id": search_id})

            try:
                snapshot_id, candidates = self.candidate_provider(search_id)
            except Exception as error:  # noqa: BLE001
                return PlanResult(action=ACTION_FALLBACK, reason_code="candidate_snapshot_unavailable",
                                  base_state_version=version,
                                  diagnostics={"reason": f"{type(error).__name__}: {error}",
                                               "search_id": search_id})
            try:
                request = PlanInput(
                    session_id=session, search_id=search_id, state_version=version,
                    candidate_snapshot_id=snapshot_id,
                    ranker_snapshot_id=ranker_snapshot,
                    user_state=state, candidates=tuple(candidates),
                    asked_question_keys=self.registry.asked_keys(search_id),
                )
            except ValidationError as error:
                # 现有系统给出违约候选池（超 20 套、重复 ID 等）时交回核实，不让请求 500。
                return PlanResult(action=ACTION_NEEDS_DATA, reason_code="invalid_input",
                                  base_state_version=version,
                                  diagnostics={"reason": str(error), "search_id": search_id})
            plan = plan_next_step(request, self.ranker, current_state_version=version,
                                  adaptive=self.adaptive_questions,
                                  regret_tolerance=self.regret_tolerance)
            if not plan.is_ask:
                return plan
            question_key = plan.question_key or QUESTION_KEY
            question_text = plan.question_text or standard_question()[1]
            options = plan.options or standard_question()[2]
            record, _created = self.registry.register(
                session_id=session, search_id=search_id, question_key=question_key,
                base_state_version=version, question_text=question_text, options=options,
                simulation={
                    "branch_tops": plan.diagnostics.get("branch_tops_by_scenario"),
                    "scenario_limits": {result.scenario_id: result.assumption.get("station_walk_max_m")
                                        for result in plan.scenarios},
                    "feasible_counts": plan.diagnostics.get("feasible_counts"),
                    "divergence": plan.divergence,
                    "candidate_snapshot_id": plan.diagnostics.get("candidate_snapshot_id"),
                    "ranker_snapshot_id": plan.diagnostics.get("ranker_snapshot_id"),
                    "model_version": plan.diagnostics.get("model_version"),
                },
            )
            return plan.with_question_id(record.question_id)

    def _restored_plan(self, record: QuestionRecord) -> PlanResult:
        return PlanResult(
            action="ask", reason_code=REASON_RESTORED_PENDING,
            base_state_version=record.base_state_version,
            question_key=record.question_key, question_id=record.question_id,
            question_text=record.question_text, options=record.options,
            diagnostics={"restored": True, "search_id": record.search_id},
        )

    # --- 真实回答 ---
    def submit_answer(self, *, question_id: str, event_id: str, option_id: Optional[str] = None,
                      custom_text: Optional[str] = None) -> Dict[str, Any]:
        with self._lock:
            record = self.registry.get(question_id)
            if record is None:
                resolution = AnswerResolution(
                    status="invalid_answer", reason_code=REASON_UNKNOWN_QUESTION,
                    message="找不到这个问题，请刷新后重试。", question_id=question_id, event_id=event_id,
                )
                return {"resolution": resolution.to_dict(), "duplicate": False, "recommendation": None}

            replay = self.store.replay(event_id)
            if replay is not None:
                recommendation = self.recommend(record.search_id)
                return {"resolution": replay.resolution.to_dict(), "duplicate": True,
                        "state_version": replay.state_version,
                        "recommendation": recommendation,
                        "branch_consistency": self._branch_consistency(record, record.search_id, recommendation)}

            version, state = self.store.snapshot()
            resolution = resolve_answer(AnswerInput(
                question_id=question_id, event_id=event_id,
                base_state_version=record.base_state_version, current_state_version=version,
                current_state=state, option_id=option_id, custom_text=custom_text,
                session_id=record.session_id, search_id=record.search_id,
                options=record.options,
            ))

            if resolution.status == RESOLUTION_STALE:
                self.registry.invalidate(question_id)
                return {"resolution": resolution.to_dict(), "duplicate": False,
                        "current_state_version": version, "recommendation": None}

            if not resolution.is_applicable:
                return {"resolution": resolution.to_dict(), "duplicate": False, "recommendation": None}

            try:
                event = self.store.apply_answer(
                    expected_version=record.base_state_version, patch=resolution.state_patch,
                    event_id=event_id, question_id=question_id, resolution=resolution,
                )
            except StaleProfileError:
                self.registry.invalidate(question_id)
                stale = replace(resolution, status=RESOLUTION_STALE, reason_code="stale_state",
                                state_patch=None, next_state=None, should_recommend=False,
                                message="档案已更新，这个回答未写入。")
                return {"resolution": stale.to_dict(), "duplicate": False,
                        "current_state_version": self.store.snapshot()[0], "recommendation": None}

            self.registry.mark_resolved(question_id, resolution.status, event_id)
            recommendation = self.recommend(record.search_id)
            return {"resolution": resolution.to_dict(), "duplicate": False,
                    "state_version": event.state_version,
                    "recommendation": recommendation,
                    "branch_consistency": self._branch_consistency(record, record.search_id, recommendation)}

    def _branch_consistency(self, record: QuestionRecord, search_id: str,
                            recommendation: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
        """§12.2：回答落入标准分支且版本相同时，模拟首选应与真实重算首选一致。"""
        summary = record.simulation
        if not summary:
            return None
        if recommendation.get("action") == ACTION_FALLBACK:
            return {"matched_scenario": None, "reason": "recommendation_unavailable", "consistent": None}
        _version, profile = self.store.snapshot()
        requirement = profile.station_walk
        if requirement.status != STATION_CONFIRMED:
            return {"matched_scenario": None, "reason": "requirement_not_confirmed", "consistent": None}
        limit = None if requirement.max_m is None else float(requirement.max_m)
        scenario_limits = summary.get("scenario_limits") or {}
        scenario_id = next((sid for sid, value in scenario_limits.items()
                            if (value is None and limit is None)
                            or (value is not None and limit is not None and float(value) == limit)), None)
        if scenario_id is None and not scenario_limits:
            scenario_id = _STANDARD_BRANCH_BY_LIMIT.get(limit)
        if scenario_id is None:
            return {"matched_scenario": None, "reason": "custom_distance_outside_standard_branches",
                    "consistent": None}
        snapshot_id, _candidates = self.candidate_provider(search_id)
        if (snapshot_id != summary.get("candidate_snapshot_id")
                or getattr(self.ranker, "snapshot_id", None) != summary.get("ranker_snapshot_id")):
            return {"matched_scenario": scenario_id, "reason": "snapshot_changed", "consistent": None}
        simulated_top = (summary.get("branch_tops") or {}).get(scenario_id)
        real_top = recommendation.get("top_listing_id")
        return {"matched_scenario": scenario_id, "simulated_top": simulated_top,
                "real_top": real_top, "consistent": simulated_top == real_top}

    # --- 真实档案上的推荐（绝不自动放宽条件，也不使用模拟结果） ---
    def recommend(self, search_id: str) -> Dict[str, Any]:
        with self._lock:
            version, state = self.store.snapshot()
            _snapshot_id, candidates = self.candidate_provider(search_id)
            feasible = filter_feasible(state, candidates)
            listing_ids = [listing.listing_id for listing in feasible]
            try:
                ordered = self.ranker.rank(state, list(feasible),
                                           getattr(self.ranker, "snapshot_id", ""))
                top_listing_id = check_ranking(ordered, feasible)
            except Exception as error:  # noqa: BLE001
                # 真实回答此刻已经写进档案，推荐器故障不能把整次回答变成失败；
                # 降级交回原推荐流程，绝不臆造一个排序结果。
                return {
                    "action": ACTION_FALLBACK,
                    "reason_code": "ranker_error",
                    "state_version": version,
                    "listing_ids": listing_ids,
                    "top_listing_id": None,
                    "message": "推荐服务暂时不可用，你的要求已记录，请稍后重试。",
                    "error": f"{type(error).__name__}: {error}",
                }
            return {
                "action": ACTION_RECOMMEND if top_listing_id is not None else ACTION_NO_MATCH,
                "state_version": version,
                "listing_ids": listing_ids,
                "top_listing_id": top_listing_id,
                "message": "" if top_listing_id is not None else "当前没有同时满足这些条件的房源，你可以调整要求。",
            }
