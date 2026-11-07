"""Explicit module registry and shared calculator contracts."""
import json
import math
import time
from pathlib import Path

from compute.calculators.rent_comparison import calculate as rent_comparison

CATALOG = json.loads(Path(__file__).with_name("catalog.json").read_text())
CALCULATORS = {"rent_comparison": rent_comparison}


class ComputeError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


class Context:
    def __init__(self, deadline_ms):
        self.deadline_ms = deadline_ms

    def check_deadline(self):
        if time.time() * 1000 >= self.deadline_ms:
            raise ComputeError("timeout", "Calculation exceeded its deadline.")


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def run(payload):
    if not isinstance(payload, dict) or set(payload) != {"calculator", "version", "inputs", "datasets", "deadlineMs"}:
        raise ComputeError("validation", "Invalid calculation request.")
    calculator = payload["calculator"]
    if not isinstance(calculator, str) or calculator not in CALCULATORS:
        raise ComputeError("validation", "Unknown calculator.")
    contract = next(item for item in CATALOG if item["id"] == calculator)
    if payload["version"] != contract["version"]:
        raise ComputeError("version", "Calculator versions do not match. Redeploy both functions together.")
    deadline = payload["deadlineMs"]
    now = time.time() * 1000
    if not finite_number(deadline) or deadline > now + 10000:
        raise ComputeError("validation", "Invalid calculation deadline.")
    context = Context(deadline)
    context.check_deadline()
    inputs, datasets = payload["inputs"], payload["datasets"]
    if not isinstance(inputs, dict) or set(inputs) != {item["key"] for item in contract["inputs"]}:
        raise ComputeError("validation", "Invalid user input fields.")
    missing = []
    for field in contract["inputs"]:
        value = inputs[field["key"]]
        if value is None:
            missing.append({"key": field["key"], "label": field["label"], "unit": field["unit"]})
        elif field["type"] == "number":
            if not finite_number(value) or not field["minimum"] <= value <= field["maximum"]:
                raise ComputeError("validation", "User inputs must be finite numbers in the supported range.")
        elif not isinstance(value, str) or value not in field["options"]:
            raise ComputeError("validation", "Choose a supported input option.")
    if not isinstance(datasets, dict) or set(datasets) != {item["key"] for item in contract["datasets"]}:
        raise ComputeError("validation", "Invalid calculation datasets.")
    if missing:
        return {"status": "needs_input", "missing": missing}
    result = CALCULATORS[calculator](inputs, datasets, context)
    context.check_deadline()
    # Fail at the boundary instead of emitting Python's nonstandard NaN/Infinity JSON.
    json.dumps(result, allow_nan=False)
    return {"calculator": calculator, "version": contract["version"], **result}
