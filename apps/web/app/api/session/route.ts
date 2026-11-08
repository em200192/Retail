import { NextResponse } from 'next/server';
import { API_URL, cookieOptions, SESSION_COOKIE } from '@/lib/server';

/** POST { action: 'login' | 'signup', ...body } -> sets the session cookie. DELETE = sign out. */
export async function POST(req: Request) {
  const { action, ...body } = await req.json();
  const path = action === 'signup' ? '/v1/auth/signup' : '/v1/auth/login';
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Counter cannot reach the server right now. Try again in a minute.' }, { status: 503 });
  }
  const data = await res.json().catch(() => ({ message: 'The server could not be reached' }));
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  if (data.requires_tenant_selection) return NextResponse.json(data);
  const out = NextResponse.json({ ok: true, tenant_id: data.tenant_id });
  out.cookies.set(SESSION_COOKIE, data.token, cookieOptions);
  return out;
}

export async function DELETE() {
  const out = NextResponse.json({ ok: true });
  out.cookies.delete(SESSION_COOKIE);
  return out;
}
