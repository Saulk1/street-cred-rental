"use strict";

const PROPERTY_LOOKUP = Object.freeze({
  attach({ host, shadow, selection, isCurrent, reposition }) {
    const lookup = document.createElement("button");
    lookup.type = "button";
    lookup.textContent = "Look up property";
    const panel = document.createElement("section");
    panel.className = "property-results";
    panel.setAttribute("tabindex", "-1");
    panel.hidden = true;
    const announcement = document.createElement("p");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-atomic", "true");
    shadow.append(lookup, announcement, panel);
    let revision = 0;
    let candidates = [];
    const timers = new Set();
    const current = token => isCurrent() && token === revision;
    const element = (tag, text) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const absent = "Not available";
    const value = input => input === null || input === undefined ? absent : String(input);
    const money = input => typeof input === "number" ? new Intl.NumberFormat("en-AU", {
      style: "currency", currency: "AUD", maximumFractionDigits: 0,
    }).format(input) : absent;
    function expand() { host.setAttribute("data-expanded", "true"); panel.hidden = false; }
    function reset() { expand(); panel.replaceChildren(); }
    function button(label, action) {
      const node = element("button", label);
      node.type = "button";
      node.addEventListener("click", action);
      return node;
    }
    function finish(message, focus = false) {
      announcement.textContent = message;
      panel.setAttribute("aria-busy", "false");
      lookup.disabled = false;
      reposition();
      if (focus) panel.focus({ preventScroll: true });
    }
    function error(container, detail, retry) {
      container.append(element("p", detail?.message ?? "Could not look up this property. Please retry."));
      if (detail?.requestId) container.append(element("p", `Request ID: ${detail.requestId}`));
      const retryButton = button("Retry", retry);
      const delay = Math.max(0, (detail?.retryAt ?? 0) - Date.now());
      if (delay) {
        retryButton.disabled = true;
        container.append(element("p", `Retry available after ${new Date(detail.retryAt).toLocaleTimeString()}.`));
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (isCurrent()) retryButton.disabled = false;
        }, Math.min(delay, 2147483647));
        timers.add(timer);
      }
      container.append(retryButton);
    }
    async function send(message) {
      try {
        return await chrome.runtime.sendMessage(message) ?? { ok: false };
      } catch {
        return { ok: false, error: { message: "Could not contact the extension. Reload the page and retry." } };
      }
    }
    function rows(container, entries) {
      const list = element("dl");
      for (const [label, display] of entries) list.append(element("dt", label), element("dd", display));
      container.append(list);
    }
    function choices() {
      revision++;
      reset();
      panel.append(element("h2", "Choose the matching address"));
      const list = element("ul");
      for (const candidate of candidates) {
        const item = element("li");
        item.append(button(candidate.label, () => details(candidate)));
        list.append(item);
      }
      panel.append(list);
      finish("Choose an address to see property information.", true);
    }
    async function search() {
      if (lookup.disabled) return;
      const token = ++revision;
      reset();
      lookup.disabled = true;
      panel.setAttribute("aria-busy", "true");
      announcement.textContent = "Finding matching addresses…";
      reposition();
      const response = await send({ type: NOTEPAD.MESSAGES.SEARCH_ADDRESS, address: selection.text });
      if (!current(token)) return;
      if (!response.ok || !Array.isArray(response.candidates)) {
        error(panel, response.error, search);
        finish("Address lookup failed.");
        return;
      }
      candidates = response.candidates;
      if (candidates.length === 0) {
        panel.append(element("p", "No matching addresses were returned. Select a fuller address, including the suburb. Coverage is limited to the City of Sydney LGA."));
        finish("No matching addresses.", true);
      } else if (candidates.length === 1) {
        await details(candidates[0]);
      } else choices();
    }
    function riskSection(container, data) {
      const labels = { bushfire: "Bushfire", flood: "Flood", historical_flood: "Historical flood", heritage: "Heritage",
        landslide: "Landslide", erosion: "Erosion", environment: "Environment", hv_power_line: "High-voltage power lines", mobile_black_spot: "Mobile black spots" };
      for (const [key, label] of Object.entries(labels)) {
        const records = data[key];
        container.append(element("h4", label));
        if (!records) { container.append(element("p", absent)); continue; }
        if (!records.length) { container.append(element("p", "No matching records returned within the search radius (1 km).")); continue; }
        for (const record of records) {
          const proximityOnly = key === "hv_power_line" || key === "mobile_black_spot";
          const containment = proximityOnly ? "Nearby feature" : record.on_property === true ? "Overlay at the property's address point"
            : record.on_property === false ? "Not at the property's address point" : "Containment unknown";
          const distance = record.nearest_distance_m === null ? "" : `; nearest ${record.nearest_distance_m} m away`;
          container.append(element("p", containment + distance));
        }
      }
      container.append(element("h4", "Neighbourhood context: public housing"));
      const housing = data.public_housing;
      if (!housing) container.append(element("p", absent));
      else if (!housing.length) container.append(element("p", "No matching records returned within 1 km."));
      else for (const record of housing) {
        const area = record.on_property === true ? "Containing Census area" : record.on_property === false ? "Nearby Census area" : "Census area (location relation unknown)";
        container.append(element("p", `${area}: ${value(record.value)}${record.value_unit ? ` (${record.value_unit})` : ""}${record.nearest_distance_m === null ? "" : `; ${record.nearest_distance_m} m away`}`));
      }
      container.append(element("p", "Overlays are tested at the address point, not the surveyed parcel boundary. They do not replace a planning certificate."));
    }
    async function details(candidate) {
      const token = ++revision;
      reset();
      lookup.disabled = true;
      panel.setAttribute("aria-busy", "true");
      panel.append(element("h2", candidate.label), element("p", `GNAF: ${candidate.id}`));
      announcement.textContent = "Loading property information…";
      reposition();
      const response = await send({ type: NOTEPAD.MESSAGES.PROPERTY_DETAILS, id: candidate.id });
      if (!current(token)) return;
      if (!response.ok || !response.sections) {
        error(panel, response.error, () => details(candidate));
        finish("Property lookup failed.");
        return;
      }
      for (const [key, title] of [["basics", "Property facts"], ["valuation", "Automated valuation"], ["risks", "Overlays and nearby features"]]) {
        const group = element("section");
        group.append(element("h3", title));
        const section = response.sections[key];
        if (section?.status === "error") error(group, section.error, () => details(candidate));
        else if (section?.status !== "ok") group.append(element("p", absent));
        else if (key === "basics") {
          const data = section.data;
          rows(group, [["Property type", value(data.dwelling_type)], ["Bedrooms", value(data.bed_count)],
            ["Bathrooms", value(data.bath_count)], ["Covered parking spaces", value(data.parking_count)],
            ["Indicative land area", data.land_area_sqm === null ? absent : `${data.land_area_sqm} m²`]]);
        } else if (key === "valuation") {
          const data = section.data;
          rows(group, [["Model estimate (AUD)", money(data.predicted_price)],
            ["80% prediction interval (AUD)", `${money(data.predicted_price_low)} – ${money(data.predicted_price_high)}`],
            ["Prediction date", value(data.prediction_date)], ["Model confidence", data.confidence_score === null ? absent : `${data.confidence_score}/100`]]);
          group.append(element("p", "A model estimate, not a sale price or a formal appraisal."));
        } else riskSection(group, section.data);
        panel.append(group);
      }
      panel.append(element("p", "Source: Microburbs Hackathon API. Coverage: City of Sydney LGA."));
      if (candidates.length > 1) panel.append(button("Choose another match", choices));
      finish("Property information loaded. Unavailable sections are marked below.", true);
    }
    lookup.addEventListener("click", search);
    return { button: lookup, start: search, dispose() { revision++; for (const timer of timers) clearTimeout(timer); } };
  },
});
