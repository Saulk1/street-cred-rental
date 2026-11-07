// Invented data for local visual QA. No API traffic, credentials or real notes.
const payloads = {
  '/valuation/avm': { predicted_price: 805500, predicted_price_low: 628000, predicted_price_high: 983000, prediction_date: '2026-09-01', confidence_score: 95 },
  '/rent-history-latest': { price: 720, date: '2026-09-01', type: 'For Rent' },
  '/sale-history-latest': { price: 612000, date: '2019-03-01', type: 'Sold' },
  '/comparables/recent-sales-nearby': [
    { address: 'Example nearby address 1', bedrooms: 3, price: 790000, dist_km: 0.3, date_sold: '2026-09-01' },
    { address: 'Example nearby address 2', bedrooms: 3, price: 842000, dist_km: 0.6, date_sold: '2026-08-01' },
    { address: 'Example nearby address 3', bedrooms: 4, price: 915000, dist_km: 0.9, date_sold: '2026-07-01' },
    { address: 'Example nearby address 4', bedrooms: 2, price: 680000, dist_km: 0.8, date_sold: '2026-06-01' },
  ],
  '/development/zoning-code': { code: 'R2', name: 'Low Density Residential', category: 'Residential Zones' },
  '/transport/nearby': { nearest: { train: { name: 'Example Station', distance_m: 650 }, bus: { label: 'Bus stop', distance_m: 300 } } },
  '/amenities/nearby': { results: [{ name: 'Example Park', category: 'Park', distance_m: 400 }, { name: 'Example Supermarket', category: 'Supermarket', distance_m: 400 }, { name: 'Example GP Clinic', category: 'Medical', distance_m: 700 }] },
  '/risks/all': { flood: [], bushfire: [{ on_property: false }] },
};
payloads['/lifestyle/livability'] = { area_name: 'Surry Hills (NSW)', area_level: 'suburb', scores: [{ key: 'lifestyle', value: 70 }, { key: 'convenience', value: 80 }, { key: 'family', value: 60 }, { key: 'safety', value: 90 }, { key: 'tranquility', value: 60 }] };
const report = {
  id: 'preview-report', candidate: { id: 'GANSWEXAMPLE', label: 'Example home, Sydney NSW' }, state: 'complete', selectedAt: 1, updatedAt: Date.now(),
  total: 9, completed: 9, errors: 0, supporting: [],
  tasks: Object.keys(payloads).map(path => ({ id: path, endpoint: (path === '/lifestyle/livability' ? '/v1/suburbs/{suburb_name}' : '/v1/properties/{gnaf_id}') + path, group: 'Example data', title: path.slice(1), status: 'ok', savedAt: 1 })),
};
const listeners = new Set();
const notes = {};
globalThis.chrome = {
  runtime: { getURL: path => '../../extension/' + path, openOptionsPage: async () => {}, sendMessage: async message => message.type === 'REPORT_READ' ? { ok: true, report: location.search.includes('empty') ? null : report } : { ok: true, result: { data: payloads[message.taskId] } } },
  windows: { getCurrent: async () => ({ id: 7 }) }, sidePanel: { open: async () => {} }, tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ ok: true }) },
  storage: { local: { get: async () => ({ ...notes }), set: async items => { Object.assign(notes, items); listeners.forEach(fn => fn(items, 'local')); }, remove: async key => { delete notes[key]; listeners.forEach(fn => fn({ [key]: {} }, 'local')); } }, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
};
