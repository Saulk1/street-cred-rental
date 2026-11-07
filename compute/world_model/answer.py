"""真实回答解析与档案补丁生成（实施策划 §7、§9）。

本模块只返回补丁，不保存档案；版本检查、幂等与原子写入由现有档案服务负责。
自由文本含糊时返回 invalid_answer + requires_confirmation，绝不静默填值。
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional, Sequence, Tuple

from .scenarios import STANDARD_OPTIONS, option_by_id
from .transition import apply_patch
from .types import (
    OPTION_CONFIRM_LIMIT,
    OPTION_CONFIRM_NO_LIMIT,
    OPTION_SKIP,
    RESOLUTION_APPLIED,
    RESOLUTION_INVALID,
    RESOLUTION_SKIPPED,
    RESOLUTION_STALE,
    STATION_CONFIRMED,
    STATION_DEFERRED,
    AnswerInput,
    AnswerResolution,
    QuestionOption,
    UserState,
)

ERROR_UNKNOWN_OPTION = "unknown_option"
ERROR_EMPTY_ANSWER = "empty_answer"
ERROR_INVALID_DISTANCE = "invalid_distance"
ERROR_AMBIGUOUS_UNIT = "ambiguous_unit"
ERROR_UNSUPPORTED_UNIT = "unsupported_unit"
ERROR_RANGE_UNSUPPORTED = "range_not_supported"
ERROR_STALE_STATE = "stale_state"

# 全角数字与四种负号变体：不归一化的话 "－600米" 会被读成正值 600，直接写坏档案。
_HALF_WIDTH = str.maketrans("０１２３４５６７８９．＜＞＝－﹣−", "0123456789.<>=---")

_NO_LIMIT_WORDS = ("不设", "不限", "没有限制", "无限制", "无所谓", "都可以", "都行", "没要求")
_SKIP_WORDS = ("跳过", "不想说", "不想回答", "不回答", "先不问", "再说")

_DISTANCE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m|meter|meters|metre|metres)?")
_TIME_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(分钟|min|mins|minute|minutes)")

_METRE_UNITS = {"米", "m", "meter", "meters", "metre", "metres"}
_KILOMETRE_UNITS = {"公里", "千米", "km"}


def _normalise(text: str) -> str:
    return text.translate(_HALF_WIDTH).strip().lower()


def parse_custom_distance(text: str) -> Tuple[str, Optional[float], str, bool]:
    """解析自由文本距离。

    返回 (kind, max_m, reason_code, requires_confirmation)，kind 取
    limit / no_limit / skip / ambiguous / invalid。
    """
    normalised = _normalise(text)
    if not normalised:
        return "invalid", None, ERROR_EMPTY_ANSWER, False

    has_digits = any(char.isdigit() for char in normalised)
    if not has_digits:
        if any(word in normalised for word in _NO_LIMIT_WORDS):
            return "no_limit", None, "no_limit_text", False
        if any(word in normalised for word in _SKIP_WORDS):
            return "skip", None, "skip_text", False
        return "invalid", None, ERROR_INVALID_DISTANCE, True

    # 符号必须在解析前判掉：负号一旦和数字被空格分开（"－ 600 m"），正则就会把它当成正数。
    first_digit = next(index for index, char in enumerate(normalised) if char.isdigit())
    if "-" in normalised:
        if normalised.index("-") < first_digit:
            return "invalid", None, ERROR_INVALID_DISTANCE, False
        return "ambiguous", None, ERROR_RANGE_UNSUPPORTED, True

    time_match = _TIME_RE.search(normalised)
    if time_match:
        return "ambiguous", None, ERROR_UNSUPPORTED_UNIT, True

    match = _DISTANCE_RE.search(normalised)
    if not match:
        return "invalid", None, ERROR_INVALID_DISTANCE, True
    number_text, unit = match.group(1), match.group(2)
    value = float(number_text)
    if unit is None:
        return "ambiguous", None, ERROR_AMBIGUOUS_UNIT, True
    if unit in _METRE_UNITS:
        return "limit", value, "custom_limit", False
    if unit in _KILOMETRE_UNITS:
        return "limit", value * 1000.0, "custom_limit", False
    return "ambiguous", None, ERROR_AMBIGUOUS_UNIT, True


def _patch(status: str, max_m: Optional[float]) -> Dict[str, Any]:
    return {"station_walk": {"status": status, "max_m": max_m}}


def _resolve_from_option(option_id: str, options: Sequence[QuestionOption] = STANDARD_OPTIONS
                         ) -> Tuple[Optional[Dict[str, Any]], str, bool]:
    try:
        option = option_by_id(option_id, options)
    except KeyError:
        return None, ERROR_UNKNOWN_OPTION, False
    if option.effect == OPTION_CONFIRM_LIMIT:
        return _patch(STATION_CONFIRMED, option.max_m), "option_confirm_limit", False
    if option.effect == OPTION_CONFIRM_NO_LIMIT:
        return _patch(STATION_CONFIRMED, None), "option_no_limit", False
    if option.effect == OPTION_SKIP:
        return _patch(STATION_DEFERRED, None), "option_skip", False
    return None, ERROR_UNKNOWN_OPTION, False


def resolve_answer(answer: AnswerInput) -> AnswerResolution:
    """把一次真实回答解析成档案补丁或明确的失败原因。"""
    base: Dict[str, Any] = {
        "question_id": answer.question_id,
        "event_id": answer.event_id,
        "base_state_version": answer.base_state_version,
    }

    if answer.base_state_version != answer.current_state_version:
        return AnswerResolution(
            status=RESOLUTION_STALE,
            reason_code=ERROR_STALE_STATE,
            message="档案版本已更新，这个问题已失效，请以最新状态为准。",
            should_recommend=False,
            **base,
        )

    patch: Optional[Dict[str, Any]] = None
    reason_code = ERROR_INVALID_DISTANCE
    requires_confirmation = False

    option_id = (answer.option_id or "").strip()
    shown = answer.options or STANDARD_OPTIONS
    known_ids = {option.id for option in shown}
    if option_id in known_ids:
        patch, reason_code, requires_confirmation = _resolve_from_option(option_id, shown)
    elif answer.custom_text is not None and answer.custom_text.strip():
        kind, max_m, reason_code, requires_confirmation = parse_custom_distance(answer.custom_text)
        if kind == "limit":
            patch = _patch(STATION_CONFIRMED, max_m)
        elif kind == "no_limit":
            patch = _patch(STATION_CONFIRMED, None)
        elif kind == "skip":
            patch = _patch(STATION_DEFERRED, None)
    elif option_id:
        patch, reason_code, requires_confirmation = _resolve_from_option(option_id, shown)

    if patch is None:
        return AnswerResolution(
            status=RESOLUTION_INVALID,
            reason_code=reason_code,
            requires_confirmation=requires_confirmation,
            message="这个回答还不能确定，请给出明确距离（例如 600 米）或选择上面的选项。",
            should_recommend=False,
            **base,
        )

    next_state: UserState = apply_patch(answer.current_state, patch)
    is_skip = patch["station_walk"]["status"] == STATION_DEFERRED
    return AnswerResolution(
        status=RESOLUTION_SKIPPED if is_skip else RESOLUTION_APPLIED,
        reason_code=reason_code,
        state_patch=patch,
        next_state=next_state,
        requires_confirmation=False,
        message=("已记录：这项先保持未知，本轮不再追问。" if is_skip
                 else "已更新你的车站距离要求。"),
        should_recommend=True,
        **base,
    )
