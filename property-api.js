"use strict";

// Only the worker loads this file and its generated configuration.
const PROPERTY_API = (() => {
  const inFlight = new Map();
  let gate = Promise.resolve();
  let nextStart = 0;
  let retryAt = 0;
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" && value.trim() ? value : null;
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const riskKeys = ["bushfire", "flood", "historical_flood", "heritage", "public_housing", "landslide",
    "erosion", "environment", "hv_power_line", "mobile_black_spot"];

  class ApiError extends Error {
    constructor(code, message, extra = {}) { super(message); this.detail = { code, message, ...extra }; }
  }
  const invalid = () => new ApiError("response", "Microburbs returned an unexpected response. Please retry.");
  function configuration() {
    const config = globalThis.MICROBURBS_CONFIG;
    if (!config?.apiKey || !config?.baseUrl) {
      throw new ApiError("configuration", "Set MICROBURBS_API_KEY and MICROBURBS_API_BASE_URL in .env.local, rebuild, and reload the extension.");
    }
    return config;
  }

  async function request(path) {
    const config = configuration();
    if (inFlight.has(path)) return inFlight.get(path);
    const promise = (async () => {
      const rateError = () => new ApiError("rate_limit", "Microburbs is rate limiting requests. Retry after the wait.", { retryAt });
      const turn = gate.then(async () => {
        if (Date.now() < retryAt) throw rateError();
        const delay = nextStart - Date.now();
        if (delay > 0) await sleep(delay);
        if (Date.now() < retryAt) throw rateError();
        nextStart = Date.now() + 125;
      });
      gate = turn.catch(() => {});
      await turn;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(config.baseUrl + path, {
          headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
          signal: controller.signal, credentials: "omit", redirect: "error",
        });
        const requestId = response.headers.get("X-Request-Id")?.slice(0, 100);
        const extra = requestId ? { requestId } : {};
        if (!response.ok) {
          if (response.status === 429) {
            const header = response.headers.get("Retry-After");
            const seconds = header === null ? NaN : Number(header);
            retryAt = Math.max(retryAt, Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000
              : Math.max(Date.now() + 1000, Date.parse(header) || 0));
            throw new ApiError("rate_limit", "Microburbs is rate limiting requests. Retry after the wait.", { ...extra, retryAt });
          }
          if (response.status === 401) throw new ApiError("authentication", "The team API key was rejected. Check .env.local, rebuild, and reload the extension.", extra);
          if (response.status === 403) throw new ApiError("coverage", "Outside City of Sydney hackathon coverage, or this endpoint is unavailable.", extra);
          if (response.status === 422) throw new ApiError("validation", "Microburbs could not process this address or property identifier.", extra);
          throw new ApiError("server", "Microburbs is unavailable. Please retry.", extra);
        }
        const envelope = await response.json();
        if (!object(envelope) || !Object.hasOwn(envelope, "data")) throw invalid();
        return envelope.data;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (controller.signal.aborted) throw new ApiError("timeout", "The Microburbs request timed out. Please retry.");
        if (error instanceof SyntaxError) throw invalid();
        throw new ApiError("network", "Could not reach Microburbs. Check your connection and retry.");
      } finally { clearTimeout(timeout); }
    })();
    inFlight.set(path, promise);
    try { return await promise; } finally { inFlight.delete(path); }
  }

  function basics(data) {
    if (!object(data)) throw invalid();
    return { dwelling_type: text(data.dwelling_type), bed_count: number(data.bed_count), bath_count: number(data.bath_count),
      parking_count: number(data.parking_count), land_area_sqm: number(data.land_area_sqm) };
  }
  function valuation(data) {
    if (!object(data)) throw invalid();
    return { predicted_price: number(data.predicted_price), predicted_price_low: number(data.predicted_price_low),
      predicted_price_high: number(data.predicted_price_high), prediction_date: text(data.prediction_date),
      confidence_score: number(data.confidence_score) <= 100 ? number(data.confidence_score) : null };
  }
  function risks(data) {
    if (!object(data)) throw invalid();
    return Object.fromEntries(riskKeys.map(key => [key, Array.isArray(data[key]) ? data[key].filter(object).map(row => ({
      name: text(row.name), value: text(row.value) ?? number(row.value), value_unit: text(row.value_unit),
      on_property: typeof row.on_property === "boolean" ? row.on_property : null,
      nearest_distance_m: number(row.nearest_distance_m), search_radius_m: number(row.search_radius_m),
    })) : null]));
  }
  function history(data) {
    if (!object(data)) throw invalid();
    return { date: text(data.date), price: number(data.price), type: text(data.type), address: text(data.address) };
  }
  function planning(data) {
    if (!object(data)) throw invalid();
    const zone = data.zoning_code;
    return {
      zoning_code: object(zone) ? { code: text(zone.code), name: text(zone.name), category: text(zone.category) } : null,
      zoning_overlays: Array.isArray(data.zoning_overlays) ? data.zoning_overlays.filter(object).map(row => ({
        layer: text(row.layer), value: text(row.value),
      })) : null,
    };
  }
  function schools(data) {
    if (!Array.isArray(data)) throw invalid();
    return data.filter(object).map(row => ({ id: number(row.id), name: text(row.name), sector: text(row.sector),
      school_level_type: text(row.school_level_type), distance_m: number(row.distance_m) }))
      .sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity));
  }
  function counts(data) {
    if (!object(data)) return {};
    return Object.fromEntries(Object.entries(data).map(([key, count]) => [key, number(count)]));
  }
  function amenities(data) {
    if (!object(data) || !Array.isArray(data.results)) throw invalid();
    return { radius_m: number(data.radius_m), counts: counts(data.counts), results: data.results.filter(object).map(row => ({
      name: text(row.name), category: text(row.category), distance_m: number(row.distance_m),
    })).sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity)) };
  }
  function transport(data) {
    if (!object(data) || !object(data.nearest)) throw invalid();
    return { radius_m: number(data.radius_m), counts: counts(data.counts), nearest: Object.fromEntries(
      ["train", "tram", "bus", "ferry"].map(mode => {
        const row = data.nearest[mode];
        return [mode, object(row) ? { name: text(row.name), label: text(row.label), distance_m: number(row.distance_m) } : null];
      })) };
  }
  async function extra(id, key, part) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)
      || !["market", "planning", "schools", "amenities", "transport"].includes(key)
      || (part !== undefined && (key !== "market" || !["sale", "rent"].includes(part)))) {
      return { ok: false, error: { code: "validation", message: "Choose a supported property section." } };
    }
    const prefix = `/v1/properties/${encodeURIComponent(id)}`;
    if (key === "market") {
      const parts = part ? [part] : ["sale", "rent"];
      const values = await Promise.all(parts.map(name => section(prefix + `/${name}-history-latest`, history)));
      return { ok: true, market: Object.fromEntries(parts.map((name, index) => [name, values[index]])) };
    }
    const endpoints = { planning: ["/development/all", planning], schools: ["/schools/nearby", schools],
      amenities: ["/amenities/nearby?radius_m=1000", amenities], transport: ["/transport/nearby?radius_m=1000", transport] };
    const [path, normalise] = endpoints[key];
    return { ok: true, section: await section(prefix + path, normalise) };
  }
  async function section(path, normalise) {
    try {
      const data = await request(path);
      return data === null ? { status: "empty" } : { status: "ok", data: normalise(data) };
    } catch (error) { return { status: "error", error: error.detail ?? invalid().detail }; }
  }
  async function search(address) {
    try {
      const data = await request(`/v1/geocode/address?${new URLSearchParams({ address })}`);
      if (data !== null && !Array.isArray(data)) throw invalid();
      const candidates = (data ?? []).filter(object).flatMap(row => {
        const label = text(row.display_name) ?? text(row.name) ?? text(row.abbr);
        return typeof row.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(row.id) && label
          ? [{ id: row.id, label, propertyType: text(row.property_type) }] : [];
      }).slice(0, 10);
      return { ok: true, candidates };
    } catch (error) { return { ok: false, error: error.detail ?? invalid().detail }; }
  }
  async function details(id) {
    const prefix = `/v1/properties/${encodeURIComponent(id)}`;
    const values = await Promise.all([section(prefix + "/basics/all", basics),
      section(prefix + "/valuation/avm", valuation), section(prefix + "/risks/all", risks)]);
    return { ok: true, sections: { basics: values[0], valuation: values[1], risks: values[2] } };
  }
  return Object.freeze({ search, details, extra });
})();
