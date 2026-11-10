// Browser-only fixture. Invented data and dummy credentials; never calls a service.
const origin = 'https://chat.example.test';
globalThis.CHAT_API_CONFIG = { baseUrl: origin, token: location.search.includes('unavailable') ? '' : 'dummy-preview-token' };
globalThis.chrome = { runtime: { getURL: path => '../../extension/' + path, getManifest: () => ({ host_permissions: [origin + '/*'], content_security_policy: { extension_pages: 'connect-src ' + origin } }) },
  storage: { local: {
    get: async key => ({ [key]: JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? undefined }),
    set: async items => { for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, JSON.stringify(value)); },
    remove: async key => { sessionStorage.removeItem(key); },
  } } };
globalThis.fetch = async (_url, { signal, body }) => {
  if (String(_url).endsWith('/api/rental')) {
    const command=JSON.parse(body).command;
    if (command.operation==='end') return Response.json({ended:true});
    return Response.json({revision:2,result:{action:'recommend',reason_code:'fixture',recommendations:[
      {listing_id:'GANSWFIXTURE',role:'best',label:'Best overall',score:1,score_gap:0,reason:'Invented example. Advertised $700/week, 7% below the benchmark.',price_check:false,address:'1 Example Street',district:'Example suburb',weeklyRent:700,fairRent:750,stationWalkM:400,stationWalkBand:[350,500],supermarketWalkMin:4,unknownFeatures:['pets','gym']},
      {listing_id:'GANSWFIXTURE2',role:'cheapest',label:'Lower rent',score:4,score_gap:3,reason:'Invented example. Advertised $560/week, 41% below the benchmark.',price_check:true,address:'Unit 12, 80 Sample Road',district:'Example suburb',weeklyRent:560,fairRent:950,stationWalkM:1100,stationWalkBand:[950,1340],supermarketWalkMin:9,unknownFeatures:['pets','furnished']},
      {listing_id:'GANSWFIXTURE3',role:'closest_station',label:'Closer to a station',score:6,score_gap:5,reason:'Invented example. Advertised $760/week, 4% above the benchmark.',price_check:false,address:'5/22 Placeholder Lane',district:'Sample Hills',weeklyRent:760,fairRent:730,stationWalkM:180,stationWalkBand:[160,250],supermarketWalkMin:null,unknownFeatures:[]}],followup:'Tell me any other requirements and I will update the search.',provenance:{snapshotDate:'2026-11-07T01:10:58Z',artifactVersion:'a'.repeat(64),modelVersion:'fixture-v1',advisorVersion:'1.0.0'},warnings:['Invented data. Check availability.','Walking distances are estimates.']}});
  }
  let events = [
    { type: 'tool', id: 'lookup', label: 'Searching addresses', status: 'running' },
    { type: 'tool', id: 'lookup', label: 'Searching addresses', status: 'done' },
    { type: 'source', source: { id: 'S1', label: 'Example property · basics', path: '/v1/properties/GANSW1/basics/all' } },
    { type: 'delta', text: 'This is a fixture answer, using invented property data.\n\n' },
    { type: 'delta', text: 'The example has two bedrooms and one bathroom [S1]. Ask about schools, planning or transport for more context.' },
    { type: 'done' },
  ];
  if (location.search.includes('rental')) events = [
    {type:'rental_result',rental:{revision:1,result:{action:'ask',reason_code:'fixture',question_id:'q-001',question_key:'needs.pets',question_text:'Do you need a pet-friendly home?',
      options:[{id:'yes',label:'Yes, I have pets'},{id:'no',label:'No pets'},{id:'skip',label:'Skip for now'}],
      provenance:{snapshotDate:'2026-11-07T01:10:58Z',artifactVersion:'a'.repeat(64),modelVersion:'fixture-v1',advisorVersion:'1.0.0'},warnings:['Invented data. Availability must be checked.']}}},
    {type:'delta',text:'This invented rental example asks one preference question.'},{type:'done'},
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
