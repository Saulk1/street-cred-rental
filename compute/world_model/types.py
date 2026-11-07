"""世界模型模块的类型契约（对应实施策划 §5 输入/输出、§9 核心接口）。

字段语义按策划第 5.1 节冻结；这里只做规则驱动的状态与结果建模，
不训练模型、不学习用户回答概率、不接触真实档案写入。
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

MODEL_VERSION = "rule-v0.2"
QUESTION_KEY = "station_walk_max_m"
MAX_CANDIDATES = 20

STATION_UNKNOWN = "unknown"
STATION_CONFIRMED = "confirmed"
STATION_DEFERRED = "deferred"
STATION_STATUSES = (STATION_UNKNOWN, STATION_CONFIRMED, STATION_DEFERRED)

DISTANCE_KIND_WALKING = "walking"
# 由直线距离 × 绕路系数估算的步行距离；必须在 extra 里带 station_walk_m_low / station_walk_m_high 误差带。
DISTANCE_KIND_WALKING_ESTIMATED = "walking_estimated"
WALK_LOW_KEY = "station_walk_m_low"
WALK_HIGH_KEY = "station_walk_m_high"
SOURCE_SIMULATION = "simulation"
DATA_MODE_REAL = "real"
DATA_MODE_DEMO = "demo"
DATA_MODES = (DATA_MODE_REAL, DATA_MODE_DEMO)

ACTION_ASK = "ask"
ACTION_RECOMMEND = "recommend"
ACTION_NO_MATCH = "no_match"
ACTION_NEEDS_DATA = "needs_data"
ACTION_FALLBACK = "fallback"
ACTIONS = (ACTION_ASK, ACTION_RECOMMEND, ACTION_NO_MATCH, ACTION_NEEDS_DATA, ACTION_FALLBACK)

OUTCOME_HAS_MATCH = "has_match"
OUTCOME_NO_MATCH = "no_match"

OPTION_CONFIRM_LIMIT = "confirm_limit"
OPTION_CONFIRM_NO_LIMIT = "confirm_no_limit"
OPTION_SKIP = "skip"

RESOLUTION_APPLIED = "applied"
RESOLUTION_SKIPPED = "skipped"
RESOLUTION_INVALID = "invalid_answer"
RESOLUTION_STALE = "stale_state"


class ValidationError(ValueError):
    """字段违反冻结契约。"""


class SimulationIntegrityError(RuntimeError):
    """模拟过程中真实状态、候选快照或推荐器参数被改动。"""


class RankingContractError(RuntimeError):
    """只读推荐器违反 rank() 的输出契约。"""


def _json_default(value: Any) -> str:
    """真实档案里可能带 date / Decimal / UUID；指纹用于前后对比，不要求跨进程一致。"""
    return f"<{type(value).__name__}:{value!r}>"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      default=_json_default)


def sha256_fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{name} 必须是数字，收到 {type(value).__name__}")
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        raise ValidationError(f"{name} 必须是有限数")
    if number < 0:
        raise ValidationError(f"{name} 不能为负数")
    return number


def optional_finite_number(value: Any, name: str) -> Optional[float]:
    if value is None:
        return None
    return finite_number(value, name)


def non_empty_text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{name} 必须是非空字符串")
    return value.strip()


def mapping_copy(value: Any, name: str) -> Dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValidationError(f"{name} 必须是对象")
    return copy.deepcopy({str(key): value[key] for key in value})


@dataclass(frozen=True)
class StationWalkRequirement:
    """车站步行距离要求：unknown / confirmed / deferred 三种状态必须可区分。"""

    status: str = STATION_UNKNOWN
    max_m: Optional[float] = None

    def __post_init__(self) -> None:
        if self.status not in STATION_STATUSES:
            raise ValidationError(f"station_walk.status 只能是 {STATION_STATUSES}，收到 {self.status!r}")
        if self.max_m is not None:
            object.__setattr__(self, "max_m", finite_number(self.max_m, "station_walk.max_m"))
        if self.status != STATION_CONFIRMED and self.max_m is not None:
            raise ValidationError("只有 confirmed 才能带 max_m；unknown/deferred 保持未知")

    @property
    def is_known(self) -> bool:
        return self.status == STATION_CONFIRMED

    @property
    def has_numeric_limit(self) -> bool:
        return self.status == STATION_CONFIRMED and self.max_m is not None

    def allows(self, walk_m: Optional[float]) -> bool:
        if not self.has_numeric_limit:
            return True
        if walk_m is None:
            return False
        return float(walk_m) <= float(self.max_m) + 1e-9  # type: ignore[arg-type]

    def to_dict(self) -> Dict[str, Any]:
        return {"status": self.status, "max_m": self.max_m}

    @classmethod
    def from_payload(cls, payload: Any) -> "StationWalkRequirement":
        if payload is None:
            return cls()
        if isinstance(payload, StationWalkRequirement):
            return payload
        if not isinstance(payload, Mapping):
            raise ValidationError("station_walk 必须是对象")
        return cls(status=payload.get("status", STATION_UNKNOWN), max_m=payload.get("max_m"))


@dataclass(frozen=True)
class Listing:
    """候选房源：距离口径、单位为米，station_walk_m 为 None 表示缺失（不得补 0）。"""

    listing_id: str
    station_walk_m: Optional[float] = None
    distance_kind: str = DISTANCE_KIND_WALKING
    weekly_rent: Optional[float] = None
    bedrooms: Optional[int] = None
    district: Optional[str] = None
    supermarket_walk_min: Optional[float] = None
    source: str = DATA_MODE_REAL
    collected_at: Optional[str] = None
    extra: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "listing_id", non_empty_text(self.listing_id, "listing_id"))
        object.__setattr__(self, "station_walk_m",
                           optional_finite_number(self.station_walk_m, "station_walk_m"))
        object.__setattr__(self, "weekly_rent", optional_finite_number(self.weekly_rent, "weekly_rent"))
        object.__setattr__(self, "supermarket_walk_min",
                           optional_finite_number(self.supermarket_walk_min, "supermarket_walk_min"))
        object.__setattr__(self, "distance_kind", non_empty_text(self.distance_kind, "distance_kind"))
        if self.source not in DATA_MODES:
            raise ValidationError(f"source 只能是 {DATA_MODES}，收到 {self.source!r}")
        if self.bedrooms is not None:
            if isinstance(self.bedrooms, bool) or not isinstance(self.bedrooms, int) or self.bedrooms < 0:
                raise ValidationError("bedrooms 必须是非负整数")
        if self.district is not None:
            object.__setattr__(self, "district", non_empty_text(self.district, "district"))
        object.__setattr__(self, "extra", mapping_copy(self.extra, "extra"))

    @property
    def is_demo(self) -> bool:
        return self.source == DATA_MODE_DEMO

    def walk_band(self) -> Tuple[Optional[float], Optional[float]]:
        """车站步行距离的 (下界, 上界)；实测口径下界=上界=点值，缺失时都是 None。"""
        if self.station_walk_m is None:
            return None, None
        low = self.extra.get(WALK_LOW_KEY)
        high = self.extra.get(WALK_HIGH_KEY)
        if low is None or high is None:
            return self.station_walk_m, self.station_walk_m
        return float(low), float(high)

    def with_station_walk_m(self, walk_m: Optional[float]) -> "Listing":
        """返回只替换车站距离的副本（用于误差带的乐观 / 悲观视图，不改原对象）。"""
        return replace(self, station_walk_m=walk_m)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "listing_id": self.listing_id,
            "station_walk_m": self.station_walk_m,
            "distance_kind": self.distance_kind,
            "weekly_rent": self.weekly_rent,
            "bedrooms": self.bedrooms,
            "district": self.district,
            "supermarket_walk_min": self.supermarket_walk_min,
            "source": self.source,
            "collected_at": self.collected_at,
            "extra": dict(self.extra),
        }

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "Listing":
        if not isinstance(payload, Mapping):
            raise ValidationError("candidate 必须是对象")
        allowed = {
            "listing_id", "station_walk_m", "distance_kind", "weekly_rent", "bedrooms",
            "district", "supermarket_walk_min", "source", "collected_at", "extra",
        }
        kwargs = {key: payload[key] for key in allowed if key in payload}
        kwargs.setdefault("source", payload.get("data_mode", DATA_MODE_REAL))
        rest = {key: payload[key] for key in payload if key not in allowed}
        if rest:
            kwargs["extra"] = {**dict(kwargs.get("extra") or {}), **rest}
        return cls(**kwargs)


@dataclass(frozen=True)
class UserState:
    """真实档案的可模拟视图：硬要求、软偏好与车站要求，全部随快照保留。"""

    station_walk: StationWalkRequirement = field(default_factory=StationWalkRequirement)
    budget_weekly_max: Optional[float] = None
    bedrooms: Optional[int] = None
    districts: Tuple[str, ...] = ()
    soft_preferences: Mapping[str, Any] = field(default_factory=dict)
    other_confirmed: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "budget_weekly_max",
                           optional_finite_number(self.budget_weekly_max, "budget_weekly_max"))
        if self.bedrooms is not None:
            if isinstance(self.bedrooms, bool) or not isinstance(self.bedrooms, int) or self.bedrooms < 0:
                raise ValidationError("bedrooms 必须是非负整数")
        if isinstance(self.districts, str):
            raise ValidationError("districts 必须是字符串序列")
        object.__setattr__(self, "districts", tuple(non_empty_text(item, "districts[]") for item in self.districts))
        object.__setattr__(self, "soft_preferences", mapping_copy(self.soft_preferences, "soft_preferences"))
        object.__setattr__(self, "other_confirmed", mapping_copy(self.other_confirmed, "other_confirmed"))

    def with_station_walk(self, requirement: StationWalkRequirement) -> "UserState":
        return replace(self, station_walk=requirement)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "station_walk": self.station_walk.to_dict(),
            "budget_weekly_max": self.budget_weekly_max,
            "bedrooms": self.bedrooms,
            "districts": list(self.districts),
            "soft_preferences": dict(self.soft_preferences),
            "other_confirmed": dict(self.other_confirmed),
        }

    def fingerprint(self) -> str:
        return sha256_fingerprint(self.to_dict())


def candidates_fingerprint(candidates: Sequence[Listing]) -> str:
    return sha256_fingerprint([listing.to_dict() for listing in candidates])


@dataclass(frozen=True)
class PlanInput:
    """§5.1 输入契约：真实档案视图 + 固定候选池 + 两个快照版本。"""

    session_id: str
    search_id: str
    state_version: int
    candidate_snapshot_id: str
    ranker_snapshot_id: str
    user_state: UserState
    candidates: Tuple[Listing, ...]
    asked_question_keys: Tuple[str, ...] = ()
    payload_error: Optional[str] = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "session_id", non_empty_text(self.session_id, "session_id"))
        object.__setattr__(self, "search_id", non_empty_text(self.search_id, "search_id"))
        object.__setattr__(self, "candidate_snapshot_id",
                           non_empty_text(self.candidate_snapshot_id, "candidate_snapshot_id"))
        object.__setattr__(self, "ranker_snapshot_id",
                           non_empty_text(self.ranker_snapshot_id, "ranker_snapshot_id"))
        if isinstance(self.state_version, bool) or not isinstance(self.state_version, int) or self.state_version < 0:
            raise ValidationError("state_version 必须是非负整数")
        if not isinstance(self.user_state, UserState):
            raise ValidationError("user_state 必须是 UserState")
        if isinstance(self.asked_question_keys, str):
            raise ValidationError("asked_question_keys 必须是字符串序列")
        object.__setattr__(self, "asked_question_keys",
                           tuple(non_empty_text(key, "asked_question_keys[]") for key in self.asked_question_keys))
        candidates = tuple(self.candidates)
        for listing in candidates:
            if not isinstance(listing, Listing):
                raise ValidationError("candidates 只能包含 Listing")
        if len(candidates) > MAX_CANDIDATES:
            raise ValidationError(f"候选池最多 {MAX_CANDIDATES} 套，收到 {len(candidates)}")
        seen = set()
        for listing in candidates:
            if listing.listing_id in seen:
                raise ValidationError(f"候选 listing_id 重复：{listing.listing_id}")
            seen.add(listing.listing_id)
        object.__setattr__(self, "candidates", candidates)

    @property
    def station_walk(self) -> StationWalkRequirement:
        return self.user_state.station_walk

    def to_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "search_id": self.search_id,
            "state_version": self.state_version,
            "candidate_snapshot_id": self.candidate_snapshot_id,
            "ranker_snapshot_id": self.ranker_snapshot_id,
            "station_walk": self.station_walk.to_dict(),
            "asked_question_keys": list(self.asked_question_keys),
            "user_state": self.user_state.to_dict(),
            "candidates": [listing.to_dict() for listing in self.candidates],
            "payload_error": self.payload_error,
        }

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "PlanInput":
        """解析不可信快照。

        房源与档案内容的问题一律转成 payload_error（规划据此返回 needs_data），不抛异常；
        信封字段（session_id / search_id / state_version / 两个 snapshot_id）缺失或类型不对
        属于调用方违约，仍然抛 ValidationError，以免把明显错拼的请求当成数据问题。
        """
        if not isinstance(payload, Mapping):
            raise ValidationError("PlanInput payload 必须是对象")
        raw_state = payload.get("user_state") or {}
        raw_asked = payload.get("asked_question_keys") or ()
        asked_error = None
        if isinstance(raw_asked, str) and raw_asked.strip():
            # 字符串直接 tuple() 会被拆成单个字符，让"本任务已问过"的记录静默失效。
            asked_error = "invalid_asked_question_keys:必须是字符串序列，收到字符串"
            raw_asked = ()
        kwargs = dict(
            session_id=payload.get("session_id"),
            search_id=payload.get("search_id"),
            state_version=payload.get("state_version"),
            candidate_snapshot_id=payload.get("candidate_snapshot_id"),
            ranker_snapshot_id=payload.get("ranker_snapshot_id"),
            asked_question_keys=raw_asked,
        )
        if asked_error is not None:
            return cls(user_state=UserState(), candidates=(),
                       payload_error=asked_error, **kwargs)  # type: ignore[arg-type]
        try:
            station_walk = cls._resolve_station_walk(payload.get("station_walk"), raw_state)
        except ValidationError as error:
            return cls(user_state=UserState(), candidates=(),
                       payload_error=f"invalid_station_walk:{error}", **kwargs)  # type: ignore[arg-type]
        if not isinstance(raw_state, Mapping):
            return cls(user_state=UserState(station_walk=station_walk), candidates=(),
                       payload_error="invalid_user_state:user_state 必须是对象", **kwargs)  # type: ignore[arg-type]
        known_state_keys = {
            "station_walk", "budget_weekly_max", "bedrooms", "districts",
            "soft_preferences", "other_confirmed",
        }
        # 快照里已有但本模块不解释的确认条件必须原样保留，不能丢弃。
        extras = {key: raw_state[key] for key in raw_state if key not in known_state_keys}
        other_confirmed = dict(raw_state.get("other_confirmed") or {})
        other_confirmed.update(extras)
        raw_districts = raw_state.get("districts") or ()
        if isinstance(raw_districts, str):
            # 和 asked_question_keys 同理：tuple("Ultimo") 会拆成单字符，把所有房源静默筛空。
            return cls(user_state=UserState(station_walk=station_walk), candidates=(),
                       payload_error="invalid_user_state:districts 必须是字符串序列，收到字符串",
                       **kwargs)  # type: ignore[arg-type]
        state_fields = dict(
            station_walk=station_walk,
            budget_weekly_max=raw_state.get("budget_weekly_max"),
            bedrooms=raw_state.get("bedrooms"),
            districts=tuple(raw_districts),
            soft_preferences=dict(raw_state.get("soft_preferences") or {}),
            other_confirmed=other_confirmed,
        )
        try:
            user_state = UserState(**state_fields)
        except ValidationError as error:
            return cls(user_state=UserState(station_walk=station_walk),
                       candidates=(), payload_error=f"invalid_user_state:{error}", **kwargs)  # type: ignore[arg-type]
        try:
            candidates = tuple(Listing.from_payload(item) for item in payload.get("candidates") or ())
        except ValidationError as error:
            return cls(user_state=user_state, candidates=(),
                       payload_error=f"invalid_candidate:{error}", **kwargs)  # type: ignore[arg-type]
        return cls(user_state=user_state, candidates=candidates, **kwargs)  # type: ignore[arg-type]

    @staticmethod
    def _resolve_station_walk(top: Any, raw_state: Any) -> StationWalkRequirement:
        """顶层优先；顶层缺失时接受 user_state 内嵌写法；两者并存且不一致则拒绝猜。"""
        nested = raw_state.get("station_walk") if isinstance(raw_state, Mapping) else None
        if top is not None and nested is not None:
            top_requirement = StationWalkRequirement.from_payload(top)
            if StationWalkRequirement.from_payload(nested) != top_requirement:
                raise ValidationError("顶层 station_walk 与 user_state 内嵌值不一致，请先核实")
            return top_requirement
        if top is not None:
            return StationWalkRequirement.from_payload(top)
        if nested is not None:
            return StationWalkRequirement.from_payload(nested)
        return StationWalkRequirement()


@dataclass(frozen=True)
class Scenario:
    """一个标准演示情景；max_m 为 None 表示不设车站硬限制。"""

    scenario_id: str
    label: str
    max_m: Optional[float] = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "scenario_id", non_empty_text(self.scenario_id, "scenario_id"))
        object.__setattr__(self, "label", non_empty_text(self.label, "label"))
        if self.max_m is not None:
            object.__setattr__(self, "max_m", finite_number(self.max_m, "scenario.max_m"))

    def assumption(self) -> Dict[str, Any]:
        return {"station_walk_max_m": self.max_m}

    def next_state_patch(self) -> Dict[str, Any]:
        return {"station_walk": {"status": STATION_CONFIRMED, "max_m": self.max_m}}


@dataclass(frozen=True)
class ScenarioResult:
    """§5.2 内部模拟结果；source 恒为 simulation，绝不冒充真实档案。"""

    scenario_id: str
    assumption: Mapping[str, Any]
    next_state_patch: Mapping[str, Any]
    feasible_listing_ids: Tuple[str, ...]
    top_listing_id: Optional[str]
    outcome: str
    source: str = SOURCE_SIMULATION
    candidate_count: int = 0
    candidate_snapshot_id: str = ""
    ranker_snapshot_id: str = ""

    @property
    def is_match(self) -> bool:
        return self.outcome == OUTCOME_HAS_MATCH

    def to_dict(self) -> Dict[str, Any]:
        return {
            "scenario_id": self.scenario_id,
            "assumption": dict(self.assumption),
            "next_state_patch": dict(self.next_state_patch),
            "feasible_listing_ids": list(self.feasible_listing_ids),
            "top_listing_id": self.top_listing_id,
            "outcome": self.outcome,
            "source": self.source,
            "candidate_count": self.candidate_count,
            "candidate_snapshot_id": self.candidate_snapshot_id,
            "ranker_snapshot_id": self.ranker_snapshot_id,
        }


@dataclass(frozen=True)
class QuestionOption:
    """问句选项；effect 决定真实回答写入哪种补丁。"""

    id: str
    label: str
    max_m: Optional[float] = None
    effect: str = OPTION_CONFIRM_LIMIT

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", non_empty_text(self.id, "option.id"))
        object.__setattr__(self, "label", non_empty_text(self.label, "option.label"))
        if self.max_m is not None:
            object.__setattr__(self, "max_m", finite_number(self.max_m, "option.max_m"))
        if self.effect not in (OPTION_CONFIRM_LIMIT, OPTION_CONFIRM_NO_LIMIT, OPTION_SKIP):
            raise ValidationError(f"未知 option.effect：{self.effect!r}")
        if self.effect == OPTION_CONFIRM_LIMIT and self.max_m is None:
            raise ValidationError("confirm_limit 选项必须带 max_m")
        if self.effect != OPTION_CONFIRM_LIMIT and self.max_m is not None:
            raise ValidationError("no_limit / skip 选项不能带 max_m")

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"id": self.id, "label": self.label}
        if self.effect != OPTION_SKIP:
            payload["max_m"] = self.max_m
        return payload


@dataclass(frozen=True)
class PlanResult:
    """§5.3 对外决策结果；对外只给 action 与自然问句，诊断留在 diagnostics。"""

    action: str
    reason_code: str
    base_state_version: int
    question_key: Optional[str] = None
    question_id: Optional[str] = None
    question_text: Optional[str] = None
    options: Tuple[QuestionOption, ...] = ()
    scenarios: Tuple[ScenarioResult, ...] = ()
    divergence: Optional[float] = None
    model_version: str = MODEL_VERSION
    diagnostics: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.action not in ACTIONS:
            raise ValidationError(f"未知 action：{self.action!r}")
        object.__setattr__(self, "reason_code", non_empty_text(self.reason_code, "reason_code"))
        object.__setattr__(self, "options", tuple(self.options))
        object.__setattr__(self, "scenarios", tuple(self.scenarios))
        object.__setattr__(self, "diagnostics", mapping_copy(self.diagnostics, "diagnostics"))

    @property
    def is_ask(self) -> bool:
        return self.action == ACTION_ASK

    def with_question_id(self, question_id: str) -> "PlanResult":
        return replace(self, question_id=non_empty_text(question_id, "question_id"))

    def to_dict(self) -> Dict[str, Any]:
        """界面可见形态：不暴露分支分数、模拟概率等实现细节。"""
        payload: Dict[str, Any] = {
            "action": self.action,
            "reason_code": self.reason_code,
            "base_state_version": self.base_state_version,
            "model_version": self.model_version,
        }
        if self.is_ask:
            payload.update({
                "question_key": self.question_key,
                "question_id": self.question_id,
                "question_text": self.question_text,
                "options": [option.to_dict() for option in self.options],
            })
        return payload

    def to_log_dict(self) -> Dict[str, Any]:
        """§12.2 日志形态：分支首选、候选数量、耗时、reason_code。"""
        payload = self.to_dict()
        payload["divergence"] = self.divergence
        payload["diagnostics"] = dict(self.diagnostics)
        payload["branches"] = [
            {
                "scenario_id": result.scenario_id,
                "assumption": dict(result.assumption),
                "top_listing_id": result.top_listing_id,
                "feasible_count": len(result.feasible_listing_ids),
                "outcome": result.outcome,
            }
            for result in self.scenarios
        ]
        return payload


@dataclass(frozen=True)
class AnswerInput:
    """§7 真实回答输入；current_* 由现有档案服务提供，模块只读。"""

    question_id: str
    event_id: str
    base_state_version: int
    current_state_version: int
    current_state: UserState
    option_id: Optional[str] = None
    custom_text: Optional[str] = None
    session_id: str = ""
    search_id: str = ""
    # 本次问句实际展示的选项；为空时按标准四选项解析（自适应问句的阈值随候选池变化）。
    options: Tuple["QuestionOption", ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "question_id", non_empty_text(self.question_id, "question_id"))
        object.__setattr__(self, "event_id", non_empty_text(self.event_id, "event_id"))
        for name in ("base_state_version", "current_state_version"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValidationError(f"{name} 必须是非负整数")
        if not isinstance(self.current_state, UserState):
            raise ValidationError("current_state 必须是 UserState")
        if self.option_id is None and self.custom_text is None:
            raise ValidationError("必须提供 option_id 或 custom_text")
        object.__setattr__(self, "options", tuple(self.options or ()))


@dataclass(frozen=True)
class AnswerResolution:
    """§7/§9 回答解析结果：要么是有效补丁，要么是 skipped / invalid_answer / stale_state。"""

    status: str
    reason_code: str
    state_patch: Optional[Mapping[str, Any]] = None
    next_state: Optional[UserState] = None
    requires_confirmation: bool = False
    message: str = ""
    should_recommend: bool = False
    question_id: str = ""
    event_id: str = ""
    base_state_version: int = 0
    model_version: str = MODEL_VERSION

    def __post_init__(self) -> None:
        if self.status not in (RESOLUTION_APPLIED, RESOLUTION_SKIPPED, RESOLUTION_INVALID, RESOLUTION_STALE):
            raise ValidationError(f"未知 resolution.status：{self.status!r}")

    @property
    def is_applicable(self) -> bool:
        return self.status in (RESOLUTION_APPLIED, RESOLUTION_SKIPPED)

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "status": self.status,
            "reason_code": self.reason_code,
            "state_patch": dict(self.state_patch) if self.state_patch else None,
            "requires_confirmation": self.requires_confirmation,
            "message": self.message,
            "should_recommend": self.should_recommend,
            "question_id": self.question_id,
            "event_id": self.event_id,
            "base_state_version": self.base_state_version,
            "model_version": self.model_version,
        }
        if self.next_state is not None:
            payload["next_state"] = self.next_state.to_dict()
        return payload
