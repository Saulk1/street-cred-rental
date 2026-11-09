"""多轮租房顾问编排（参考实现）：需求抽取 → 问最值的问题 → 推荐三套 → 开放追问 → 反馈调权。

    advisor = RentalAdvisor(listings, ranker, suburbs=[...])
    advisor.intake("我在 UTS 上课，想找一室，预算 800，养了一只猫")
    step = advisor.next()                       # ask 或 recommend
    advisor.answer(step["question_id"], option_id="le_600")
    advisor.tell("还要带家具")                    # 开放追问的回答，不占提问次数
    advisor.feedback(chosen_id="GANSW...", reasons=["太贵"])

与 OrchestrationService（v0.1 单问题、并发与版本语义完整）并存，不替换它。
这里是单会话、单线程的参考实现：event_id 幂等、问题 ID 必须匹配当前待答问题；
跨进程并发、持久化由真实服务负责。
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from .answer import parse_custom_distance
from .microburbs import build_candidate_pool  # noqa: F401  (re-export for callers)
from .needs import COMMUTE_NONE, DESTINATIONS, NEED_KEYS, _w, apply_state_patch, commute_of, extract_needs, needs_of
from .questions import (
    DEFAULT_ASK_THRESHOLD,
    DEFAULT_MAX_QUESTIONS,
    BUDGET_STRETCH_PCT,
    MultiPlan,
    QuestionSpec,
    apply_feedback,
    build_question_bank,
    plan_multi,
    question_value,
)
from .transition import filter_feasible
from .types import STATION_CONFIRMED, STATION_DEFERRED, STATION_UNKNOWN, Listing, UserState

DEFAULT_POOL_SIZE = 60
DEFAULT_MAX_INVALID_ATTEMPTS = 3
# 用户没选首选、而首选在更新偏好后仍排第一：累计到这么多次才把它移出候选池。
# 1 = 第一次就移除（一次随手的选择就可能删掉真正最合适的房源）；0 = 永不移除。
DEFAULT_SKIP_PATIENCE = 3
_TEXT_SKIP_WORDS = ("跳过", "暂时跳过", "不想说", "不想回答", "不回答", "先不问", "再说")
_COMMUTE_NONE_WORDS = ("不固定", "无所谓", "没要求", "都可以", "都行", "随便")


class RentalAdvisor:
    def __init__(self, listings: Sequence[Listing], ranker: Any, *, suburbs: Sequence[str] = (),
                 initial_state: Optional[UserState] = None, pool_size: int = DEFAULT_POOL_SIZE,
                 max_questions: Optional[int] = None, ask_threshold: float = DEFAULT_ASK_THRESHOLD,
                 max_invalid_attempts: int = DEFAULT_MAX_INVALID_ATTEMPTS,
                 priors: Optional[Mapping[str, Mapping[str, float]]] = None,
                 llm: Optional[Callable[[str], Any]] = None,
                 learner: Optional[str] = None, selector: Optional[str] = None,
                 skip_patience: int = DEFAULT_SKIP_PATIENCE) -> None:
        self.skip_patience = skip_patience
        self.skip_counts: Dict[str, int] = {}
        self.learner = learner      # None = questions.DEFAULT_LEARNER
        self.selector = selector    # None = questions.DEFAULT_SELECTOR
        self.listings = tuple(listing for listing in listings
                              if listing.station_walk_m is not None and not listing.extra.get("price_flag"))
        self.by_id = {listing.listing_id: listing for listing in self.listings}
        self.ranker = ranker
        self.suburbs = tuple(suburbs)
        self.state = initial_state or UserState()
        self.version = 1
        self.pool_size = pool_size
        self._explicit_max_questions = max_questions is not None
        self.max_questions = DEFAULT_MAX_QUESTIONS if max_questions is None else max_questions
        self.ask_threshold = ask_threshold
        self.max_invalid_attempts = max_invalid_attempts
        self.priors = priors
        self.llm = llm
        self.asked_keys: List[str] = []
        self.pending: Optional[Dict[str, Any]] = None
        self.last_shown: Tuple[Dict[str, Any], ...] = ()
        self.events: Dict[str, Dict[str, Any]] = {}
        self.log: List[Dict[str, Any]] = []
        self.rejected_listing_ids: set = set()
        self._question_seq = 0
        self._invalidated_counts: Dict[str, int] = {}
        self._forced_question_key: Optional[str] = None

    # ------------------------------------------------------------ 状态
    def _apply(self, patch: Mapping[str, Any], source: str) -> UserState:
        if patch:
            self.state = apply_state_patch(self.state, patch)
            self.version += 1
            self.log.append({"source": source, "patch": dict(patch), "version": self.version})
        return self.state

    def _invalidate_pending(self) -> None:
        if self.pending is None:
            return
        key = self.pending["spec"].key
        self._invalidated_counts[key] = self._invalidated_counts.get(key, 0) + 1
        # 连续多次被外部状态变更打断仍未回答同一问题时，将其记入已问，防止无限重问死循环
        if self._invalidated_counts[key] >= 2 and key not in self.asked_keys:
            self.asked_keys.append(key)
        self.pending = None

    def _reserve_diverse_strict_ids(self, strict: Sequence[Listing], ranked_strict: Sequence[str]) -> List[str]:
        """在未确认宠物/家具/车位/通勤/车站前，从可行池中保底保留各维度最优代表，防止稀疏特征被纯低价截断淘汰。"""
        if len(ranked_strict) <= self.pool_size or self.pool_size < 6:
            return list(ranked_strict[: self.pool_size])
        reserved: List[str] = []
        known_needs = needs_of(self.state)
        for need in NEED_KEYS:
            if need not in known_needs and f"needs.{need}" not in self.asked_keys:
                matches = [lid for lid in ranked_strict
                           if (self.by_id[lid].extra.get("features") or {}).get(need) is True]
                reserved.extend(matches[:2])
        if commute_of(self.state) is None and "commute_to" not in self.asked_keys:
            for dest in DESTINATIONS:
                dest_state = apply_state_patch(self.state, {"commute_to": dest})
                dest_ranked = [str(i) for i in self.ranker.rank(dest_state, strict, self.ranker.snapshot_id)]
                reserved.extend(dest_ranked[:1])
        if self.state.station_walk.status == STATION_UNKNOWN and "station_walk_max_m" not in self.asked_keys:
            for limit in (400.0, 800.0):
                near = [lid for lid in ranked_strict
                        if self.by_id[lid].station_walk_m is not None and self.by_id[lid].station_walk_m <= limit]
                reserved.extend(near[:1])
        unique_reserved = list(dict.fromkeys(reserved))[: max(1, self.pool_size // 3)]
        head_count = max(1, self.pool_size - len(unique_reserved))
        combined = list(dict.fromkeys(list(ranked_strict[:head_count]) + unique_reserved))
        for lid in ranked_strict:
            if len(combined) >= self.pool_size:
                break
            if lid not in combined:
                combined.append(lid)
        return combined[: self.pool_size]

    def candidates(self) -> Tuple[Listing, ...]:
        """候选池：按硬要求过滤后取排序前 pool_size 套（含未确认维度的代表房源）。

        已确认的车站上限必须在截断前生效，否则池子里可能只剩少数甚至没有达标房源；
        车站未问时本来就不设限。预算未问过时留 10% 余量，给"预算能否放宽"留出比较对象。
        """
        available = tuple(item for item in self.listings if item.listing_id not in self.rejected_listing_ids)
        strict = filter_feasible(self.state, available)
        ranked_strict = [str(i) for i in self.ranker.rank(self.state, strict, self.ranker.snapshot_id)]
        strict_ids = self._reserve_diverse_strict_ids(strict, ranked_strict)
        extra_ids: List[str] = []
        if self.state.budget_weekly_max is not None and self.state.other_confirmed.get("budget_stretch_pct") is None:
            open_state = apply_state_patch(self.state, {"budget_stretch_pct": BUDGET_STRETCH_PCT})
            strict_set = {listing.listing_id for listing in strict}
            stretch_only = [listing for listing in filter_feasible(open_state, available)
                            if listing.listing_id not in strict_set]
            extra_ids = [str(i) for i in self.ranker.rank(self.state, stretch_only,
                                                          self.ranker.snapshot_id)][: self.pool_size]
        # 预算内房源单独取前 pool_size 套，放宽 10% 的房源另取比较对象，
        # 避免“超预算但更划算”的房源把预算内房源挤出池子。
        chosen = set(strict_ids) | set(extra_ids)
        pool = [self.by_id[i] for i in chosen]
        ordered = self.ranker.rank(self.state, pool, self.ranker.snapshot_id)
        return tuple(self.by_id[str(i)] for i in ordered)

    # ------------------------------------------------------------ 入口
    def intake(self, text: str) -> Dict[str, Any]:
        extraction = extract_needs(text, suburbs=self.suburbs, llm=self.llm)
        self._apply(extraction.patch, "intake")
        return {"extracted": extraction.to_dict(), "state": self.state.to_dict()}

    def next(self) -> Dict[str, Any]:
        if self.pending is not None and self.pending["version"] != self.version:
            self._invalidate_pending()
        if self.pending is not None:
            return self._ask_payload(self.pending["spec"], self.pending["question_id"], self.pending["plan"],
                                     restored=True)
        pool = self.candidates()
        forced_key = self._forced_question_key
        self._forced_question_key = None
        if forced_key and forced_key not in self.asked_keys:
            specs = [s for s in build_question_bank(self.state, pool, self.ranker, self.ranker.snapshot_id,
                                                    priors=self.priors, exclude=self.asked_keys)
                     if s.key == forced_key]
            strict_pool = filter_feasible(self.state, pool)   # 池里含放宽预算的房源，默认首选必须按真实档案取
            if specs and strict_pool:
                spec = specs[0]
                default_id = str(self.ranker.rank(self.state, strict_pool, self.ranker.snapshot_id)[0])
                qv = question_value(spec, self.state, pool, self.ranker, self.ranker.snapshot_id, default_id)
                forced_plan = MultiPlan(
                    action="ask", reason_code="feedback_requested_question", default_listing_id=default_id,
                    question=spec, values=(qv,),
                    diagnostics={"question_values": [qv.to_dict()], "asked_keys": list(self.asked_keys),
                                 "forced_question_key": forced_key, "pool_size": len(pool)},
                )
                self._question_seq += 1
                question_id = f"q-{self._question_seq:03d}"
                self.pending = {"question_id": question_id, "spec": spec, "version": self.version,
                                "plan": forced_plan, "attempts": 0}
                return self._ask_payload(spec, question_id, forced_plan)

        plan = plan_multi(self.state, pool, self.ranker, self.ranker.snapshot_id,
                          asked_keys=self.asked_keys, max_questions=self.max_questions,
                          ask_threshold=self.ask_threshold, priors=self.priors, selector=self.selector)
        if plan.action == "ask" and plan.question is not None:
            self._question_seq += 1
            question_id = f"q-{self._question_seq:03d}"
            self.pending = {"question_id": question_id, "spec": plan.question, "version": self.version,
                            "plan": plan, "attempts": 0}
            return self._ask_payload(plan.question, question_id, plan)
        self.last_shown = plan.recommendations
        return {"action": plan.action, "reason_code": plan.reason_code,
                "recommendations": [dict(item) for item in plan.recommendations],
                "followup": plan.followup, "diagnostics": dict(plan.diagnostics)}

    def _ask_payload(self, spec: QuestionSpec, question_id: str, plan: MultiPlan, restored: bool = False) -> Dict[str, Any]:
        value = next((item for item in plan.values if item.key == spec.key), None)
        return {"action": "ask", "reason_code": "restored_pending" if restored else plan.reason_code,
                "question_id": question_id, "question_key": spec.key, "question_text": spec.text,
                "options": [option.to_dict() for option in spec.options],
                "expected_regret": None if value is None else round(value.value, 2),
                "diagnostics": dict(plan.diagnostics)}

    def _reject_or_auto_skip(self, spec: QuestionSpec, reason_code: str, message: str = "") -> Dict[str, Any]:
        assert self.pending is not None
        self.pending["attempts"] = self.pending.get("attempts", 0) + 1
        if self.pending["attempts"] <= self.max_invalid_attempts:
            payload: Dict[str, Any] = {"status": "invalid_answer", "reason_code": reason_code}
            if message:
                payload["message"] = message
            return payload
        # 超过最大无效重试次数：自动按跳过处理，防止对话卡死在同一问题上陷入死循环
        fallback_patch = ({"station_walk": {"status": STATION_DEFERRED, "max_m": None}}
                          if spec.key == "station_walk_max_m" else {})
        self.asked_keys.append(spec.key)
        self.pending = None
        self._apply(fallback_patch, f"auto_skip:{spec.key}")
        return {"status": "skipped", "reason_code": "max_retries_exceeded", "question_key": spec.key,
                "patch": dict(fallback_patch), "next": self.next()}

    def answer(self, question_id: str, *, option_id: Optional[str] = None, text: Optional[str] = None,
               event_id: Optional[str] = None) -> Dict[str, Any]:
        if event_id and event_id in self.events:
            return {**self.events[event_id], "duplicate": True}
        if self.pending is None or self.pending["question_id"] != question_id:
            return {"status": "invalid_answer", "reason_code": "unknown_or_stale_question"}
        spec: QuestionSpec = self.pending["spec"]
        if self.pending["version"] != self.version:
            self._invalidate_pending()
            return {"status": "stale_state", "reason_code": "profile_changed_since_question"}
        patch: Optional[Mapping[str, Any]] = None
        skipped = False
        if option_id:
            option = spec.option(option_id)
            if option is None:
                return self._reject_or_auto_skip(spec, "unknown_option")
            patch = option.patch
            skipped = (option.patch is None or option.id == "skip"
                       or (option.patch or {}).get("station_walk", {}).get("status") == STATION_DEFERRED)
        elif text:
            patch = self._parse_text_answer(spec, text)
            if patch is None:
                return self._reject_or_auto_skip(
                    spec, "unparsed_text", "这个回答我还不能确定，请选一个选项或说得具体一点。"
                )
            skipped = (not patch) or (patch.get("station_walk", {}).get("status") == STATION_DEFERRED)
        else:
            return self._reject_or_auto_skip(spec, "empty_answer")
        self.asked_keys.append(spec.key)
        self.pending = None
        self._apply(patch or {}, f"answer:{spec.key}")
        result = {"status": "skipped" if skipped else "applied", "question_key": spec.key,
                  "patch": dict(patch or {}), "next": self.next()}
        if event_id:
            self.events[event_id] = result
        return result

    @staticmethod
    def _is_skip_text(text: str) -> bool:
        lowered = text.strip().lower()
        if not lowered:
            return False
        if any(word in lowered for word in _TEXT_SKIP_WORDS):
            return True
        return bool(re.search(_w("skip") + "|" + _w("pass"), lowered))

    def _parse_text_answer(self, spec: QuestionSpec, text: str) -> Optional[Dict[str, Any]]:
        if spec.key == "station_walk_max_m":
            kind, max_m, _reason, _confirm = parse_custom_distance(text)
            if kind == "limit":
                return {"station_walk": {"status": STATION_CONFIRMED, "max_m": max_m}}
            if kind == "no_limit":
                return {"station_walk": {"status": STATION_CONFIRMED, "max_m": None}}
            if kind == "skip" or self._is_skip_text(text):
                return {"station_walk": {"status": STATION_DEFERRED, "max_m": None}}
            return None
        # 先按问题解析真实回答；只有什么都没解析出来时才看是不是"跳过"，
        # 否则"有一只猫，别的再说"会因为含"再说"被当成跳过，丢掉真实回答。
        parsed = self._parse_specific_answer(spec, text)
        if parsed is not None:
            return parsed
        return {} if self._is_skip_text(text) else None

    def _parse_specific_answer(self, spec: QuestionSpec, text: str) -> Optional[Dict[str, Any]]:
        extraction = extract_needs(text, suburbs=self.suburbs, llm=self.llm).patch
        if spec.key.startswith("needs."):
            need = spec.key.split(".", 1)[1]
            value = (extraction.get("needs") or {}).get(need)
            if value is None:
                lowered = text.strip().lower()
                if lowered in ("是", "有", "要", "需要", "yes", "y", "对"):
                    value = True
                elif lowered in ("否", "没有", "不要", "不需要", "no", "n", "没"):
                    value = False
            return None if value is None else {"needs": {need: value}}
        if spec.key == "commute_to":
            if "commute_to" in extraction:
                return {"commute_to": extraction["commute_to"]}
            lowered = text.strip().lower()
            if any(word in lowered for word in _COMMUTE_NONE_WORDS) or re.search(_w("none"), lowered):
                return {"commute_to": COMMUTE_NONE}
            return None
        if spec.key == "budget_stretch":
            lowered = text.strip().lower()
            if re.search("不行|不能|不可以|严格|" + _w("no"), lowered):
                return {"budget_stretch_pct": 0.0}
            if (re.search("可以|行|能|" + _w("yes") + "|" + _w("ok"), lowered)
                    and "不" not in lowered and "可能" not in lowered):
                return {"budget_stretch_pct": BUDGET_STRETCH_PCT}
        return None

    def tell(self, text: str) -> Dict[str, Any]:
        """开放追问的自由回答：抽取需求、写档案、重新规划；不占用主动提问次数。"""
        extraction = extract_needs(text, suburbs=self.suburbs, llm=self.llm)
        if self.pending is not None and extraction.patch:
            self._invalidate_pending()
        self._apply(extraction.patch, "followup")
        return {"extracted": extraction.to_dict(), "next": self.next()}

    def feedback(self, *, chosen_id: Optional[str] = None, rejected_ids: Sequence[str] = (),
                 reasons: Sequence[str] = ()) -> Dict[str, Any]:
        best_shown = next((item for item in self.last_shown if item.get("role") == "best"),
                          self.last_shown[0] if self.last_shown else None)
        best_id = best_shown.get("listing_id") if best_shown else None
        patch, notes = apply_feedback(self.state, self.last_shown, self.by_id, self.ranker,
                                      chosen_id=chosen_id, rejected_ids=rejected_ids, reasons=reasons,
                                      learner=self.learner)
        if reasons:
            extracted = extract_needs("，".join(reasons), suburbs=self.suburbs, llm=self.llm).patch
            for k, v in extracted.items():
                if k == "excluded_districts":
                    patch[k] = list(dict.fromkeys(list(patch.get(k, ())) + list(v)))
                elif k not in patch:
                    patch[k] = v

        if rejected_ids:
            self.rejected_listing_ids.update(str(i) for i in rejected_ids if i and i != chosen_id)

        if any("还不知道目的地" in note for note in notes):
            self._forced_question_key = "commute_to"
            if self.pending is not None:
                self._invalidate_pending()
        elif chosen_id and best_id and chosen_id != best_id and chosen_id in self.by_id and best_id in self.by_id:
            # 若用户选中的备选房源具备某项未确认特征（如明确带家具/可养宠/有车位）而原首选没有，主动追问该需求
            known_needs = needs_of(self.state)
            chosen_feat = self.by_id[chosen_id].extra.get("features") or {}
            best_feat = self.by_id[best_id].extra.get("features") or {}
            for need in NEED_KEYS:
                qkey = f"needs.{need}"
                if (need not in known_needs and qkey not in self.asked_keys
                        and chosen_feat.get(need) is True and best_feat.get(need) is not True):
                    self._forced_question_key = qkey
                    break

        if not self._explicit_max_questions and len(self.asked_keys) >= self.max_questions:
            # 用户对当前推荐给出反馈时，若仍有高价值未问问题，允许追加 1 问以打破“只推不问”的卡片二选一循环
            self.max_questions = len(self.asked_keys) + 1

        self._apply(patch, "feedback")
        next_step = self.next()
        if (chosen_id and best_id and chosen_id != best_id
                and best_id not in self.rejected_listing_ids
                and next_step.get("action") == "recommend"
                and next_step.get("recommendations")
                and next_step["recommendations"][0]["listing_id"] == best_id):
            # 权重已达上限或分差过大导致原首选仍霸榜：被跳过达到 skip_patience 次后移出候选池并重算，
            # 防止无限循环推荐同一套；次数不够时保留，避免一次带噪声的选择删掉真正合适的房源。
            self.skip_counts[str(best_id)] = self.skip_counts.get(str(best_id), 0) + 1
            if self.skip_patience and self.skip_counts[str(best_id)] >= self.skip_patience:
                self.rejected_listing_ids.add(str(best_id))
                next_step = self.next()

        return {"patch": patch, "notes": notes, "next": next_step}
