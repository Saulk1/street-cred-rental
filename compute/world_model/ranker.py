"""固定只读推荐器（演示与测试用桩，实施策划 §8、§9、§11）。

正式接入时替换为真实推荐器；契约只有一条：
    rank(state, candidates, snapshot_id) -> list[listing_id]
排序必须只读、确定性，分数相同按 listing_id 升序，避免随机变化误触发提问。
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

from .types import Listing, RankingContractError, UserState, sha256_fingerprint

MISSING_COST = 1.0e9

DEFAULT_WEIGHTS: Dict[str, float] = {
    "groceries": 1.0,
    "rent": 1.0e-3,
}


class FixedRanker:
    """按 (买菜步行, 周租, listing_id) 字典序排序的只读桩。"""

    def __init__(self, snapshot_id: str = "ranker-007",
                 weights: Optional[Mapping[str, float]] = None) -> None:
        self.snapshot_id = snapshot_id
        self._weights = dict(DEFAULT_WEIGHTS if weights is None else weights)

    # --- 只读参数面：供完整性校验，不允许被调用方修改 ---
    def params(self) -> Dict[str, Any]:
        return {"weights": dict(self._weights), "snapshot_id": self.snapshot_id}

    def params_fingerprint(self) -> str:
        return sha256_fingerprint(self.params())

    def _score(self, listing: Listing) -> tuple:
        groceries = MISSING_COST if listing.supermarket_walk_min is None else listing.supermarket_walk_min
        rent = MISSING_COST if listing.weekly_rent is None else listing.weekly_rent
        return (self._weights["groceries"] * groceries, self._weights["rent"] * rent)

    def rank(self, state: UserState, candidates: Sequence[Listing], snapshot_id: str) -> List[str]:
        if snapshot_id != self.snapshot_id:
            raise RankingContractError(
                f"ranker snapshot 不匹配：请求 {snapshot_id}，实际 {self.snapshot_id}"
            )
        pool = tuple(candidates)  # 只读复制，绝不改输入
        return [listing.listing_id for listing in sorted(pool, key=lambda item: (self._score(item), item.listing_id))]
