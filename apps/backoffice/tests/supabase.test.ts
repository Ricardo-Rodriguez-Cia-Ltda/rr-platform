import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabaseGet, supabasePatch, supabasePost, supabaseRpc } from '../src/lib/supabase.js';

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
  it('PATCH con Prefer return=representation; devuelve filas en 2xx, null en error', async () => {
    conEnv();
    const spy = vi.fn(async () => new Response(JSON.stringify([{ estado_negocio: 'pagado' }]), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const filas = await supabasePatch('/pedidos?quote_id=eq.q', { estado_negocio: 'pagado' });
    expect(filas).toEqual([{ estado_negocio: 'pagado' }]);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=representation');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 400 })));
    expect(await supabasePatch('/pedidos?quote_id=eq.q', {})).toBeNull();
  });
});

describe('supabasePost y supabaseRpc', () => {
  it('POST inserta con return=representation y devuelve las filas', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    const f = vi.fn(async () => new Response(JSON.stringify([{ id: 1 }]), { status: 201 }));
    vi.stubGlobal('fetch', f);
    expect(await supabasePost('/recepciones', { po_id: 'oc-1' })).toEqual([{ id: 1 }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://supabase.test/rest/v1/recepciones');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=representation');
    expect(JSON.parse(String(init.body))).toEqual({ po_id: 'oc-1' });
  });

  it('RPC llama /rpc/<fn> y devuelve el cuerpo tal cual', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 7 }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await supabaseRpc('crear_despacho', { p_lineas: [] })).toEqual({ id: 7 });
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe('https://supabase.test/rest/v1/rpc/crear_despacho');
  });

  it('status no 2xx, red caida o sin config devuelven null', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    expect(await supabasePost('/x', {})).toBeNull();
    expect(await supabaseRpc('f', {})).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await supabasePost('/x', {})).toBeNull();
    vi.unstubAllEnvs();
    expect(await supabaseRpc('f', {})).toBeNull();
  });
});
