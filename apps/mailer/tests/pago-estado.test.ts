import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createEstadoHandler, proyectarEstado } from '../src/pago/estado.js';
import type { PagoRow } from '../src/pago/datos.js';

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave' };
const QUOTE = 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4';
const AHORA = Date.parse('2026-09-16T12:00:00Z');
const enHoras = (h: number) => new Date(AHORA + h * 3600_000).toISOString();

function fila(extra: Partial<PagoRow> = {}): PagoRow {
  return {
    quote_id: QUOTE, quote_version: '1', numero: 1600006, telefono: '56941757584',
    phone_number_id: null, preference_id: 'pref-1', init_point: 'https://mp/pagar',
    monto_clp: 1058793, expira_at: enHoras(3), estado: 'pendiente', mp_payment_id: null,
    intentos_rechazados: 0, datos: { origen: 'tienda', billing_email: 'comprador@a.cl' },
    ...extra,
  };
}

function makeRes() {
  const res = {
    statusCode: 0, jsonBody: undefined as any, headers: {} as Record<string, string>,
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.jsonBody = p; return res; },
    setHeader(k: string, v: string) { res.headers[k.toLowerCase()] = v; return res; },
    send() { return res; }, end() { return res; },
  };
  return res as unknown as VercelResponse & typeof res;
}

function makeReq(id: unknown, method = 'GET'): VercelRequest {
  return { method, query: { id }, headers: {}, body: undefined } as unknown as VercelRequest;
}

function stubSupabase(filas: unknown[] | 'caido') {
  const spy = vi.fn(async () => {
    if (filas === 'caido') throw new Error('red caida');
    return new Response(JSON.stringify(filas), { status: 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('proyectarEstado', () => {
  it('pendiente y vigente: lleva init_point', () => {
    const p = proyectarEstado(fila(), AHORA);
    expect(p).toEqual({
      estado: 'pendiente', monto_clp: 1058793, intentos_rechazados: 0,
      expira_at: enHoras(3), init_point: 'https://mp/pagar',
    });
  });

  it('pendiente con menos de 15 minutos de vigencia: sin init_point (el link ya murio)', () => {
    const p = proyectarEstado(fila({ expira_at: new Date(AHORA + 10 * 60_000).toISOString() }), AHORA);
    expect(p.estado).toBe('pendiente');
    expect(p.init_point).toBeUndefined();
  });

  it.each(['aprobado', 'emitido', 'aprobado_sin_emitir'] as const)('%s: sin init_point aunque haya vigencia', (estado) => {
    expect(proyectarEstado(fila({ estado }), AHORA).init_point).toBeUndefined();
  });

  it('es una lista blanca: nunca viajan telefono, datos, preference_id ni mp_payment_id', () => {
    const p = proyectarEstado(fila({ mp_payment_id: '179145675492', estado: 'emitido' }), AHORA) as unknown as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(['estado', 'expira_at', 'intentos_rechazados', 'monto_clp']);
  });

  it('intentos_rechazados ausente en la fila se lee como 0', () => {
    expect(proyectarEstado(fila({ intentos_rechazados: undefined }), AHORA).intentos_rechazados).toBe(0);
  });
});

describe('GET /api/pago/estado/{id}', () => {
  it('fila existente: 200 con la proyeccion y no-store', async () => {
    stubSupabase([fila({ intentos_rechazados: 1 })]);
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      ok: true, estado: 'pendiente', monto_clp: 1058793, intentos_rechazados: 1,
      expira_at: enHoras(3), init_point: 'https://mp/pagar',
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('id mal formado: 404 sin tocar Supabase', async () => {
    const spy = stubSupabase([fila()]);
    for (const id of ['abc', '', undefined, `${QUOTE}'--`, [QUOTE, QUOTE]]) {
      const res = makeRes();
      await createEstadoHandler(() => AHORA)(makeReq(id), res, ENV);
      // Un array con un UUID valido en [0] SI pasa (firstString): solo los otros son 404.
      if (Array.isArray(id)) { expect(res.statusCode).toBe(200); continue; }
      expect(res.statusCode).toBe(404);
      expect(res.jsonBody).toEqual({ ok: false, error: 'no_encontrado' });
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fila inexistente: 404 con el mismo cuerpo que un id mal formado', async () => {
    stubSupabase([]);
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE), res, ENV);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ ok: false, error: 'no_encontrado' });
  });

  it('Supabase caido: 503 upstream', async () => {
    stubSupabase('caido');
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ ok: false, error: 'upstream' });
  });

  it('falta configuracion: 503 nombrando las variables', async () => {
    stubSupabase([fila()]);
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE), res, { SUPABASE_URL: 'https://supabase.test' });
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ ok: false, error: 'falta_configuracion', faltan: ['SUPABASE_SERVICE_KEY'] });
  });

  it('metodo distinto de GET: 405', async () => {
    stubSupabase([fila()]);
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE, 'POST'), res, ENV);
    expect(res.statusCode).toBe(405);
  });
});
