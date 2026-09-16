import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createBarridoHandler, redactarAlertaAtascadas } from '../src/pago/barrido.js';
import { TOPE_BARRIDO } from '../src/pago/datos.js';
import { UMBRAL_FILA_ATASCADA_MS } from '../src/pago/webhook.js';

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave', CRON_SECRET: 'cron-secreto' };
const AHORA = Date.parse('2026-09-16T12:00:00Z');
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();

const ATASCADA = {
  quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4', numero: 1600009, estado: 'aprobado',
  aprobado_at: hace(25), mp_payment_id: '178359915879', monto_clp: 507052,
};
const SIN_MARCA = {
  quote_id: '11111111-2222-4333-8444-555555555555', numero: 1600010, estado: 'aprobado',
  aprobado_at: null, mp_payment_id: '1', monto_clp: 10000,
};

function makeRes() {
  const res = {
    statusCode: 0, jsonBody: undefined as any,
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.jsonBody = p; return res; },
    setHeader() { return res; }, send() { return res; }, end() { return res; },
  };
  return res as unknown as VercelResponse & typeof res;
}

// `null` = sin header Authorization. (No `undefined`: activaria el valor por
// defecto del parametro y mandaria el secreto valido.)
function makeReq(auth: string | null = `Bearer ${ENV.CRON_SECRET}`, method = 'GET'): VercelRequest {
  return { method, query: {}, headers: auth === null ? {} : { authorization: auth }, body: undefined } as unknown as VercelRequest;
}

