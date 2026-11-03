import { type NextRequest, NextResponse } from 'next/server';

const PUBLIC = ['/login', '/signup'];

export function middleware(req: NextRequest) {
  const signedIn = req.cookies.has('counter_session');
  const isPublic = PUBLIC.some((p) => req.nextUrl.pathname.startsWith(p));
  if (!signedIn && !isPublic) {
    const url = new URL('/login', req.url);
    if (req.nextUrl.pathname !== '/') url.searchParams.set('next', req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  if (signedIn && isPublic) return NextResponse.redirect(new URL('/', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next|favicon.ico|.*\\.(?:svg|png|ico)$).*)'] };
