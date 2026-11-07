"use strict";

globalThis.REPORT_PLAN = (() => {
  const profilePath = '/v1/properties/{gnaf_id}/profile';
  const fieldsPath = '/v1/area-stats/fields';
  const valuesPath = '/v1/area-stats/{region_level}/{region}/values';
  const registry = new Map(REPORT_ENDPOINTS.map(endpoint => [endpoint.path, endpoint]));
  const regions = { SAL: 'suburb', SA1: 'sa1', SA2: 'sa2', SA3: 'sa3', SA4: 'sa4', LGA: 'lga', POA: 'postcode', GCCSA: 'gccsa', STE: 'state' };
  function task(endpoint, identifiers, extra = {}) {
    const missing = [];
    const path = endpoint.path.replace(/\{(\w+)\}/g, (_, name) => {
      const value = identifiers[name];
      if (typeof value !== 'string' || !value.trim()) { missing.push(name); return ''; }
      return encodeURIComponent(value);
    });
    const query = new URLSearchParams();
    for (const parameter of endpoint.query) {
      if (parameter.default !== undefined) query.set(parameter.name, String(parameter.default));
      if (parameter.name === 'geojson' || parameter.name === 'counts' || parameter.name === 'verbose') query.set(parameter.name, 'true');
      if (parameter.name === 'limit' && endpoint.path === fieldsPath) query.set('limit', '500');
      // Paging is explicit, including endpoints with no documented default size.
      if (parameter.name === 'limit' && endpoint.query.some(p => p.name === 'offset')) query.set('limit', String(parameter.default ?? 200));
    }
    for (const [name, value] of Object.entries(extra)) query.set(name, String(value));
    for (const parameter of endpoint.query) if (parameter.required && !query.has(parameter.name)) missing.push(parameter.name);
    query.sort();
    const url = path + (query.size ? '?' + query : '');
    return { id: url, endpoint: endpoint.path, title: endpoint.title, group: endpoint.group,
      status: missing.length ? 'skipped' : 'pending', reason: missing.length ? `Missing identifier: ${missing.join(', ')}` : undefined,
      documentation: endpoint.description,
      notice: !endpoint.query.some(p => p.name === 'offset') && /\b(?:cap|capped|limit|limited|max|maximum)\b/i.test(endpoint.description) ? 'This endpoint may limit returned records. See API coverage and limits below.' : undefined,
      path: url, query: Object.fromEntries(query), identifiers, attempts: 0 };
  }
  function start(candidate) {
    const identifiers = { gnaf_id: candidate.id };
    return [task(registry.get(profilePath), identifiers),
      ...REPORT_ENDPOINTS.filter(e => e.scope === 'property' && e.path !== profilePath).map(e => task(e, identifiers))];
  }
  function geographic(profile) {
    const identifiers = { suburb_name: profile?.suburb, mb_code: profile?.mesh_block, lga_name: profile?.lga, sa4_name: profile?.sa4 };
    return REPORT_ENDPOINTS.filter(e => e.scope === 'suburb' || e.scope === 'regional').flatMap(endpoint => {
      const layers = endpoint.query.find(p => p.name === 'layer')?.enum ?? [undefined];
      return layers.map(layer => task(endpoint, identifiers, layer ? { layer } : {}));
    }).concat(task(registry.get(fieldsPath), {}), task(registry.get(valuesPath), {}));
  }
  function statistics(profile, fields) {
    const codes = [...new Set((Array.isArray(fields?.fields) ? fields.fields : []).map(field => field?.field_code).filter(code => typeof code === 'string' && code.trim()))];
    const result = [];
    for (const [level, key] of Object.entries(regions)) {
      if (typeof profile?.[key] !== 'string' || !profile[key]) continue;
      for (let i = 0; i < codes.length; i += 5) {
        result.push(task(registry.get(valuesPath), { region_level: level, region: profile[key] }, { fields: codes.slice(i, i + 5).join(',') }));
      }
    }
    return result;
  }
  function nextPage(current, envelope) {
    const endpoint = registry.get(current.endpoint);
    if (!endpoint.query.some(p => p.name === 'offset')) return;
    const data = envelope.data;
    const meta = data?.meta ?? envelope.meta ?? {};
    const offset = Number(current.query.offset ?? 0), limit = Number(current.query.limit ?? 200);
    const rows = Array.isArray(data) ? data : [data?.results, data?.points, data?.streets, data?.pois, data?.sales,
      ...Object.values(data && typeof data === 'object' ? data : {})].find(Array.isArray);
    const returned = Number(meta.returned ?? rows?.length ?? 0);
    const total = Number(meta.total ?? data?.total ?? (current.endpoint.endsWith('/repeat-sales') ? data?.n : undefined));
    const next = meta.next_offset == null ? offset + returned : Number(meta.next_offset);
    if (!Number.isFinite(next) || next <= offset || returned === 0) return;
    if (meta.next_offset == null && (Number.isFinite(total) ? next >= total : returned < limit)) return;
    return task(endpoint, current.identifiers, { ...current.query, offset: next });
  }
  const supporting = REPORT_ENDPOINTS.filter(e => e.scope === 'support' || e.path === '/v1/area-stats/regions').map(e => ({ endpoint: e.path, reason: 'Discovery, search or account endpoint; not a dataset for the confirmed address.' }));
  return Object.freeze({ start, geographic, statistics, nextPage, profilePath, fieldsPath, valuesPath, supporting });
})();