function stubSupabase(filas: unknown[] | 'caido') {
  const spy = vi.fn(async (url: any) => {
    if (filas === 'caido') throw new Error('red caida');
    return new Response(JSON.stringify(filas), { status: 200, headers: { 'x-url': String(url) } });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function alertaFalsa() {
  const llamadas: Array<{ asunto: string; detalle: string }> = [];
  const alertar = async (asunto: string, detalle: string) => { llamadas.push({ asunto, detalle }); };
  return { alertar, llamadas };
}

afterEach(() => vi.unstubAllGlobals());

describe('redactarAlertaAtascadas', () => {
  it('lista cada fila con numero, cotizacion, pago, monto y antiguedad, y dice como callarla', () => {
    const { asunto, detalle } = redactarAlertaAtascadas([ATASCADA, SIN_MARCA] as any, AHORA);
    expect(asunto).toBe('2 pagos atascados en aprobado sin orden emitida');
    expect(detalle).toContain('Pedido 1600009');
    expect(detalle).toContain(ATASCADA.quote_id);
    expect(detalle).toContain('178359915879');
    expect(detalle).toContain('$507.052');
    expect(detalle).toContain('25 min');
    expect(detalle).toContain('Pedido 1600010');
    expect(detalle).toContain('sin marca de reclamacion');
    expect(detalle).toMatch(/emitido|aprobado_sin_emitir/);
    expect(detalle).toContain('30 minutos');
  });
  it('al tope, el asunto dice "al menos" y el detalle avisa que hay mas', () => {
    const filas = Array.from({ length: TOPE_BARRIDO }, (_, i) => ({ ...ATASCADA, numero: 1600100 + i }));
    const { asunto, detalle } = redactarAlertaAtascadas(filas as any, AHORA);
    expect(asunto).toBe(`Al menos ${TOPE_BARRIDO} pagos atascados en aprobado sin orden emitida`);
    expect(detalle).toContain('hay mas');
    expect(redactarAlertaAtascadas([ATASCADA, SIN_MARCA] as any, AHORA).detalle).not.toContain('hay mas');
  });
  it('un monto ilegible no rompe el correo', () => {
    expect(redactarAlertaAtascadas([{ ...ATASCADA, monto_clp: null }] as any, AHORA).detalle).toContain('monto desconocido');
  });
  it('en singular cuando es una sola', () => {
    expect(redactarAlertaAtascadas([ATASCADA] as any, AHORA).asunto).toBe('1 pago atascado en aprobado sin orden emitida');
  });
});

describe('GET /api/pago/barrido', () => {
  it('sin el secreto del cron responde 401 sin tocar nada', async () => {
    const spy = stubSupabase([ATASCADA]);
    const { alertar, llamadas } = alertaFalsa();
    for (const auth of [null, 'Bearer otro', 'cron-secreto']) {
      const res = makeRes();
      await createBarridoHandler(alertar, () => AHORA)(makeReq(auth), res, ENV);
      expect(res.statusCode).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(llamadas).toHaveLength(0);
  });

  it('sin CRON_SECRET configurado responde 503 nombrandolo (nunca queda abierto)', async () => {
    const spy = stubSupabase([ATASCADA]);
    const { alertar } = alertaFalsa();
    const res = makeRes();
    await createBarridoHandler(alertar, () => AHORA)(makeReq('Bearer '), res, { ...ENV, CRON_SECRET: '' });
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ ok: false, error: 'falta_configuracion', faltan: ['CRON_SECRET'] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('pregunta por aprobadas con mas de 10 minutos o sin marca, ordenadas por antiguedad', async () => {
    const spy = stubSupabase([]);
    const { alertar } = alertaFalsa();
    await createBarridoHandler(alertar, () => AHORA)(makeReq(), makeRes(), ENV);
    const url = decodeURIComponent(String(spy.mock.calls[0][0]));
    expect(url).toContain('/pagos?');
    expect(url).toContain('estado=eq.aprobado');
    expect(url).toContain(`aprobado_at.lt.${new Date(AHORA - UMBRAL_FILA_ATASCADA_MS).toISOString()}`);
    expect(url).toContain('aprobado_at.is.null');
    // Las filas sin marca son la anomalia mas grave: van primero para que
    // nunca sean las que queden fuera de la pagina.
    expect(url).toContain('order=aprobado_at.asc.nullsfirst');
    expect(url).toContain(`limit=${TOPE_BARRIDO}`);
  });

  it('sin filas: 200, cero atascadas y ningun correo', async () => {
    stubSupabase([]);
    const { alertar, llamadas } = alertaFalsa();
    const res = makeRes();
    await createBarridoHandler(alertar, () => AHORA)(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, atascadas: 0 });
    expect(llamadas).toHaveLength(0);
  });

  it('con filas: 200, un solo correo con todas, y las cotizaciones en la respuesta', async () => {
    stubSupabase([ATASCADA, SIN_MARCA]);
    const { alertar, llamadas } = alertaFalsa();
    const res = makeRes();
    await createBarridoHandler(alertar, () => AHORA)(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, atascadas: 2, cotizaciones: [ATASCADA.quote_id, SIN_MARCA.quote_id] });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].asunto).toBe('2 pagos atascados en aprobado sin orden emitida');
    expect(llamadas[0].detalle).toContain('Pedido 1600009');
    expect(llamadas[0].detalle).toContain('Pedido 1600010');
  });

  it('Supabase caido: 503 y alerta interna (un barrido mudo es el mismo hueco)', async () => {
    stubSupabase('caido');
    const { alertar, llamadas } = alertaFalsa();
    const res = makeRes();
    await createBarridoHandler(alertar, () => AHORA)(makeReq(), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ ok: false, error: 'upstream' });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].asunto).toContain('barrido');
  });

  it('metodo distinto de GET: 405', async () => {
    stubSupabase([]);
    const { alertar } = alertaFalsa();
    const res = makeRes();
    await createBarridoHandler(alertar, () => AHORA)(makeReq(null, 'POST'), res, ENV);
    expect(res.statusCode).toBe(405);
  });
});

describe('el cron de vercel.json', () => {
  it('apunta al barrido y corre cada 30 minutos', () => {
    const config = JSON.parse(readFileSync('apps/mailer/vercel.json', 'utf8'));
    expect(config.crons).toEqual([{ path: '/api/pago/barrido', schedule: '*/30 * * * *' }]);
  });
});
