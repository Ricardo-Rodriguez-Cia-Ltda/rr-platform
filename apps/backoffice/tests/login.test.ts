import { describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/login/route.js';

function reqCon(password: string): Request {
  return new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
  });
}
const ENV = { BACKOFFICE_PASSWORD: 'clave-buena', BACKOFFICE_SESSION_SECRET: 'secreto' };

describe('POST /api/login', () => {
  it('con la clave buena setea cookie firmada y redirige a /', async () => {
    vi.stubEnv('BACKOFFICE_PASSWORD', ENV.BACKOFFICE_PASSWORD);
    vi.stubEnv('BACKOFFICE_SESSION_SECRET', ENV.BACKOFFICE_SESSION_SECRET);
    const res = await POST(reqCon('clave-buena'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('bo_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    vi.unstubAllEnvs();
  });
  it('con clave mala: sin cookie, redirect a /login?error=1, y demora >= 1s', async () => {
    vi.stubEnv('BACKOFFICE_PASSWORD', ENV.BACKOFFICE_PASSWORD);
    vi.stubEnv('BACKOFFICE_SESSION_SECRET', ENV.BACKOFFICE_SESSION_SECRET);
    const t0 = Date.now();
    const res = await POST(reqCon('clave-mala'));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/login?error=1');
    expect(res.headers.get('set-cookie')).toBeNull();
    vi.unstubAllEnvs();
  }, 10000);
  it('sin BACKOFFICE_PASSWORD configurada nadie entra', async () => {
    vi.stubEnv('BACKOFFICE_SESSION_SECRET', ENV.BACKOFFICE_SESSION_SECRET);
    const res = await POST(reqCon(''));
    expect(res.headers.get('set-cookie')).toBeNull();
    vi.unstubAllEnvs();
  }, 10000);
});
