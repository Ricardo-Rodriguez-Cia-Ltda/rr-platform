import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createCrearHandler } from '../src/pago/crear.js';
import { _limpiarCacheKapso } from '../src/pago/kapso.js';

const ENV = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_KEY: 'clave',
  MAILER_API_KEY: 'clave-kapso',
  MP_ACCESS_TOKEN: 'token-mp',
  PAGO_BASE_URL: 'https://rr-mailing.vercel.app',
  KAPSO_API_KEY: 'kapso-key',
};

const QUOTE = 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4';

const COTIZACION = {
  quote_id: QUOTE, version: '1', numero: 1600001, telefono: '56941757584',
  total_clp: 219725, valida_hasta: new Date(Date.now() + 3 * 3600_000).toISOString(),
  lineas: [{ proveedor: 'intcomex', cantidad: 1, precio_unitario_usd: 10, subtotal_neto_clp: 184643 }],
  proveedores_incompletos: [],
};

const CUERPO = {
  quote_id: QUOTE, quote_version: '1',
  phone_number: '56941757584', phone_number_id: 'PNID',
  customer_name: 'Acme SpA', billing_email: 'contacto@acme.cl',
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

function makeReq(body: unknown, key = 'clave-kapso'): VercelRequest {
  return { method: 'POST', body, headers: { 'x-api-key': key }, query: {} } as unknown as VercelRequest;
}

/** Enruta fetch por URL: supabase, mercadopago y kapso, cada uno con su guion. */
function routeFetch(h: {
  cotizacion?: unknown[]; pago?: unknown[]; crearPago?: number;
  preferencia?: { status: number; body: unknown };
  mensajes?: string[];
  escrituras?: unknown[];
  preferenciaEnviada?: unknown[];
}) {
  const spy = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('supabase.test')) {
      if (href.includes('/cotizaciones')) return new Response(JSON.stringify(h.cotizacion ?? [COTIZACION]), { status: 200 });
      if (href.includes('/pagos') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(h.pago ?? []), { status: 200 });
      }
      // Captura el cuerpo de cualquier escritura (POST/PATCH) para que los
      // tests puedan inspeccionar exactamente lo que se persiste.
      if (init?.body && h.escrituras) {
        h.escrituras.push(JSON.parse(String(init.body)));
      }
      return new Response('[]', { status: h.crearPago ?? 201 });
    }
    if (href.includes('api.mercadopago.com')) {
      // Captura el cuerpo que se le manda a Mercado Pago (el payer incluido),
      // para que los tests puedan verificar que no lleva plantillas de Kapso.
      if (init?.body && h.preferenciaEnviada) {
        h.preferenciaEnviada.push(JSON.parse(String(init.body)));
      }
      const p = h.preferencia ?? { status: 201, body: { id: 'pref-1', init_point: 'https://mp/pagar' } };
      return new Response(JSON.stringify(p.body), { status: p.status });
    }
    if (href.includes('/meta/whatsapp/')) {
      h.mensajes?.push(String(init?.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`llamada inesperada: ${href}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => _limpiarCacheKapso());
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/pago/crear', () => {
  it('crea la preferencia, guarda la fila y manda el boton de pago', async () => {
    const mensajes: string[] = [];
    routeFetch({ mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.init_point).toBe('https://mp/pagar');
    const enviado = JSON.parse(mensajes[0]);
    expect(enviado.interactive.action.parameters.url).toBe('https://mp/pagar');
    expect(enviado.interactive.body.text).toContain('$219.725');
  });

  it('sin la api key correcta responde 401 sin tocar nada', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO, 'otra'), res, ENV);
    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('es idempotente: una segunda llamada devuelve el link que ya existe', async () => {
    const spy = routeFetch({
      pago: [{ quote_id: QUOTE, init_point: 'https://mp/ya-existe', estado: 'pendiente' }],
    });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.init_point).toBe('https://mp/ya-existe');
    expect(spy.mock.calls.every(([u]) => !String(u).includes('mercadopago'))).toBe(true);
  });

  it('cotizacion con menos de 15 minutos de vigencia: 409 y aviso, sin preferencia', async () => {
    const mensajes: string[] = [];
    const spy = routeFetch({
      cotizacion: [{ ...COTIZACION, valida_hasta: new Date(Date.now() + 5 * 60_000).toISOString() }],
      mensajes,
    });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(409);
    expect(spy.mock.calls.every(([u]) => !String(u).includes('mercadopago'))).toBe(true);
    expect(JSON.parse(mensajes[0]).text.body).toContain('refrescar');
  });

  it('Mercado Pago caido: 502, aviso honesto y nada persistido', async () => {
    const mensajes: string[] = [];
    const spy = routeFetch({ preferencia: { status: 500, body: {} }, mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(mensajes[0]).text.body).toContain('problema');
    const escrituras = spy.mock.calls.filter(([u, i]) =>
      String(u).includes('/pagos') && (i as RequestInit)?.method === 'POST');
    expect(escrituras).toHaveLength(0);
  });

  it('cotizacion inexistente responde 404', async () => {
    routeFetch({ cotizacion: [] });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(404);
  });

  it('cuerpo sin quote_id responde 400', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCrearHandler()(makeReq({ ...CUERPO, quote_id: '' }), res, ENV);
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('falta configuracion: 503 nombrando las variables, nunca sus valores', async () => {
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, { ...ENV, MP_ACCESS_TOKEN: undefined } as any);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.faltan).toContain('MP_ACCESS_TOKEN');
    expect(JSON.stringify(res.jsonBody)).not.toContain('token-mp');
  });

  it('metodo distinto de POST responde 405', async () => {
    const res = makeRes();
    await createCrearHandler()({ ...makeReq(CUERPO), method: 'GET' } as any, res, ENV);
    expect(res.statusCode).toBe(405);
  });

  // Añadido (fuera del brief): el nodo webhook de Kapso rellena plantillas
  // {{vars.xxx}} en el cuerpo que manda. Si `billing_rut` nunca se escribio
  // durante la conversacion, Kapso puede mandar el literal sin renderizar en
  // vez de una cadena vacia. Ese literal no debe quedar guardado en `pagos.datos`
  // -- de ahi terminaria impreso en el PDF de la orden de compra al mayorista.
  it('billing_rut como plantilla sin renderizar de Kapso no se persiste', async () => {
    const mensajes: string[] = [];
    const escrituras: unknown[] = [];
    routeFetch({ mensajes, escrituras });
    const res = makeRes();
    await createCrearHandler()(makeReq({
      ...CUERPO,
      billing_rut: '{{vars.billing_rut}}',
    }), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
    const filaPago = escrituras.find((e) => (e as any)?.quote_id === QUOTE) as any;
    expect(filaPago).toBeDefined();
    expect(filaPago.datos).not.toHaveProperty('billing_rut');
    // El resto del cuerpo, que si vino renderizado, se guarda con normalidad.
    expect(filaPago.datos.quote_customer_name).toBe('Acme SpA');
  });

  // Añadido (ronda 2, pedido del coordinador): el mismo defecto por otra
  // puerta. `customer_name` sin renderizar no solo puede quedar guardado en
  // `datos` -- tambien viaja como nombre del pagador a Mercado Pago, visible
  // en la pagina de pago que ve el cliente. El saneo tiene que ocurrir una
  // sola vez al leer la entrada, para que el payer herede el valor ya sano
  // y caiga en su fallback 'Cliente' en vez del literal.
  it('customer_name como plantilla sin renderizar cae al payer por defecto en Mercado Pago', async () => {
    const preferenciaEnviada: unknown[] = [];
    routeFetch({ preferenciaEnviada });
    const res = makeRes();
    await createCrearHandler()(makeReq({
      ...CUERPO,
      customer_name: '{{vars.quote_customer_name}}',
    }), res, ENV);
    expect(res.statusCode).toBe(200);
    const cuerpoPreferencia = preferenciaEnviada[0] as any;
    expect(cuerpoPreferencia.payer.name).toBe('Cliente');
  });
});
