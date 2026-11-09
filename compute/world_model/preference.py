"""软偏好的贝叶斯学习：用户在展示的几套房里选了哪套 → 更新"权重倍数"的后验。

模型（离散选择 / 多项 logit，与 Bradley–Terry、Plackett–Luce 同族）：
    用户效用   u(j) = −( Σ_k a_k · f_k(j) + offset(j) )         k ∈ value / groceries / station / commute
    选择概率   P(选 c | 展示集合 S) = exp(β·u(c)) / Σ_{j∈S} exp(β·u(j))
a_k 是排序器 weight_adjust 的倍数，β 是用户选择的"果断程度"（未知，与 a 一起推断）。

后验用固定的一组粒子表示（确定性种子）：档案里只存证据（每次选择时各套房的特征向量），
后验随时可由证据重算，因此可序列化、可复现、无随机状态。排序器用后验均值——线性效用下，
按后验均值排序就是按期望效用排序。

推荐集合按 EUS（expected utility of selection，Viappiani & Boutilier 2010）贪心选择：
    EUS(S) = E_a[ max_{j∈S} u_a(j) ]
第一套固定为当前排序首选；之后每一套都选"在某些仍有可能的偏好下明显更好"的房源，
因此展示集合既是推荐，也是最能分辨用户偏好的一次提问。

先验是人工设定（各倍数以 1 为中心，车站默认很低），不是统计结果。
"""

from __future__ import annotations

import math
import random
from functools import lru_cache
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .needs import MAX_WEIGHT_FACTOR, WEIGHT_KEYS, apply_state_patch
from .types import Listing, UserState

KEYS: Tuple[str, ...] = tuple(WEIGHT_KEYS)          # value, groceries, station, commute
N_PARTICLES = 1000
EUS_PARTICLES = 150
EUS_CANDIDATES = 25
MAX_EVIDENCE = 30
_SEED = 20261107
_LOW, _HIGH = 1.0 / MAX_WEIGHT_FACTOR, MAX_WEIGHT_FACTOR
# (对数中位数, 对数标准差)。车站：默认几乎不计分，但保留"其实很在意"的长尾。
_PRIOR: Dict[str, Tuple[float, float]] = {
    "value": (0.0, 0.6), "groceries": (0.0, 0.6), "station": (math.log(0.3), 1.0), "commute": (0.0, 0.6)}
_BETA_PRIOR = (math.log(0.25), 0.8)                  # β 的单位是 1/分：0.25 ≈ 差 4 分时选择明显倾斜
REASON_SHARPNESS = 2.0                               # 用户明说"太贵"等理由：偏向该权重高于先验中位数的粒子

Features = Tuple[float, float, float, float, float]  # 四个分量（倍数为 1 时的分数）+ 固定偏移


@lru_cache(maxsize=1)
def particles() -> Tuple[Tuple[float, ...], ...]:
    """(a_value, a_groceries, a_station, a_commute, β) 的先验样本；非车站倍数的先验均值归一到 1。"""
    rng = random.Random(_SEED)
    raw = [[math.exp(rng.gauss(*_PRIOR[key])) for key in KEYS] + [math.exp(rng.gauss(*_BETA_PRIOR))]
           for _ in range(N_PARTICLES)]
    for index, key in enumerate(KEYS):
        if key != "station":
            mean = sum(row[index] for row in raw) / len(raw)
            for row in raw:
                row[index] /= mean
    return tuple(tuple(min(_HIGH, max(_LOW, value)) for value in row[:4]) + (row[4],) for row in raw)


