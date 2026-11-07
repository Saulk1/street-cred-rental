// Browser-only fixture. Invented data and dummy credentials; never calls a service.
const origin = 'https://chat.example.test';
globalThis.CHAT_API_CONFIG = { baseUrl: origin, token: location.search.includes('unavailable') ? '' : 'dummy-preview-token' };
globalThis.chrome = { runtime: { getManifest: () => ({ host_permissions: [origin + '/*'], content_security_policy: { extension_pages: 'connect-src ' + origin } }) },
  storage: { local: {
    get: async key => ({ [key]: JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? undefined }),
    set: async items => { for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, JSON.stringify(value)); },
    remove: async key => { sessionStorage.removeItem(key); },
  } } };
globalThis.fetch = async (_url, { signal }) => {
  const events = [
    { type: 'tool', id: 'lookup', label: 'Searching addresses', status: 'running' },
    { type: 'tool', id: 'lookup', label: 'Searching addresses', status: 'done' },
    { type: 'source', source: { id: 'S1', label: 'Example property · basics', path: '/v1/properties/GANSW1/basics/all' } },
    { type: 'delta', text: 'This is a fixture answer, using invented property data.\n\n' },
    { type: 'delta', text: 'The example has two bedrooms and one bathroom [S1]. Ask about schools, planning or transport for more context.' },
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
