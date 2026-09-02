import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/pedidos/transicion/route.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function conEnv() {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
}
function req(body: unknown): Request {
  return new Request('http://localhost/api/pedidos/transicion', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
// GET de grupo -> filas con estado dado; captura los PATCH.
function stubSupabase(estadoActual: string | null, patches: Array<{ url: string; body: any }> = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches.push({ url: String(url), body: JSON.parse(String(init.body)) });
      // Devuelve filas afectadas con return=representation (200 con cuerpo)
      return new Response(JSON.stringify([{ estado_negocio: 'dummy' }]), { status: 200 });
    }
    const filas = estadoActual === null ? [] : [{ estado_negocio: estadoActual }];
    return new Response(JSON.stringify(filas), { status: 200 });
  }));
  return patches;
}

describe('POST /api/pedidos/transicion', () => {
  it('nuevo -> pagado: PATCH al grupo completo con pagado_at y condicion de estado', async () => {
    conEnv();
    const patches = stubSupabase('nuevo');
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'pagado' }));
    expect(res.status).toBe(200);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain('quote_id=eq.q-1');
    expect(patches[0].url).toContain('quote_version=eq.1');
    expect(patches[0].url).toContain('estado_negocio=eq.nuevo');
    expect(patches[0].body.estado_negocio).toBe('pagado');
    expect(typeof patches[0].body.pagado_at).toBe('string');
  });
  it('pagado -> entregado estampa entregado_at', async () => {
    conEnv();
    const patches = stubSupabase('pagado');
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'entregado' }));
    expect(res.status).toBe(200);
    expect(typeof patches[0].body.entregado_at).toBe('string');
  });
  it('idempotente: pagado -> pagado responde ok SIN escribir', async () => {
    conEnv();
    const patches = stubSupabase('pagado');
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'pagado' }));
    expect(res.status).toBe(200);
    expect(patches).toHaveLength(0);
  });
  it('transicion ilegal -> 409 con el estado actual', async () => {
    conEnv();
    stubSupabase('nuevo');
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'entregado' }));
    expect(res.status).toBe(409);
    expect((await res.json()).desde).toBe('nuevo');
  });
  it('PATCH condicional devuelve [] (carrera): otro request cambio el estado -> 409', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        // Simula que el PATCH condicional no encontró filas con estado_negocio=eq.nuevo
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify([{ estado_negocio: 'nuevo' }]), { status: 200 });
    }));
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'pagado' }));
    expect(res.status).toBe(409);
    expect((await res.json()).desde).toBe('nuevo');
  });
  it('grupo inexistente -> 404; cuerpo invalido -> 400; supabase caido -> 503', async () => {
    conEnv();
    stubSupabase(null);
    expect((await POST(req({ quote_id: 'q-x', quote_version: '1', hacia: 'pagado' }))).status).toBe(404);
    expect((await POST(req({ hacia: 'volado' }))).status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect((await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'pagado' }))).status).toBe(503);
  });
});
