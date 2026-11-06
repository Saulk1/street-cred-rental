"use strict";

// Main-world UI preview only. The real extension uses its isolated-world worker.
chrome.runtime = { async sendMessage(message) {
  const scenario = document.getElementById("scenario").value;
  if (message.type === "SEARCH_ADDRESS") return { ok: true, candidates: scenario === "empty" ? [] : [
    { id: "GANSW705970502", label: "26 Tudor Street, Surry Hills (mock)" },
    ...(scenario === "multiple" ? [{ id: "GANSWDEMO2", label: "Unit 2/26 Tudor Street, Surry Hills (mock)" }] : []),
  ] };
  return { ok: true, sections: {
    basics: { status: "ok", data: { dwelling_type: "house", bed_count: 3, bath_count: 2, parking_count: 0, land_area_sqm: 120 } },
    valuation: scenario === "partial" ? { status: "error", error: { message: "Mock valuation is unavailable. Retry to request it again." } }
      : { status: "ok", data: { predicted_price: 1200000, predicted_price_low: 1000000,
        predicted_price_high: 1400000, prediction_date: "2026-04-20", confidence_score: 70 } },
    risks: { status: "ok", data: {
      bushfire: [], flood: [{ on_property: false, nearest_distance_m: 257 }], historical_flood: null,
      heritage: [{ on_property: true, nearest_distance_m: 0 }], landslide: [], erosion: [], environment: null,
      hv_power_line: [{ on_property: false, nearest_distance_m: 341 }], mobile_black_spot: [],
      public_housing: [{ on_property: true, value: "3.4%", value_unit: "Properties Proportion", nearest_distance_m: 0 }],
    } },
  } };
} };

let active;
document.getElementById("preview").addEventListener("click", async () => {
  active?.dispose();
  document.getElementById("microburbs-facts-selection-card")?.remove();
  const host = document.createElement("div");
  host.id = "microburbs-facts-selection-card";
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(await (await fetch("../../content-script/selection-card.css")).text());
  shadow.adoptedStyleSheets = [sheet];
  document.documentElement.append(host);
  host.style.left = "16px";
  host.style.top = "180px";
  active = PROPERTY_LOOKUP.attach({ host, shadow, selection: { text: "26 Tudor Street, Surry Hills" },
    isCurrent: () => host.isConnected, reposition() {} });
});
