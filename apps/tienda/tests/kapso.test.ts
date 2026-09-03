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
});
