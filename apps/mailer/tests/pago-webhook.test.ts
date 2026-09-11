import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { construirManifiesto } from '../src/pago/firma.js';
import { _limpiarCacheKapso } from '../src/pago/kapso.js';
import { createWebhookHandler } from '../src/pago/webhook.js';

const SECRET = 'secreto';
const QUOTE = 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4';
const PAYMENT_ID = '123456789';
const REQUEST_ID = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';

const ENV = {
  SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave',
  MP_ACCESS_TOKEN: 'token-mp', MP_WEBHOOK_SECRET: SECRET, KAPSO_API_KEY: 'kapso-key',
};

const PAGO = {
  quote_id: QUOTE, quote_version: '1', telefono: '56941757584', phone_number_id: 'PNID',
  monto_clp: 219725, estado: 'pendiente', intentos_rechazados: 0,
  datos: { quote_customer_name: 'Acme SpA', billing_rut: '76.123.456-7' },
};

const COTIZACION = {
  quote_id: QUOTE, version: '1', total_clp: 219725,
  valida_hasta: new Date(Date.now() + 3600_000).toISOString(),
  lineas: [{ proveedor: 'intcomex', cantidad: 1, precio_unitario_usd: 10, subtotal_neto_clp: 184643 }],
  proveedores_incompletos: [],
};

function firmarHeader(dataId = PAYMENT_ID, secret = SECRET) {
  const ts = '1742505638683';
  const v1 = createHmac('sha256', secret).update(construirManifiesto(dataId, REQUEST_ID, ts)).digest('hex');
  return `ts=${ts},v1=${v1}`;
}

function makeRes() {
  const res = {
    statusCode: 0, jsonBody: undefined as any,
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.jsonBody = p; return res; },
    setHeader() { return res; }, send() { return res; }, end() { return res; },
  };
  return res as unknown as VercelResponse & typeof res;
}

function makeReq(over: Partial<{ header: string; dataId: string; body: unknown; query: any }> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: { 'x-signature': over.header ?? firmarHeader(), 'x-request-id': REQUEST_ID },
    query: over.query ?? { type: 'payment', 'data.id': over.dataId ?? PAYMENT_ID },
    body: over.body ?? { type: 'payment', action: 'payment.updated', data: { id: over.dataId ?? PAYMENT_ID } },
  } as unknown as VercelRequest;
}