@lru_cache(maxsize=1)
def _prior_summary() -> Tuple[Tuple[float, ...], Tuple[float, ...]]:
    rows = particles()
    means = tuple(sum(row[i] for row in rows) / len(rows) for i in range(4))
    medians = tuple(sorted(math.log(row[i]) for row in rows)[len(rows) // 2] for i in range(4))
    return means, medians


def unit_features(state: UserState, listing: Listing, ranker: Any) -> Features:
    """这套房在"所有倍数 = 1"时各分量的分数；直接复用排序器，不复制它的公式。"""
    unit = apply_state_patch(state, {"weight_adjust": {key: 1.0 for key in KEYS}})
    parts = ranker.score_breakdown(unit, listing)
    return tuple(float(parts[key]) for key in KEYS) + (float(parts["unknown_needs"]),)  # type: ignore[return-value]


def evidence_of(state: UserState) -> List[Dict[str, Any]]:
    return list(state.soft_preferences.get("preference_evidence") or [])


def clean_evidence(value: Any) -> List[Dict[str, Any]]:
    """校验证据条目；不合法的丢弃。{"c": 选中, "o": [其余]} 或 {"r": 权重键}。"""
    def vector(item: Any) -> Optional[List[float]]:
        if (isinstance(item, (list, tuple)) and len(item) == 5
                and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in item)):
            return [float(x) for x in item]
        return None

    out: List[Dict[str, Any]] = []
    for entry in value if isinstance(value, (list, tuple)) else ():
        if not isinstance(entry, Mapping):
            continue
        if entry.get("r") in KEYS:
            out.append({"r": entry["r"]})
            continue
        chosen, others = vector(entry.get("c")), entry.get("o")
        if chosen is None or not isinstance(others, (list, tuple)) or not 1 <= len(others) <= 8:
            continue
        rest = [vector(item) for item in others]
        if all(item is not None for item in rest):
            out.append({"c": chosen, "o": rest})
    return out


def _cost(row: Sequence[float], features: Sequence[float]) -> float:
    return (row[0] * features[0] + row[1] * features[1] + row[2] * features[2] + row[3] * features[3]
            + features[4])


def posterior(evidence: Sequence[Mapping[str, Any]]) -> List[float]:
    """每个粒子的后验权重（和为 1）。无证据时即先验（均匀）。"""
    rows = particles()
    _means, medians = _prior_summary()
    log_weights = [0.0] * len(rows)
    for entry in evidence:
        if "r" in entry:
            index = KEYS.index(entry["r"])
            for i, row in enumerate(rows):
                log_weights[i] -= math.log1p(math.exp(-REASON_SHARPNESS * (math.log(row[index]) - medians[index])))
            continue
        options = [entry["c"]] + list(entry["o"])
        for i, row in enumerate(rows):
            utilities = [-row[4] * _cost(row, features) for features in options]
            top = max(utilities)
            log_weights[i] += utilities[0] - top - math.log(sum(math.exp(u - top) for u in utilities))
    peak = max(log_weights)
    weights = [math.exp(value - peak) for value in log_weights]
    total = sum(weights)
    return [value / total for value in weights]


def posterior_adjust(evidence: Sequence[Mapping[str, Any]]) -> Dict[str, float]:
    """后验均值 → weight_adjust。非车站倍数除以先验均值，保证"没有信息"时恰好是 1。"""
    weights, rows = posterior(evidence), particles()
    prior_means, _medians = _prior_summary()
    out: Dict[str, float] = {}
    for index, key in enumerate(KEYS):
        mean = sum(w * row[index] for w, row in zip(weights, rows))
        if key != "station":
            mean /= prior_means[index]
        out[key] = round(min(_HIGH, max(_LOW, mean)), 4)
    return out


def effective_sample_size(evidence: Sequence[Mapping[str, Any]]) -> float:
    """后验集中程度的诊断量：越小说明证据越多（或粒子越不够用）。"""
    return 1.0 / sum(w * w for w in posterior(evidence))


def eus_select(state: UserState, listings: Sequence[Listing], ranker: Any, first_id: str, k: int) -> List[str]:
    """贪心最大化 EUS；listings 需已按当前排序排好，first_id 固定为第一套。"""
    pool = list(listings[:EUS_CANDIDATES])
    if first_id not in [item.listing_id for item in pool]:
        pool.append(next(item for item in listings if item.listing_id == first_id))
    weights = posterior(evidence_of(state))[:EUS_PARTICLES]
    rows = particles()[:EUS_PARTICLES]
    total = sum(weights) or 1.0
    weights = [value / total for value in weights]
    utility = {item.listing_id: [-_cost(row, features) for row in rows]
               for item in pool for features in (unit_features(state, item, ranker),)}
    chosen = [first_id]
    best_so_far = list(utility[first_id])
    while len(chosen) < min(k, len(pool)):
        gains = []
        for item in pool:
            if item.listing_id in chosen:
                continue
            values = utility[item.listing_id]
            gain = sum(w * (v - b) for w, v, b in zip(weights, values, best_so_far) if v > b)
            gains.append((-gain, item.listing_id))
        if not gains:
            break
        _neg, pick = min(gains)
        chosen.append(pick)
        best_so_far = [max(b, v) for b, v in zip(best_so_far, utility[pick])]
    return chosen
