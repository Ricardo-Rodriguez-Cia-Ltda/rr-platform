import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabaseGet, supabasePatch } from '../src/lib/supabase.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function conEnv() {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test/');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
}

describe('supabaseGet', () => {
  it('arma la URL sin doble slash y manda las dos cabeceras de auth', async () => {
    conEnv();
    const spy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await supabaseGet('/pedidos?limit=1');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://supabase.test/rest/v1/pedidos?limit=1');
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe('clave');
    expect(headers.Authorization).toBe('Bearer clave');
  });
  it('sin env devuelve null sin llamar fetch', async () => {
    const spy = vi.fn(); vi.stubGlobal('fetch', spy);
    expect(await supabaseGet('/pedidos')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it('status no-2xx o red caida devuelven null', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    expect(await supabaseGet('/pedidos')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await supabaseGet('/pedidos')).toBeNull();
  });
});

describe('supabasePatch', () => {
  it('PATCH con Prefer minimal; true en 2xx, false en error', async () => {
    conEnv();
    const spy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', spy);
    expect(await supabasePatch('/pedidos?quote_id=eq.q', { estado_negocio: 'pagado' })).toBe(true);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=minimal');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 400 })));
    expect(await supabasePatch('/pedidos?quote_id=eq.q', {})).toBe(false);
  });
});
