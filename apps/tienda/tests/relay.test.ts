import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearPago } from '../src/lib/relay.js';

beforeEach(() => {
  vi.stubEnv('MAILER_URL', 'https://relay.test/');
  vi.stubEnv('MAILER_API_KEY', 'clave-relay');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const CUERPO = { quote_id: 'q-1', quote_confirmed: true, origen: 'tienda' };

describe('crearPago', () => {
  it('postea el cuerpo a /api/pago/crear con la api key y devuelve status y data', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe('https://relay.test/api/pago/crear'); // sin barra doble
      expect(init?.method).toBe('POST');
      const h = init?.headers as Record<string, string>;
      expect(h['x-api-key']).toBe('clave-relay');
      expect(h['content-type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual(CUERPO);
      return new Response(JSON.stringify({ ok: true, estado: 'pendiente', init_point: 'https://mp/pagar' }), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    const r = await crearPago(CUERPO);
    expect(r).toEqual({ status: 200, data: { ok: true, estado: 'pendiente', init_point: 'https://mp/pagar' } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('un status no-2xx SE DEVUELVE (el caller decide); red caida => null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'sin_vigencia' }), { status: 409 })));
    const r = await crearPago(CUERPO);
    expect(r?.status).toBe(409);
    expect(r?.data.error).toBe('sin_vigencia');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect(await crearPago(CUERPO)).toBeNull();
  });

  it('cuerpo de respuesta ilegible => data vacia, no excepcion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no es json', { status: 502 })));
    expect(await crearPago(CUERPO)).toEqual({ status: 502, data: {} });
  });

  it('sin MAILER_URL o MAILER_API_KEY => null sin llamar a nadie', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    vi.stubEnv('MAILER_API_KEY', '');
    expect(await crearPago(CUERPO)).toBeNull();
    vi.stubEnv('MAILER_API_KEY', 'clave-relay');
    vi.stubEnv('MAILER_URL', '');
    expect(await crearPago(CUERPO)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('los logs nunca llevan la key ni el cuerpo', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await crearPago({ ...CUERPO, customer_name: 'Vicente Pareja' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    await crearPago(CUERPO);
    expect(log).toHaveBeenCalled();
    const todo = JSON.stringify(log.mock.calls);
    expect(todo).not.toContain('clave-relay');
    expect(todo).not.toContain('Vicente Pareja');
    expect(todo).not.toContain('q-1');
  });
});
