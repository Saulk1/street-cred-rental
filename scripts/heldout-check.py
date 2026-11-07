"""Post-implementation synthetic audit; writes evidence, never changes application code."""
import csv
import hashlib
import json
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from compute.registry import ComputeError, run

SEED = 202611071507
FROZEN = ["compute/catalog.json", "compute/registry.py", "compute/calculators/rent_comparison.py",
          "server/compute.ts", "src/lib/wellbeing.ts"]


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FROZEN}


def cents_half_up(value):
    """Independent rational oracle: integer quotient/remainder; no Decimal import."""
    numerator, denominator = abs(value.numerator) * 100, value.denominator
    quotient, remainder = divmod(numerator, denominator)
    return (-1 if value < 0 else 1) * (quotient + int(remainder * 2 >= denominator))


def expected(proposed_cents, reference_cents, period):
    annual_reference = Fraction(reference_cents, 100) * {"week": 52, "fortnight": 26, "month": 12, "year": 1}[period]
    annual_proposed = Fraction(proposed_cents, 100) * 52
    annual_difference = annual_proposed - annual_reference
    return [cents_half_up(v) / 100 for v in [annual_reference / 52, annual_difference / 52,
                                            annual_difference, annual_difference / annual_reference * 100]]


def payload(proposed=694.23, reference=2845.37, period="month"):
    return {"calculator": "rent_comparison", "version": "1.0.0", "inputs": {"weekly_rent_aud": proposed, "reference_period": period},
            "datasets": {"latest_rent": {"price": reference, "type": "For Rent", "date": "2024-03-18", "address": "Synthetic audit record"}},
            "deadlineMs": time.time() * 1000 + 8000}


PROBE = r'''
import { it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { computationClient } from '../../server/compute';

it('records an adversarial semantic-evidence challenge without changing production code', async () => {
  vi.stubEnv('COMPUTE_API_URL', 'https://compute.example.test/api/compute');
  vi.stubEnv('COMPUTE_SERVICE_TOKEN', 'dummy-report-audit-token-32-characters');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const output = execFileSync('python3', ['-c', 'import json,sys; from compute.registry import run; print(json.dumps(run(json.load(sys.stdin))))'], { input: init!.body as string });
    return Response.json(JSON.parse(output.toString()));
  });
  const message = 'Proposed rent is $694.23 per week. The historical listing amount is per month.';
  const execute = vi.fn(async () => ({ status: 'ok', source: { id: 'S1' }, retrievedAt: '2026-11-07T00:00:00.000Z',
    data: { price: 2845.37, type: 'For Rent', date: '2024-03-18' } }));
  const compute = computationClient(execute, [{ role: 'user', content: message }], new AbortController().signal, vi.fn(), Date.now() + 55000);
  let observed: any;
  try {
    const result: any = await compute('compute_rent_comparison', { id: 'GANSWREPORT', inputs: {
      weekly_rent_aud: { value: 694.23, quote: '$694.23 per week', message_index: 0 },
      reference_period: { value: 'week', quote: 'per week', message_index: 0 },
    } });
    observed = { status: result.status, metrics: result.calculation?.metrics.map((m: any) => m.value) };
  } catch (error: any) { observed = { status: 'rejected', code: error.code }; }
  writeFileSync('.build/report-evaluation/semantic-probe.json', JSON.stringify({
    name: 'Reference period borrowed from proposed-rent wording despite explicit monthly history',
    user_message: message, supplied_reference_period: 'week', supplied_quote: 'per week',
    expected: 'rejected', observed, passed: observed.status === 'rejected',
    scope: 'Adversarial model-tool arguments; no live model or external API called.',
  }, null, 2));
  expect(observed.status).toBeDefined(); // Harness completion, not a claim that the product passed.
  vi.restoreAllMocks();
});
'''


