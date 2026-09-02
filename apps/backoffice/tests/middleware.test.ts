import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware.js';
import { crearToken, COOKIE_NOMBRE } from '../src/lib/session.js';

const SECRET = 'secreto-de-prueba';

describe('middleware', () => {
  it('request a /api/* sin cookie -> 401 con {error: "no_autorizado"}', async () => {
    const req = new NextRequest('http://localhost/api/pedidos/transicion', { method: 'POST' });
    const res = await middleware(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'no_autorizado' });
  });

  it('request a una pagina sin cookie -> redirect a /login', async () => {
    const req = new NextRequest('http://localhost/', { method: 'GET' });
    const res = await middleware(req);
    expect([302, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('request a /api/pedidos/transicion con cookie valida -> deja pasar', async () => {
    vi.stubEnv('BACKOFFICE_SESSION_SECRET', SECRET);
    const token = await crearToken(SECRET, Date.now());
    const req = new NextRequest('http://localhost/api/pedidos/transicion', {
      method: 'POST',
      headers: { cookie: `${COOKIE_NOMBRE}=${token}` },
    });
    const res = await middleware(req);
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.status).toBe(200);
    vi.unstubAllEnvs();
  });

  it('/login y /api/logout sin cookie -> pasan', async () => {
    const reqLogin = new NextRequest('http://localhost/login', { method: 'GET' });
    const resLogin = await middleware(reqLogin);
    expect(resLogin.headers.get('x-middleware-next')).toBe('1');

    const reqLogout = new NextRequest('http://localhost/api/logout', { method: 'POST' });
    const resLogout = await middleware(reqLogout);
    expect(resLogout.headers.get('x-middleware-next')).toBe('1');
  });
});
