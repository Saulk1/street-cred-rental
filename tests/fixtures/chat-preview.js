// Browser-only fixture. Invented data and dummy credentials; never calls a service.
const origin = 'https://chat.example.test';
globalThis.CHAT_API_CONFIG = { baseUrl: origin, token: location.search.includes('unavailable') ? '' : 'dummy-preview-token' };
globalThis.chrome = { runtime: { getURL: path => '../../' + path, getManifest: () => ({ host_permissions: [origin + '/*'], content_security_policy: { extension_pages: 'connect-src ' + origin } }) },
  storage: { local: {
    get: async key => ({ [key]: JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? undefined }),
    set: async items => { for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, JSON.stringify(value)); },
    remove: async key => { sessionStorage.removeItem(key); },
  } } };
globalThis.fetch = async (_url, { signal }) => {
  let events = [
    { type: 'tool', id: 'lookup', label: 'Searching addresses', status: 'running' },
    { type: 'tool', id: 'lookup', label: 'Searching addresses', status: 'done' },
    { type: 'source', source: { id: 'S1', label: 'Example property · basics', path: '/v1/properties/GANSW1/basics/all' } },
    { type: 'delta', text: 'This is a fixture answer, using invented property data.\n\n' },
    { type: 'delta', text: 'The example has two bedrooms and one bathroom [S1]. Ask about schools, planning or transport for more context.' },
    { type: 'done' },
  ];
  if (location.search.includes('compute')) events = [
    { type: 'tool', id: 'compute', label: 'Calculating property comparison', status: 'running' },
    { type: 'source', source: { id: 'S1', label: 'Example property · historical rent', path: '/v1/properties/GANSW1/rent-history-latest' } },
    { type: 'calculation', calculation: {
      id: 'C1', calculator: 'rent_comparison', version: '1.0.0', title: 'Rent comparison', propertyId: 'GANSW1', computedAt: new Date().toISOString(),
      userInputs: [{ key: 'weekly_rent_aud', label: 'Proposed weekly rent', value: 750, unit: 'AUD/week', quote: '$750 per week', messageIndex: 0 },
        { key: 'reference_period', label: 'Historical listing rent period', value: 'week', unit: 'period', quote: 'The historical listing was weekly.', messageIndex: 0 }],
      apiInputs: [{ key: 'latest_rent', sourceId: 'S1', retrievedAt: new Date().toISOString(), coverage: 'Single latest rental observation; not a current rental valuation.', data: { price: 720, type: 'For Rent', date: '2025-07-24', address: '26 Example Street' } }],
      metrics: [
        { key: 'reference_weekly_rent', label: 'Historical asking rent converted to weekly', value: 720, unit: 'AUD/week' },
        { key: 'weekly_difference', label: 'Weekly difference', value: 30, unit: 'AUD/week' },
        { key: 'annual_difference', label: 'Annual difference', value: 1560, unit: 'AUD/year' },
        { key: 'difference_percent', label: 'Difference from historical asking rent', value: 4.17, unit: '%' },
      ],
      assumptions: ['The user confirmed the historical listing was weekly.', 'Period conversions use 52 weeks or 12 months per year; fees and future changes are excluded.'],
      warnings: ['The reference is a historical asking rent, not a current rental valuation or a signed lease.', 'Listing date: 2025-07-24'],
    } },
    { type: 'tool', id: 'compute', label: 'Calculating property comparison', status: 'done' },
    { type: 'delta', text: 'Fixture example with invented data: $750 per week is $30 above the historical asking rent of $720 [S1]. That is a 4.17% difference, or $1,560 over 52 weeks [C1].\n\nExpand the calculation to inspect the inputs and limitations.' },
    { type: 'done' },
  ];
  let timer;
  return new Response(new ReadableStream({ start(controller) {
    let index = 0;
    timer = setInterval(() => {
      if (signal.aborted) { clearInterval(timer); controller.close(); return; }
      controller.enqueue(new TextEncoder().encode(JSON.stringify(events[index++]) + '\n'));
      if (index === events.length) { clearInterval(timer); controller.close(); }
    }, 350);
  }, cancel() { clearInterval(timer); } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
};
