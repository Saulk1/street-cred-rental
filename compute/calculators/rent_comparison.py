"""Compare a proposed rent to one historical asking-rent observation."""
from decimal import Decimal, ROUND_HALF_UP
import math


def calculate(inputs, datasets, context):
    context.check_deadline()
    record = datasets["latest_rent"]
    if not isinstance(record, dict):
        return {"status": "unavailable", "message": "No historical rental listing is available for this property."}
    price = record.get("price")
    if type(price) not in (int, float) or not math.isfinite(price) or price <= 0 or record.get("type") != "For Rent":
        return {"status": "unavailable", "message": "The latest listing has no valid positive weekly asking rent."}
    proposed = Decimal(str(inputs["weekly_rent_aud"]))
    periods_per_year = {"week": Decimal(52), "fortnight": Decimal(26), "month": Decimal(12), "year": Decimal(1)}
    reference = Decimal(str(price)) * periods_per_year[inputs["reference_period"]] / 52
    difference = proposed - reference

    def rounded(value):
        return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

    return {
        "status": "ok",
        "metrics": [
            {"key": "reference_weekly_rent", "label": "Historical asking rent converted to weekly", "value": rounded(reference), "unit": "AUD/week"},
            {"key": "weekly_difference", "label": "Weekly difference", "value": rounded(difference), "unit": "AUD/week"},
            {"key": "annual_difference", "label": "Annual difference", "value": rounded(difference * 52), "unit": "AUD/year"},
            {"key": "difference_percent", "label": "Difference from historical asking rent", "value": rounded(difference / reference * 100), "unit": "%"},
        ],
        "assumptions": ["Proposed rent is weekly in AUD. The user confirmed the historical rent period as: " + inputs["reference_period"] + ".",
                        "Period conversions use 52 weeks, 26 fortnights or 12 months per year; fees and future changes are excluded."],
        "warnings": ["The reference is a historical asking rent, not a current rental valuation or a signed lease.",
                     "Listing date: " + str(record.get("date") or "not supplied by the API")],
    }