/** Guion completo: supabase + mercadopago + kapso. */
function routeFetch(h: {
  pago?: unknown[]; cotizacion?: unknown[];
  mpPago?: unknown; mpStatus?: number;
  reclamo?: unknown[];
  emitir?: { status: number; body: unknown };
  escrituras?: Array<{ url: string; body: any }>;
  mensajes?: string[];
} = {}) {
  const spy = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    const metodo = init?.method ?? 'GET';

    if (href.includes('supabase.test')) {
      if (metodo === 'PATCH' || metodo === 'POST') {
        h.escrituras?.push({ url: href, body: JSON.parse(String(init?.body ?? '{}')) });
        if (href.includes('estado=eq.pendiente')) {
          return new Response(JSON.stringify(h.reclamo ?? [{ quote_id: QUOTE }]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }
      if (href.includes('/cotizaciones')) return new Response(JSON.stringify(h.cotizacion ?? [COTIZACION]), { status: 200 });
      return new Response(JSON.stringify(h.pago ?? [PAGO]), { status: 200 });
    }

    if (href.includes('api.mercadopago.com')) {
      return new Response(JSON.stringify(h.mpPago ?? {
        id: PAYMENT_ID, status: 'approved', external_reference: QUOTE, transaction_amount: 219725,
      }), { status: h.mpStatus ?? 200 });
    }

    if (href.endsWith('/functions')) {
      return new Response(JSON.stringify({ data: [{ id: 'id-emitir', name: 'emitir-ordenes-compra' }] }), { status: 200 });
    }
    if (href.includes('/invoke')) {
      const e = h.emitir ?? { status: 200, body: { ok: true, vars: { purchase_orders_ok: true } } };
      return new Response(JSON.stringify(e.body), { status: e.status });
    }
    if (href.includes('/meta/whatsapp/')) {
      h.mensajes?.push(JSON.parse(String(init?.body)).text?.body ?? '');
      return new Response('{}', { status: 200 });
    }
    throw new Error(`llamada inesperada: ${href}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => _limpiarCacheKapso());
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/pago/webhook', () => {
  it('pago aprobado: emite, marca pedidos pagados y avisa al cliente', async () => {
    const escrituras: any[] = [];
    const mensajes: string[] = [];
    const spy = routeFetch({ escrituras, mensajes });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);

    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(true);
    expect(escrituras.some((e) => e.body.estado === 'emitido')).toBe(true);
    expect(escrituras.some((e) => e.url.includes('/pedidos') && e.body.estado_negocio === 'pagado')).toBe(true);
    expect(mensajes[0]).toContain('cursado');
  });

  it('firma invalida: 401 y no se toca nada', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createWebhookHandler()(makeReq({ header: firmarHeader(PAYMENT_ID, 'otro-secreto') }), res, ENV);
    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('la segunda entrega del mismo webhook no emite de nuevo', async () => {
    const spy = routeFetch({ reclamo: [] }); // el PATCH condicional devuelve cero filas
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
  });

  it('monto distinto al cobrado: no emite, marca aprobado_sin_emitir y alerta', async () => {
    const escrituras: any[] = [];
    const alertas: string[] = [];
    const spy = routeFetch({
      escrituras,
      mpPago: { id: PAYMENT_ID, status: 'approved', external_reference: QUOTE, transaction_amount: 1000 },
    });
    const res = makeRes();
    await createWebhookHandler(async (asunto) => { alertas.push(asunto); })(makeReq(), res, ENV);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
    expect(escrituras.some((e) => e.body.estado === 'aprobado_sin_emitir')).toBe(true);
    expect(alertas).toHaveLength(1);
  });

  it('external_reference que no calza: no emite', async () => {
    const spy = routeFetch({
      mpPago: { id: PAYMENT_ID, status: 'approved', external_reference: 'otra-cotizacion', transaction_amount: 219725 },
    });
    const res = makeRes();
    await createWebhookHandler(async () => {})(makeReq(), res, ENV);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
  });

  it('emitir caido: aprobado_sin_emitir, alerta interna y mensaje que no promete', async () => {
    const escrituras: any[] = [];
    const mensajes: string[] = [];
    const alertas: string[] = [];
    routeFetch({ escrituras, mensajes, emitir: { status: 500, body: {} } });
    const res = makeRes();
    await createWebhookHandler(async (a) => { alertas.push(a); })(makeReq(), res, ENV);
    expect(escrituras.some((e) => e.body.estado === 'aprobado_sin_emitir')).toBe(true);
    expect(alertas).toHaveLength(1);
    expect(mensajes[0]).not.toContain('cursado');
  });

  it('emitir con ok false (cotizacion expirada) tampoco se da por bueno', async () => {
    const escrituras: any[] = [];
    routeFetch({ escrituras, emitir: { status: 409, body: { ok: false, error: 'La cotización expiró' } } });
    const res = makeRes();
    await createWebhookHandler(async () => {})(makeReq(), res, ENV);
    expect(escrituras.some((e) => e.body.estado === 'aprobado_sin_emitir')).toBe(true);
  });

  it('emision ok con alguna OC en failed igual cuenta como emitido', async () => {
    // El contrato honesto que ya rige hoy: la OC fallida se ve en el
    // backoffice, pero el pago SI se emitio y el cliente no queda en el limbo.
    const escrituras: any[] = [];
    routeFetch({
      escrituras,
      emitir: { status: 200, body: { ok: true, vars: { purchase_orders_ok: false } } },
    });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(escrituras.some((e) => e.body.estado === 'emitido')).toBe(true);
    expect(escrituras.some((e) => e.body.estado === 'aprobado_sin_emitir')).toBe(false);
  });

  it('pago rechazado: la fila sigue pendiente y solo sube el contador', async () => {
    const escrituras: any[] = [];
    const mensajes: string[] = [];
    routeFetch({
      escrituras, mensajes,
      mpPago: { id: PAYMENT_ID, status: 'rejected', external_reference: QUOTE, transaction_amount: 219725 },
    });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(escrituras.every((e) => e.body.estado === undefined)).toBe(true);
    expect(escrituras.some((e) => e.body.intentos_rechazados === 1)).toBe(true);
    expect(mensajes[0]).toContain('rechazado');
  });

  it('pago aun pending: 200 y nada se escribe', async () => {
    const escrituras: any[] = [];
    routeFetch({
      escrituras,
      mpPago: { id: PAYMENT_ID, status: 'pending', external_reference: QUOTE, transaction_amount: 219725 },
    });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(escrituras).toHaveLength(0);
  });

  it('notificacion que no es de pago se ignora con 200', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createWebhookHandler()(makeReq({ query: { type: 'plan', 'data.id': PAYMENT_ID } }), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('sin fila de pagos: 200 y no se emite (no es nuestro)', async () => {
    const spy = routeFetch({ pago: [] });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
  });

  it('Mercado Pago no responde la consulta: 500 para que reintente', async () => {
    routeFetch({ mpStatus: 500 });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(500);
  });
});
