import { checkDatabase } from './db/index.js';

export async function health(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, {
      status: 405,
      headers: { ...headers, Allow: 'GET' },
    });
  }

  try {
    await checkDatabase();
    return Response.json({ status: 'ok' }, { headers });
  } catch {
    // Driver errors can contain credentials, SQL and connection details.
    return Response.json({ status: 'unavailable' }, { status: 503, headers });
  }
}
