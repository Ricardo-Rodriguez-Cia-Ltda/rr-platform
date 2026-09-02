import { NextRequest, NextResponse } from 'next/server';
import { tokenValido, COOKIE_NOMBRE } from './src/lib/session.js';

export async function middleware(req: NextRequest): Promise<NextResponse | Response> {
  const { pathname } = req.nextUrl;
  if (pathname === '/login' || pathname === '/api/login' || pathname === '/api/logout') return NextResponse.next();
  const token = req.cookies.get(COOKIE_NOMBRE)?.value;
  const ok = await tokenValido(token, process.env.BACKOFFICE_SESSION_SECRET ?? '', Date.now());
  if (ok) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'no_autorizado' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
