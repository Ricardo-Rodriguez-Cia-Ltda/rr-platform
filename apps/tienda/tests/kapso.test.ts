import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invocarFunction, _limpiarCacheKapso } from '../src/lib/kapso.js';

beforeEach(() => { _limpiarCacheKapso(); vi.stubEnv('KAPSO_API_KEY', 'kapso-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const FUNCTIONS = { data: [{ id: 'id-generar', name: 'generar-cotizacion-v2' }, { id: 'id-emitir', name: 'emitir-ordenes-compra' }] };

describe('invocarFunction', () => {
  it('resuelve el id por nombre, cachea el listado y postea el payload', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('/functions')) return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
      expect(String(url)).toContain('/functions/id-generar/invoke');
      expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('kapso-key');
      expect(JSON.parse(String(init?.body)).execution_context.vars.cart_items[0].sku).toBe('A');
      return new Response(JSON.stringify({ estado: 'ok' }), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    const payload = { execution_context: { vars: { cart_items: [{ sku: 'A', mpn: null, marca: null, cantidad: 1 }] }, context: {} } };
    const r1 = await invocarFunction('generar-cotizacion-v2', payload);
    const r2 = await invocarFunction('generar-cotizacion-v2', payload);
    expect(r1?.status).toBe(200);
    expect((r1?.data as any).estado).toBe('ok');
    // 1 listado + 2 invokes = 3 fetches (el listado se cacheo)
    expect(spy).toHaveBeenCalledTimes(3);
    expect(r2?.status).toBe(200);
  });
  it('un status no-2xx del invoke SE DEVUELVE (el caller decide), red caida => null', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) =>
      String(url).endsWith('/functions')
        ? new Response(JSON.stringify(FUNCTIONS), { status: 200 })
        : new Response(JSON.stringify({ estado: 'error', mensaje: 'carro invalido' }), { status: 400 })));
    const r = await invocarFunction('generar-cotizacion-v2', {});
    expect(r?.status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    _limpiarCacheKapso();
    expect(await invocarFunction('generar-cotizacion-v2', {})).toBeNull();
  });
  it('function inexistente o sin api key => null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FUNCTIONS), { status: 200 })));
    expect(await invocarFunction('no-existe', {})).toBeNull();
    vi.unstubAllEnvs();
    expect(await invocarFunction('generar-cotizacion-v2', {})).toBeNull();
  });
  it('404 en invoke => borra cache, re-resuelve id, reintenta una sola vez y devuelve 200', async () => {
    let callCount = 0;
    const spy = vi.fn(async (url: any) => {
      callCount++;
      if (String(url).endsWith('/functions')) {
        // Primer listado devuelve id viejo, segundo devuelve id nuevo
        return new Response(JSON.stringify(callCount === 1
          ? { data: [{ id: 'id-generar-viejo', name: 'generar-cotizacion-v2' }] }
          : { data: [{ id: 'id-generar-nuevo', name: 'generar-cotizacion-v2' }] }
        ), { status: 200 });
      }
      // Primer invoke (con id viejo) => 404
      if (callCount === 2) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      // Segundo invoke (con id nuevo) => 200
      return new Response(JSON.stringify({ estado: 'ok' }), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    const r = await invocarFunction('generar-cotizacion-v2', { test: 'data' });
    expect(r?.status).toBe(200);
    // 1 listado inicial + 1 invoke 404 + 1 listado re-resuelve + 1 invoke retry = 4 fetches
    expect(spy).toHaveBeenCalledTimes(4);
  });
  it('404 siempre => devuelve status 404 sin bucle infinito', async () => {
    let callCount = 0;
    const spy = vi.fn(async (url: any) => {
      callCount++;
      if (String(url).endsWith('/functions')) {
        return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    });
    vi.stubGlobal('fetch', spy);
    const r = await invocarFunction('generar-cotizacion-v2', {});
    expect(r?.status).toBe(404);
    // 1 listado + 1 invoke 404 + 1 listado re-resuelve + 1 invoke retry 404 = 4 fetches, NO más
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
