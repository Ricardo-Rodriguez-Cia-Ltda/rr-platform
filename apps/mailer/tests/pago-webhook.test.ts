import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { construirManifiesto } from '../src/pago/firma.js';
import { _limpiarCacheKapso } from '../src/pago/kapso.js';
import { VENTANA_ALERTAS_MS, _limpiarVentanaAlertas, createWebhookHandler } from '../src/pago/webhook.js';

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

// El filtro real: Supabase solo devuelve las filas cuyo quote_id calza con
// `quote_id=eq.<valor>` en la URL. Sin esto, el simulacro dejaba pasar
// cualquier fila configurada sin mirar por cual quote_id se estaba
// preguntando -- infiel a la realidad, y ciego a cualquier caso donde el
// handler consulte la cotizacion equivocada.
function quoteIdDeUrl(href: string): string | null {
  const m = href.match(/quote_id=eq\.([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function filtrarPorQuoteId(href: string, filas: unknown[]): unknown[] {
  const q = quoteIdDeUrl(href);
  if (q === null) return filas;
  return filas.filter((f) => String((f as { quote_id?: unknown })?.quote_id) === q);
}

/** Guion completo: supabase + mercadopago + kapso. */
function routeFetch(h: {
  pago?: unknown[]; cotizacion?: unknown[];
  // Bypasea el filtro por quote_id de la URL: simula que Supabase devolviera
  // una fila que no corresponde (algo que la base no deberia producir), para
  // poder probar la salvaguarda defensiva del handler.
  pagoForzado?: unknown[];
  mpPago?: unknown; mpStatus?: number;
  reclamo?: unknown[];
  // Simula un fallo de Supabase en una escritura concreta, para ejercitar los
  // caminos donde el estado de la fila no se puede escribir.
  escrituraFalla?: (url: string, body: any) => boolean;
  emitir?: { status: number; body: unknown };
  escrituras?: Array<{ url: string; body: any }>;
  mensajes?: string[];
} = {}) {
  const spy = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    const metodo = init?.method ?? 'GET';

    if (href.includes('supabase.test')) {
      if (metodo === 'PATCH' || metodo === 'POST') {
        const cuerpo = JSON.parse(String(init?.body ?? '{}'));
        h.escrituras?.push({ url: href, body: cuerpo });
        if (h.escrituraFalla?.(href, cuerpo)) return new Response('{}', { status: 500 });
        // Solo la transicion atomica de reclamarAprobado, no cualquier PATCH
        // que lleve `estado=eq.pendiente` en la URL: desde I4, marcarEstado
        // tambien condiciona por estado y la rama de monto que no calza usa
        // ese mismo filtro.
        if (cuerpo.estado === 'aprobado' && href.includes('estado=eq.pendiente')) {
          return new Response(JSON.stringify(h.reclamo ?? [{ quote_id: QUOTE }]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }
      if (href.includes('/cotizaciones')) {
        return new Response(JSON.stringify(filtrarPorQuoteId(href, h.cotizacion ?? [COTIZACION])), { status: 200 });
      }
      const filasPago = h.pagoForzado ?? filtrarPorQuoteId(href, h.pago ?? [PAGO]);
      return new Response(JSON.stringify(filasPago), { status: 200 });
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

beforeEach(() => { _limpiarCacheKapso(); _limpiarVentanaAlertas(); });
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

  it('segunda notificacion de un pago rechazado con el mismo id: no repite el aviso ni la escritura', async () => {
    // Mercado Pago reenvia habitualmente mas de una notificacion por el mismo
    // pago (una al crearse, otra al actualizarse). La fila ya trae
    // mp_payment_id de la entrega anterior: misma id, no se vuelve a sumar
    // el contador ni a avisar al cliente por segunda vez.
    const escrituras: any[] = [];
    const mensajes: string[] = [];
    routeFetch({
      escrituras, mensajes,
      pago: [{ ...PAGO, mp_payment_id: PAYMENT_ID }],
      mpPago: { id: PAYMENT_ID, status: 'rejected', external_reference: QUOTE, transaction_amount: 219725 },
    });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(escrituras).toHaveLength(0);
    expect(mensajes).toHaveLength(0);
  });

  it('segunda notificacion de monto que no calza con el mismo id: no repite la alerta interna', async () => {
    const escrituras: any[] = [];
    const alertas: string[] = [];
    routeFetch({
      escrituras,
      pago: [{ ...PAGO, mp_payment_id: PAYMENT_ID }],
      mpPago: { id: PAYMENT_ID, status: 'approved', external_reference: QUOTE, transaction_amount: 1000 },
    });
    const res = makeRes();
    await createWebhookHandler(async (asunto) => { alertas.push(asunto); })(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(alertas).toHaveLength(0);
    expect(escrituras).toHaveLength(0);
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

  // Estado que la base no deberia producir (Supabase ya filtra por
  // quote_id): se prueba de todos modos porque la consecuencia de
  // confiar ciegamente en la fila es emitir una orden de compra real
  // contra la cotizacion de otro cliente.
  it('fila de pagos con quote_id distinto al consultado: no emite (salvaguarda defensiva)', async () => {
    const spy = routeFetch({ pagoForzado: [{ ...PAGO, quote_id: 'otra-cotizacion' }] });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
  });
});

// =====================================================================
// C2: `aprobado` era un estado terminal de facto. Entre que la fila se
// reclama como `aprobado` y que se marca `emitido` o `aprobado_sin_emitir`
// hay cuatro llamadas de red; si el proceso muere ahi, la fila queda en
// `aprobado` para siempre y la reentrega de Mercado Pago respondia 200 muda.
// Y como la emision corre en un Worker aparte, lo mas probable es que las
// ordenes de compra SI hayan salido.
// =====================================================================
describe('la fila que queda colgada entre la reclamacion y el desenlace', () => {
  it('si no se puede escribir el estado final, alerta al interno', async () => {
    const alertas: Array<[string, string]> = [];
    routeFetch({ escrituraFalla: (_u, b) => b.estado === 'emitido' });
    const res = makeRes();
    await createWebhookHandler(async (a, d) => { alertas.push([a, d]); })(makeReq(), res, ENV);
    expect(alertas).toHaveLength(1);
    expect(alertas[0][0].toLowerCase()).toContain('no se pudo escribir');
  });

  it('si no se pueden marcar los pedidos como pagados, alerta al interno', async () => {
    const alertas: Array<[string, string]> = [];
    routeFetch({ escrituraFalla: (u) => u.includes('/pedidos') });
    const res = makeRes();
    await createWebhookHandler(async (a, d) => { alertas.push([a, d]); })(makeReq(), res, ENV);
    expect(alertas).toHaveLength(1);
    expect(alertas[0][0]).toContain('pedidos');
  });

  it('la reentrega sobre una fila que sigue en aprobado alerta en vez de responder muda', async () => {
    const alertas: Array<[string, string]> = [];
    const spy = routeFetch({
      pago: [{ ...PAGO, estado: 'aprobado', mp_payment_id: PAYMENT_ID }],
      reclamo: [],
    });
    const res = makeRes();
    await createWebhookHandler(async (a, d) => { alertas.push([a, d]); })(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
    expect(alertas).toHaveLength(1);
    expect(alertas[0][0]).toContain('atascad');
  });

  it('la reentrega sobre una fila ya emitido sigue siendo un 200 silencioso', async () => {
    const alertas: string[] = [];
    routeFetch({
      pago: [{ ...PAGO, estado: 'emitido', mp_payment_id: PAYMENT_ID }],
      reclamo: [],
    });
    const res = makeRes();
    await createWebhookHandler(async (a) => { alertas.push(a); })(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(alertas).toHaveLength(0);
  });

  it('la reentrega sobre una fila ya aprobado_sin_emitir tampoco alerta', async () => {
    const alertas: string[] = [];
    routeFetch({
      pago: [{ ...PAGO, estado: 'aprobado_sin_emitir', mp_payment_id: PAYMENT_ID }],
      reclamo: [],
    });
    const res = makeRes();
    await createWebhookHandler(async (a) => { alertas.push(a); })(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(alertas).toHaveLength(0);
  });
});

// =====================================================================
// I2: Checkout Pro no impide que una preferencia se pague dos veces, y el
// mensaje de rechazo invita literalmente a reintentar con el mismo link. Un
// segundo pago trae id distinto y monto correcto, asi que pasa el guard de
// duplicado y el chequeo de monto, y muere callado en la transicion
// condicional. Plata cobrada dos veces, cero rastro.
// =====================================================================
describe('un segundo pago genuino sobre el mismo link', () => {
  it('con id distinto sobre una fila ya emitido: alerta y no emite de nuevo', async () => {
    const alertas: Array<[string, string]> = [];
    const escrituras: any[] = [];
    const spy = routeFetch({
      escrituras,
      pago: [{ ...PAGO, estado: 'emitido', mp_payment_id: '111111111' }],
      mpPago: { id: '222222222', status: 'approved', external_reference: QUOTE, transaction_amount: 219725 },
      reclamo: [],
    });
    const res = makeRes();
    await createWebhookHandler(async (a, d) => { alertas.push([a, d]); })(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
    // La unica escritura intentada es la transicion condicional, que no
    // encontro fila que tomar: el desenlace del primer pago queda intacto.
    expect(escrituras.every((e) => e.url.includes('estado=eq.pendiente'))).toBe(true);
    expect(alertas).toHaveLength(1);
    expect(alertas[0][0].toLowerCase()).toContain('segundo');
    // Quien lo resuelve necesita los dos identificadores para devolver el que
    // sobra: el que ya estaba registrado y el que acaba de llegar.
    expect(alertas[0][1]).toContain('222222222');
    expect(alertas[0][1]).toContain('111111111');
  });

  it('con id distinto sobre una fila colgada en aprobado: alerta por las dos cosas', async () => {
    const alertas: string[] = [];
    routeFetch({
      pago: [{ ...PAGO, estado: 'aprobado', mp_payment_id: '111111111' }],
      mpPago: { id: '222222222', status: 'approved', external_reference: QUOTE, transaction_amount: 219725 },
      reclamo: [],
    });
    const res = makeRes();
    await createWebhookHandler(async (a) => { alertas.push(a); })(makeReq(), res, ENV);
    expect(alertas).toHaveLength(2);
    expect(alertas.some((a) => a.includes('atascad'))).toBe(true);
    expect(alertas.some((a) => a.toLowerCase().includes('segundo'))).toBe(true);
  });
});

// =====================================================================
// I4 visto desde el webhook: la rama de monto que no calza transiciona desde
// `pendiente`, no desde cualquier cosa. Sin esa condicion degradaba a
// `aprobado_sin_emitir` una fila que ya estaba `emitido` por un pago anterior
// legitimo, borrando el registro de que las ordenes si salieron.
// =====================================================================
describe('el monto que no calza no pisa una fila ya resuelta', () => {
  it('condiciona la degradacion a que la fila siga pendiente', async () => {
    const escrituras: any[] = [];
    const alertas: string[] = [];
    routeFetch({
      escrituras,
      pago: [{ ...PAGO, estado: 'emitido', mp_payment_id: '111111111' }],
      mpPago: { id: '222222222', status: 'approved', external_reference: QUOTE, transaction_amount: 1000 },
    });
    const res = makeRes();
    await createWebhookHandler(async (a) => { alertas.push(a); })(makeReq(), res, ENV);
    const degradacion = escrituras.find((e) => e.body.estado === 'aprobado_sin_emitir');
    expect(degradacion).toBeDefined();
    expect(degradacion.url).toContain('estado=eq.pendiente');
    // El monto sigue sin calzar: eso se alerta igual, la fila se pise o no.
    expect(alertas).toHaveLength(1);
  });

  it('los caminos terminales transicionan desde aprobado', async () => {
    const escrituras: any[] = [];
    routeFetch({ escrituras });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    const final = escrituras.find((e) => e.body.estado === 'emitido');
    expect(final.url).toContain('estado=eq.aprobado');
  });
});

// =====================================================================
// C2, parte 1: el techo de ejecucion. La razon por la que la fila se queda
// colgada en `aprobado` es que el proceso se muere entre la reclamacion y el
// desenlace, y con un techo de 30s eso no es hipotetico: el presupuesto de
// timeouts de este handler suma mucho mas que eso.
//
// Peor caso del camino aprobado, sumando los AbortSignal.timeout reales:
//   consultarPago (mercadopago.ts)          10s
//   leerPago (datos.ts)                      8s
//   reclamarAprobado (datos.ts)              8s
//   leerCotizacion (datos.ts)                8s
//   invocarFunction (kapso.ts): listado     30s
//                             + invoke      30s
//                 + re-listado e invoke por 404 obsoleto   60s
//   marcarEstado                             8s
//   marcarPedidosPagados                     8s
//   enviarTexto                              5s
//                                         ------
//                                           175s
//
// De ahi el 300: cubre el peor caso completo con margen, y es el maximo
// documentado de Vercel fuera de fluid compute. No se elige mas bajo porque
// un techo por debajo del presupuesto es exactamente el bug; no mas alto
// porque no hay nada que esperar despues de esos 175s.
// =====================================================================
describe('techo de ejecucion de las rutas de pago', () => {
  const config = JSON.parse(readFileSync('apps/mailer/vercel.json', 'utf8'));
  const patrones = Object.keys(config.functions);

  it('las rutas de pago tienen un techo holgado frente al presupuesto de timeouts', () => {
    const pago = patrones.find((p) => p.startsWith('api/pago/'));
    expect(pago, 'no hay una entrada especifica para las rutas de pago').toBeDefined();
    expect(config.functions[pago!].maxDuration).toBeGreaterThanOrEqual(175);
  });

  it('el patron especifico va antes del glob general, que gana por orden', () => {
    const pago = patrones.findIndex((p) => p.startsWith('api/pago/'));
    const general = patrones.indexOf('api/**/*.ts');
    expect(general, 'el glob general sigue existiendo para el resto de api/').toBeGreaterThan(-1);
    expect(pago).toBeLessThan(general);
  });

  it('el resto de api/ conserva su techo corto', () => {
    expect(config.functions['api/**/*.ts'].maxDuration).toBe(30);
  });
});

// =====================================================================
// I6: el 401 por firma y el 500 por configuracion solo escribian al log. Si
// el secreto del webhook se carga mal, TODOS los pagos fallan con 401,
// Mercado Pago reintenta unas veces y se rinde, y la unica senal es un log
// que nadie mira -- mientras al cliente se le prometio que apenas se acredite
// el pago se le confirma el pedido. Es el modo de fallo mas probable del
// primer dia y el mas silencioso.
// =====================================================================
describe('los retornos tempranos avisan al interno', () => {
  it('una firma invalida alerta', async () => {
    const alertas: Array<[string, string]> = [];
    vi.stubGlobal('fetch', vi.fn());
    const res = makeRes();
    await createWebhookHandler(async (a, d) => { alertas.push([a, d]); })(
      makeReq({ header: firmarHeader(PAYMENT_ID, 'otro-secreto') }), res, ENV);
    expect(res.statusCode).toBe(401);
    expect(alertas).toHaveLength(1);
    expect(alertas[0][0].toLowerCase()).toContain('firma');
  });

  // La alerta sale por correo y el correo se archiva. Nunca puede llevar la
  // firma, el secreto ni el cuerpo del webhook.
  it('la alerta de firma no lleva la firma, el secreto ni el cuerpo', async () => {
    const alertas: string[] = [];
    vi.stubGlobal('fetch', vi.fn());
    const header = firmarHeader(PAYMENT_ID, 'otro-secreto');
    await createWebhookHandler(async (a, d) => { alertas.push(a + ' ' + d); })(
      makeReq({ header }), makeRes(), ENV);
    const texto = alertas.join('\n');
    expect(texto).not.toContain(header);
    expect(texto).not.toContain(header.split('v1=')[1]);
    expect(texto).not.toContain(SECRET);
    expect(texto).not.toContain(PAYMENT_ID);
    expect(texto).not.toContain(REQUEST_ID);
  });

  // El endpoint es publico: cualquiera que sepa la URL puede disparar 401 a
  // voluntad, y una alerta por request convierte la casilla del interno en el
  // blanco. La ventana en memoria del proceso acota la inundacion sin que
  // haga falta estado compartido.
  it('dos firmas invalidas seguidas producen una sola alerta', async () => {
    const alertas: string[] = [];
    vi.stubGlobal('fetch', vi.fn());
    const alertar = async (a: string) => { alertas.push(a); };
    const handler = createWebhookHandler(alertar);
    await handler(makeReq({ header: firmarHeader(PAYMENT_ID, 'otro') }), makeRes(), ENV);
    await handler(makeReq({ header: firmarHeader(PAYMENT_ID, 'otro-mas') }), makeRes(), ENV);
    expect(alertas).toHaveLength(1);
  });

  it('pasada la ventana vuelve a alertar: la senal no desaparece en un fallo largo', async () => {
    vi.useFakeTimers();
    try {
      const alertas: string[] = [];
      vi.stubGlobal('fetch', vi.fn());
      const handler = createWebhookHandler(async (a) => { alertas.push(a); });
      await handler(makeReq({ header: firmarHeader(PAYMENT_ID, 'otro') }), makeRes(), ENV);
      vi.advanceTimersByTime(VENTANA_ALERTAS_MS + 1000);
      await handler(makeReq({ header: firmarHeader(PAYMENT_ID, 'otro') }), makeRes(), ENV);
      expect(alertas).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falta de configuracion alerta nombrando la variable, nunca su valor', async () => {
    const alertas: Array<[string, string]> = [];
    vi.stubGlobal('fetch', vi.fn());
    const res = makeRes();
    await createWebhookHandler(async (a, d) => { alertas.push([a, d]); })(
      makeReq(), res, { ...ENV, MP_WEBHOOK_SECRET: undefined } as any);
    expect(res.statusCode).toBe(500);
    expect(alertas).toHaveLength(1);
    expect(alertas[0][1]).toContain('MP_WEBHOOK_SECRET');
    expect(alertas.join()).not.toContain(SECRET);
  });

  // La respuesta HTTP no nombra las variables que faltan, a diferencia de
  // /api/pago/crear: ese endpoint esta autenticado y este es publico.
  it('la respuesta publica del 500 no enumera las variables que faltan', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const res = makeRes();
    await createWebhookHandler(async () => {})(makeReq(), res, { ...ENV, MP_WEBHOOK_SECRET: undefined } as any);
    expect(JSON.stringify(res.jsonBody)).not.toContain('MP_WEBHOOK_SECRET');
  });

  it('el 200 que ignora una notificacion que no es de pago no alerta', async () => {
    const alertas: string[] = [];
    vi.stubGlobal('fetch', vi.fn());
    const res = makeRes();
    await createWebhookHandler(async (a) => { alertas.push(a); })(
      makeReq({ query: { type: 'plan', 'data.id': PAYMENT_ID } }), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(alertas).toHaveLength(0);
  });
});
