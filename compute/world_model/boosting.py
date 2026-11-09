"""小型梯度提升回归树（直方图分裂，纯标准库，可序列化为 JSON）。

做法与 LightGBM / XGBoost 的 hist 模式相同，只保留本项目用得到的部分：
    - 特征先按分位数分箱（缺失值单独占第 0 箱，分裂时归左侧）；
    - 逐层生长，按平方损失的增益选分裂，叶子值带 L2 收缩；
    - 每棵树随机抽一部分样本（确定性种子）；
    - 可给验证集做早停。
训练是离线的（几万行、几十个特征，约几分钟）；预测只有整数比较，运行时不需要原始数据。
"""

from __future__ import annotations

import random
from bisect import bisect_right
from typing import Any, Dict, List, Optional, Sequence, Tuple

Row = Sequence[Optional[float]]


def make_bins(rows: Sequence[Row], max_bins: int = 48) -> List[List[float]]:
    """每个特征的分箱阈值（升序）。值 v 的箱号 = bisect_right(阈值, v) + 1；缺失 = 0。"""
    thresholds: List[List[float]] = []
    for feature in range(len(rows[0])):
        values = sorted(row[feature] for row in rows if row[feature] is not None)
        cuts: List[float] = []
        if values:
            for step in range(1, max_bins):
                cut = values[min(len(values) - 1, step * len(values) // max_bins)]
                if not cuts or cut > cuts[-1]:
                    cuts.append(cut)
            if cuts and cuts[-1] >= values[-1]:
                cuts.pop()          # 最后一个阈值之上没有样本，分裂无意义
        thresholds.append(cuts)
    return thresholds


def bin_row(row: Row, thresholds: Sequence[Sequence[float]]) -> List[int]:
    return [0 if value is None else bisect_right(cuts, value) + 1 for value, cuts in zip(row, thresholds)]


class BoostedTrees:
    def __init__(self, thresholds: List[List[float]], trees: Optional[List[Dict[str, List[Any]]]] = None,
                 base_score: float = 0.0, learning_rate: float = 0.08) -> None:
        self.thresholds = thresholds
        self.trees = trees or []
        self.base_score = base_score
        self.learning_rate = learning_rate

    # ------------------------------------------------------------------ fit
    @classmethod
    def fit(cls, rows: Sequence[Row], targets: Sequence[float], *, n_trees: int = 300, max_depth: int = 5,
            learning_rate: float = 0.08, min_leaf: int = 25, l2: float = 5.0, subsample: float = 0.8,
            max_bins: int = 48, seed: int = 7,
            valid: Optional[Tuple[Sequence[Row], Sequence[float]]] = None, patience: int = 40,
            log: Any = None) -> "BoostedTrees":
        thresholds = make_bins(rows, max_bins)
        n_features = len(thresholds)
        columns = [[] for _ in range(n_features)]            # 按列存箱号，直方图循环更快
        for row in rows:
            for feature, value in enumerate(bin_row(row, thresholds)):
                columns[feature].append(value)
        sizes = [len(cuts) + 2 for cuts in thresholds]
        base = sum(targets) / len(targets)
        model = cls(thresholds, [], base, learning_rate)
        predictions = [base] * len(rows)
        rng = random.Random(seed)
        valid_bins = [bin_row(row, thresholds) for row in valid[0]] if valid else []
        valid_pred = [base] * len(valid_bins)
        best_loss, best_size = float("inf"), 0

        for round_index in range(n_trees):
            gradients = [target - prediction for target, prediction in zip(targets, predictions)]
            sample = [i for i in range(len(rows)) if rng.random() < subsample] if subsample < 1.0 else list(range(len(rows)))
            tree = _grow(columns, sizes, gradients, sample, max_depth, min_leaf, l2, learning_rate)
            model.trees.append(tree)
            for i in range(len(rows)):
                predictions[i] += _leaf_value(tree, columns, i)
            if valid:
                for i, bins in enumerate(valid_bins):
                    valid_pred[i] += _predict_tree(tree, bins)
                loss = sum(abs(t - p) for t, p in zip(valid[1], valid_pred)) / len(valid_pred)
                if loss < best_loss - 1e-6:
                    best_loss, best_size = loss, len(model.trees)
                if log and (round_index + 1) % 25 == 0:
                    log(f"  tree {round_index + 1}: valid MAE(log) {loss:.4f} (best {best_loss:.4f} @ {best_size})")
                if len(model.trees) - best_size >= patience:
                    break
        if valid:
            model.trees = model.trees[:best_size]
        return model

    # -------------------------------------------------------------- predict
    def predict(self, row: Row) -> float:
        bins = bin_row(row, self.thresholds)
        return self.base_score + sum(_predict_tree(tree, bins) for tree in self.trees)

    def feature_gain(self) -> List[float]:
        totals = [0.0] * len(self.thresholds)
        for tree in self.trees:
            for feature, gain in zip(tree["f"], tree["g"]):
                if feature >= 0:
                    totals[feature] += gain
        return totals

    # ------------------------------------------------------------- persist
    def to_dict(self) -> Dict[str, Any]:
        return {"thresholds": self.thresholds, "base_score": self.base_score, "learning_rate": self.learning_rate,
                "trees": [{"f": tree["f"], "b": tree["b"], "l": tree["l"], "r": tree["r"],
                           "v": [round(value, 6) for value in tree["v"]]} for tree in self.trees]}

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "BoostedTrees":
        trees = [{**tree, "g": [0.0] * len(tree["f"])} for tree in payload["trees"]]
        return cls(payload["thresholds"], trees, payload["base_score"], payload["learning_rate"])


def _predict_tree(tree: Dict[str, List[Any]], bins: Sequence[int]) -> float:
    node = 0
    features, cuts, left, right = tree["f"], tree["b"], tree["l"], tree["r"]
    while features[node] >= 0:
        node = left[node] if bins[features[node]] <= cuts[node] else right[node]
    return tree["v"][node]


def _leaf_value(tree: Dict[str, List[Any]], columns: Sequence[Sequence[int]], index: int) -> float:
    node = 0
    features, cuts, left, right = tree["f"], tree["b"], tree["l"], tree["r"]
    while features[node] >= 0:
        node = left[node] if columns[features[node]][index] <= cuts[node] else right[node]
    return tree["v"][node]


def _grow(columns: Sequence[Sequence[int]], sizes: Sequence[int], gradients: Sequence[float],
          sample: List[int], max_depth: int, min_leaf: int, l2: float, learning_rate: float) -> Dict[str, List[Any]]:
    tree: Dict[str, List[Any]] = {"f": [], "b": [], "l": [], "r": [], "v": [], "g": []}

    def add(indices: List[int], depth: int) -> int:
        node = len(tree["f"])
        for key in ("f", "b", "l", "r", "v", "g"):
            tree[key].append(-1 if key in ("f", "b", "l", "r") else 0.0)
        count = len(indices)
        total = 0.0
        for i in indices:
            total += gradients[i]
        tree["v"][node] = learning_rate * total / (count + l2)
        if depth >= max_depth or count < 2 * min_leaf:
            return node
        parent = total * total / (count + l2)
        best_gain, best_feature, best_bin = 1e-9, -1, -1
        for feature, column in enumerate(columns):
            size = sizes[feature]
            if size <= 2:
                continue
            grad_hist = [0.0] * size
            count_hist = [0] * size
            for i in indices:
                b = column[i]
                grad_hist[b] += gradients[i]
                count_hist[b] += 1
            left_grad, left_count = 0.0, 0
            for b in range(size - 1):
                left_grad += grad_hist[b]
                left_count += count_hist[b]
                right_count = count - left_count
                if left_count < min_leaf:
                    continue
                if right_count < min_leaf:
                    break
                right_grad = total - left_grad
                gain = left_grad * left_grad / (left_count + l2) + right_grad * right_grad / (right_count + l2) - parent
                if gain > best_gain:
                    best_gain, best_feature, best_bin = gain, feature, b
        if best_feature < 0:
            return node
        column = columns[best_feature]
        left_indices = [i for i in indices if column[i] <= best_bin]
        right_indices = [i for i in indices if column[i] > best_bin]
        tree["f"][node], tree["b"][node], tree["g"][node] = best_feature, best_bin, best_gain
        tree["l"][node] = add(left_indices, depth + 1)
        tree["r"][node] = add(right_indices, depth + 1)
        return node

    add(sample, 0)
    return tree
