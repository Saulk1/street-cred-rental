import io
import json
import os
import time
import unittest
from unittest.mock import patch

from api.compute import handler, process
from compute.registry import CATALOG, CALCULATORS, ComputeError, run

TOKEN = "dummy-compute-token-32-characters-long"


def payload(value=750, price=720):
    return {"calculator": "rent_comparison", "version": "1.0.0", "inputs": {"weekly_rent_aud": value, "reference_period": "week"},
            "datasets": {"latest_rent": {"price": price, "type": "For Rent", "date": "2025-07-24", "address": "Example address"}},
            "deadlineMs": time.time() * 1000 + 8000}


class ComputeTests(unittest.TestCase):
    def test_numerical_results_and_contract(self):
        result = run(payload())
        self.assertEqual(result["status"], "ok")
        self.assertEqual([m["value"] for m in result["metrics"]], [720, 30, 1560, 4.17])
        self.assertEqual([{k: m[k] for k in ("key", "label", "unit")} for m in result["metrics"]], CATALOG[0]["metrics"])
        self.assertIn("historical asking rent", result["warnings"][0])

    def test_zero_and_negative_differences(self):
        self.assertEqual(run(payload(0))["metrics"][3]["value"], -100)
        self.assertEqual(run(payload(720))["metrics"][1]["value"], 0)

    def test_decimal_money(self):
        result = run(payload(750.15, 720.10))
        self.assertEqual(result["metrics"][1]["value"], 30.05)
        self.assertEqual(result["metrics"][2]["value"], 1562.6)

    def test_missing_inputs(self):
        self.assertEqual(run(payload(None))["status"], "needs_input")
        body = payload(); body["inputs"]["reference_period"] = None
        self.assertEqual(run(body)["missing"][0]["key"], "reference_period")

    def test_period_conversions_use_user_confirmed_units(self):
        for period, price in [("month", 3120), ("fortnight", 1440), ("year", 37440)]:
            body = payload(price=price); body["inputs"]["reference_period"] = period
            self.assertEqual([m["value"] for m in run(body)["metrics"]], [720, 30, 1560, 4.17])
        body = payload(); body["inputs"]["reference_period"] = "guess"
        with self.assertRaises(ComputeError):
            run(body)

    def test_unknown_modules_and_versions(self):
        for key, value in [("calculator", "../../os"), ("calculator", ["rent_comparison"]), ("version", "bad")]:
            body = payload(); body[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ComputeError):
                run(body)
        self.assertEqual(set(CALCULATORS), {entry["id"] for entry in CATALOG})

    def test_rejects_invalid_numbers_fields_and_deadlines(self):
        for value in [True, "750", float("nan"), float("inf"), -1, 1000001]:
            with self.subTest(value=value), self.assertRaises(ComputeError):
                run(payload(value))
        for changes in [{"deadlineMs": 1}, {"deadlineMs": time.time() * 1000 + 60000}, {"inputs": {"other": 1}}, {"datasets": {}}, {"extra": "no"}]:
            with self.subTest(changes=changes), self.assertRaises(ComputeError):
                run({**payload(), **changes})

    def test_unavailable_is_not_zero_or_a_valuation(self):
        for price in [0, None, -1, "720", float("nan")]:
            self.assertEqual(run(payload(price=price))["status"], "unavailable")
        body = payload(); body["datasets"]["latest_rent"]["type"] = "Sold"
        self.assertEqual(run(body)["status"], "unavailable")

    @patch.dict(os.environ, {"COMPUTE_SERVICE_TOKEN": TOKEN})
    def test_endpoint_auth_validation_and_safe_failures(self):
        auth = "Bearer " + TOKEN
        raw = json.dumps(payload()).encode()
        self.assertEqual(process("GET", auth, "application/json", raw)[0], 405)
        self.assertEqual(process("POST", "wrong", "application/json", raw)[0], 401)
        self.assertEqual(process("POST", auth, "text/plain", raw)[0], 400)
        self.assertEqual(process("POST", auth, "application/json", b"invalid")[0], 400)
        self.assertEqual(process("POST", auth, "application/json", b"x" * 64001)[0], 400)
        self.assertEqual(process("POST", auth, "application/json", raw)[0], 200)
        with patch.dict(CALCULATORS, {"rent_comparison": lambda *_: (_ for _ in ()).throw(RuntimeError("private secret"))}):
            status, body = process("POST", auth, "application/json", raw)
            self.assertEqual(status, 500)
            self.assertNotIn("private secret", json.dumps(body))

    @patch.dict(os.environ, {"COMPUTE_SERVICE_TOKEN": ""})
    def test_unconfigured(self):
        self.assertEqual(process("POST", "", "application/json", b"{}")[0], 503)

    @patch.dict(os.environ, {"COMPUTE_SERVICE_TOKEN": TOKEN})
    def test_http_adapter_headers_and_body_limit(self):
        raw = json.dumps(payload()).encode()
        instance = handler.__new__(handler)
        instance.command = "POST"
        instance.headers = {"Content-Length": str(len(raw)), "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN}
        instance.rfile, instance.wfile = io.BytesIO(raw), io.BytesIO()
        headers = {}
        statuses = []
        instance.send_response = statuses.append
        instance.send_header = lambda k, v: headers.update({k: v})
        instance.end_headers = lambda: None
        instance.respond()
        self.assertEqual(statuses, [200])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(instance.wfile.getvalue())["status"], "ok")
        instance.headers["Content-Length"] = "64001"
        instance.respond()
        self.assertEqual(statuses[-1], 413)


if __name__ == "__main__":
    unittest.main()
