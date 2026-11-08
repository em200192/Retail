import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { API_URL, SESSION_COOKIE } from '@/lib/server';

/**
 * Browser -> /api/proxy/v1/... -> API with the Bearer token from the
 * httpOnly session cookie. The token is never exposed to page JavaScript.
 */
async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'unauthorized', message: 'Please sign in' }, { status: 401 });
  const url = `${API_URL}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  // Only send a body (and its content-type) when there is one: the API rejects an empty JSON body (e.g. DELETE).
  const body = ['GET', 'HEAD'].includes(req.method) ? '' : await req.text();
  const hasBody = body.length > 0;
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers: { authorization: `Bearer ${token}`, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
      body: hasBody ? body : undefined,
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Counter cannot reach the server right now. Try again in a minute.' }, { status: 503 });
  }
  const out = new NextResponse(res.status === 204 ? null : await res.text(), { status: res.status });
  out.headers.set('content-type', res.headers.get('content-type') ?? 'application/json');
  if (res.status === 401) out.cookies.delete(SESSION_COOKIE);
  return out;
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