def main():
    before = fingerprints()
    numerical = []
    selected = [(69423, 284537, "month"), (48765, 126079, "fortnight"),
                (83104, 4218763, "year"), (0, 91327, "week"), (0, 26, "year")]
    rng = random.Random(SEED)
    for period in ("week", "fortnight", "month", "year"):
        selected.extend((rng.randrange(0, 250001), rng.randrange(1, 6000001), period) for _ in range(40))
    for index, (proposed, reference, period) in enumerate(selected, 1):
        oracle = expected(proposed, reference, period)
        result = run(payload(proposed / 100, reference / 100, period))
        actual = [m["value"] for m in result["metrics"]]
        numerical.append({"id": index, "proposed_weekly_aud": proposed / 100, "historical_amount_aud": reference / 100,
                          "historical_period": period, "expected": oracle, "actual": actual, "passed": actual == oracle})

    guards = []
    cases = []
    def case(name, expected_status, change):
        body = payload(); change(body); cases.append((name, expected_status, body))
    case("Missing historical period", "needs_input", lambda p: p["inputs"].update(reference_period=None))
    case("Missing proposed rent", "needs_input", lambda p: p["inputs"].update(weekly_rent_aud=None))
    case("Both inputs missing", "needs_input", lambda p: p["inputs"].update(weekly_rent_aud=None, reference_period=None))
    case("Zero reference amount", "unavailable", lambda p: p["datasets"]["latest_rent"].update(price=0))
    case("Missing reference amount", "unavailable", lambda p: p["datasets"]["latest_rent"].update(price=None))
    case("String reference amount", "unavailable", lambda p: p["datasets"]["latest_rent"].update(price="2845.37"))
    case("Non-rental listing", "unavailable", lambda p: p["datasets"]["latest_rent"].update(type="Sold"))
    case("No listing record", "unavailable", lambda p: p["datasets"].update(latest_rent=None))
    case("Negative proposal", "validation", lambda p: p["inputs"].update(weekly_rent_aud=-0.01))
    case("Boolean proposal", "validation", lambda p: p["inputs"].update(weekly_rent_aud=True))
    case("String proposal", "validation", lambda p: p["inputs"].update(weekly_rent_aud="694.23"))
    case("Unsupported period", "validation", lambda p: p["inputs"].update(reference_period="day"))
    case("Expired deadline", "timeout", lambda p: p.update(deadlineMs=1))
    case("Version mismatch", "version", lambda p: p.update(version="9.9.9"))
    case("Arbitrary module path", "validation", lambda p: p.update(calculator="../../os"))
    case("Caller-injected extra field", "validation", lambda p: p.update(code="untrusted"))
    for name, wanted, body in cases:
        try: observed = run(body)["status"]
        except ComputeError as error: observed = error.code
        guards.append({"name": name, "expected": wanted, "actual": observed, "passed": observed == wanted})

    keys = ["lifestyle", "convenience", "family", "safety", "tranquility"]
    def area(values):
        return {"area_name": "Synthetic audit suburb", "area_level": "suburb", "scores": [{"key": key, "value": value} for key, value in zip(keys, values)]}
    wellbeing = [
        {"name": "Five dimensions", "input": area([83, 67, 51, 92, 38]), "expected": {"value": 66, "available": 5}},
        {"name": "Three dimensions including zero", "input": area([0, 45, 90, None, None]), "expected": {"value": 45, "available": 3}},
        {"name": "Two dimensions", "input": area([21, 63, None, None, None]), "expected": {"value": None, "available": 2}},
        {"name": "Invalid range and string excluded", "input": area([99, 34, -2, 104, "72"]), "expected": {"value": None, "available": 2}},
        {"name": "Final rounding only", "input": area([12.49, 12.49, 13.49]), "expected": {"value": 13, "available": 3}},
        {"name": "Address-level scope rejected", "input": {**area([81, 73, 69]), "area_level": "property"}, "expected": {"value": None, "available": 3}},
        {"name": "Unnamed suburb rejected", "input": {**area([81, 73, 69]), "area_name": ""}, "expected": {"value": None, "available": 3}},
        {"name": "Duplicate dimension treated as ambiguous", "input": {**area([22, 44, 66]), "scores": area([22, 44, 66])["scores"] + [{"key": "lifestyle", "value": 88}]}, "expected": {"value": None, "available": 2}},
    ]
    node = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e",
        'import {calculateWellbeing} from "./src/lib/wellbeing.ts"; let text=""; for await(const c of process.stdin) text+=c; process.stdout.write(JSON.stringify(JSON.parse(text).map(c=>{const r=calculateWellbeing(c.input);return {value:r.value,available:r.available}})));'],
        input=json.dumps(wellbeing), text=True, capture_output=True, cwd=ROOT, check=True)
    for row, observed in zip(wellbeing, json.loads(node.stdout)):
        row["actual"], row["passed"] = observed, observed == row["expected"]

    work = ROOT / ".build/report-evaluation"
    work.mkdir(parents=True, exist_ok=True)
    (work / "probe.test.ts").write_text(PROBE)
    (work / "vitest.config.mts").write_text('export default { test: { environment: "node", unstubEnvs: true, include: [".build/report-evaluation/probe.test.ts"] } };\n')
    probe = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", "--config", ".build/report-evaluation/vitest.config.mts", "--reporter=dot"], cwd=ROOT, capture_output=True, text=True)
    if probe.returncode:
        raise RuntimeError("Semantic-probe harness failed: " + probe.stdout + probe.stderr)
    semantic = json.loads((work / "semantic-probe.json").read_text())
    resources = []
    for path in sorted((ROOT / "assets").glob("*.csv")):
        with path.open(newline="", encoding="utf-8-sig") as stream:
            reader = csv.reader(stream); fields = next(reader, []); count = sum(1 for _ in reader)
        resources.append({"file": str(path.relative_to(ROOT)), "rows": count, "fields": fields, "used_in_current_chat": False})
    groups = {"rent_arithmetic": numerical, "input_guards": guards, "wellbeing": wellbeing, "semantic_evidence": [semantic]}
    counts = {key: {"passed": sum(row["passed"] for row in rows), "total": len(rows)} for key, rows in groups.items()}
    evidence = {"generated_at": datetime.now(timezone.utc).isoformat(), "git_head": subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip(),
                "seed": SEED, "kind": "Post-implementation synthetic challenge; not a blind market-data holdout.",
                "source_sha256": before, "application_sources_unchanged": before == fingerprints(),
                "oracle": "Independent exact rational arithmetic, annualize first, integer half-up rounding to 2 decimals; no production calculator or Decimal used by oracle.",
                "metric_order": ["reference_weekly_rent", "weekly_difference", "annual_difference", "difference_percent"],
                "counts": counts, "groups": groups, "local_csv_inventory": resources,
                "limits": ["No live Microburbs or OpenAI calls", "No rental valuation or wellbeing ground-truth validation", "No blinded independent evaluator", "No production changes made in response to these results"]}
    output = ROOT / "reports/heldout-check.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"evidence": str(output.relative_to(ROOT)), "counts": counts, "application_sources_unchanged": evidence["application_sources_unchanged"], "examples": numerical[:5], "semantic_probe": semantic}, indent=2))


if __name__ == "__main__":
    main()
