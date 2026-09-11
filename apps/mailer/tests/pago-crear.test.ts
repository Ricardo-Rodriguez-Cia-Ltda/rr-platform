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

// `quote_confirmed` es parte del contrato desde C1: el nodo del grafo lo manda
// y el handler lo exige. Sin el, cualquier cuerpo es un "el cliente no dijo que
// si" y se rechaza antes de tocar Mercado Pago.
const CUERPO = {
  quote_id: QUOTE, quote_version: '1', quote_confirmed: true,
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

  // -------------------------------------------------------------------
  // C1: el guard de consentimiento. Hasta el cambio de grafo, el unico
  // chequeo determinista de que el cliente dijo que si vivia en
  // emitir-ordenes-compra.js, que ya no esta en el camino. El criterio es
  // copia del suyo: el booleano true, o la cadena "true" sin distinguir
  // mayusculas, porque lo escribe un LLM con save_variable.
  // -------------------------------------------------------------------

  it('quote_confirmed como booleano true deja pasar el cobro', async () => {
    routeFetch({});
    const res = makeRes();
    await createCrearHandler()(makeReq({ ...CUERPO, quote_confirmed: true }), res, ENV);
    expect(res.statusCode).toBe(200);
  });

  it('quote_confirmed como la cadena "TRUE" deja pasar el cobro', async () => {
    routeFetch({});
    const res = makeRes();
    await createCrearHandler()(makeReq({ ...CUERPO, quote_confirmed: ' TRUE ' }), res, ENV);
    expect(res.statusCode).toBe(200);
  });

  it('sin quote_confirmed: 400, sin preferencia, sin fila y sin mensaje al cliente', async () => {
    const mensajes: string[] = [];
    const { quote_confirmed, ...sinConfirmar } = CUERPO as any;
    const spy = routeFetch({ mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq(sinConfirmar), res, ENV);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('sin_confirmacion');
    expect(spy).not.toHaveBeenCalled();
    expect(mensajes).toHaveLength(0);
  });

  it('quote_confirmed con un valor que no es un si: 400, sin preferencia y sin fila', async () => {
    const mensajes: string[] = [];
    const spy = routeFetch({ mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq({ ...CUERPO, quote_confirmed: 'quizas' }), res, ENV);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('sin_confirmacion');
    expect(spy).not.toHaveBeenCalled();
    expect(mensajes).toHaveLength(0);
  });

  it('quote_confirmed como plantilla de Kapso sin renderizar tampoco es un si', async () => {
    const spy = routeFetch({});
    const res = makeRes();
    await createCrearHandler()(makeReq({ ...CUERPO, quote_confirmed: '{{vars.quote_confirmed}}' }), res, ENV);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('sin_confirmacion');
    expect(spy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // I1: las salidas mudas. El cliente acaba de decir "si, cursalo"; el spec
  // saco el nodo que mandaba el texto fijo porque "el servicio de pagos sabe
  // que decir". Ninguna de estas respuestas puede dejarlo sin una palabra.
  // -------------------------------------------------------------------

  it('cotizacion no encontrada: 404 y ademas avisa al cliente', async () => {
    const mensajes: string[] = [];
    routeFetch({ cotizacion: [], mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(404);
    expect(mensajes).toHaveLength(1);
    expect(JSON.parse(mensajes[0]).text.body).toContain('problema');
  });

  it('fallo de red al leer la cotizacion: 503 y aviso al cliente', async () => {
    const mensajes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/cotizaciones')) return new Response('{}', { status: 500 });
      if (href.includes('/pagos')) return new Response('[]', { status: 200 });
      if (href.includes('/meta/whatsapp/')) {
        mensajes.push(String(init?.body));
        return new Response('{}', { status: 200 });
      }
      throw new Error(`llamada inesperada: ${href}`);
    }));
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(mensajes).toHaveLength(1);
    expect(JSON.parse(mensajes[0]).text.body).toContain('problema');
  });

  it('fallo de red al leer la fila de pagos: 503 y aviso al cliente', async () => {
    const mensajes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/pagos')) return new Response('{}', { status: 500 });
      if (href.includes('/meta/whatsapp/')) {
        mensajes.push(String(init?.body));
        return new Response('{}', { status: 200 });
      }
      throw new Error(`llamada inesperada: ${href}`);
    }));
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(mensajes).toHaveLength(1);
    expect(JSON.parse(mensajes[0]).text.body).toContain('problema');
  });

  // Decision deliberada (I1): el cuerpo invalido NO avisa. Ver el comentario
  // en crear.ts -- un cuerpo que no se puede leer tampoco es fuente confiable
  // de a quien mandarle un WhatsApp.
  it('cuerpo invalido: 400 mudo, sin mandar nada por WhatsApp', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCrearHandler()(makeReq({ ...CUERPO, quote_id: '' }), res, ENV);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('cuerpo_invalido');
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

  // Añadido (ronda 3, fix #1 del coordinador): `avisar` capturaba solo
  // `entrada.telefono`, sin el fallback al telefono de la cotizacion que si
  // usa la fila persistida. Un cuerpo sin phone_number usable, con la
  // cotizacion sí guardando telefono, dejaba mudos los cuatro caminos de
  // fallo que deben avisarle al cliente.
  it('sin phone_number en el cuerpo, el aviso de fallo usa el telefono de la cotizacion', async () => {
    const mensajes: string[] = [];
    const { phone_number, ...cuerpoSinTelefono } = CUERPO as any;
    routeFetch({
      cotizacion: [{ ...COTIZACION, valida_hasta: new Date(Date.now() + 5 * 60_000).toISOString() }],
      mensajes,
    });
    const res = makeRes();
    await createCrearHandler()(makeReq(cuerpoSinTelefono), res, ENV);
    expect(res.statusCode).toBe(409);
    expect(mensajes).toHaveLength(1);
    const enviado = JSON.parse(mensajes[0]);
    expect(enviado.to).toBe(COTIZACION.telefono);
    expect(enviado.text.body).toContain('refrescar');
  });

  // Añadido (ronda 3, fix #2 del coordinador): el escenario que mas preocupa
  // -- la preferencia se crea bien en Mercado Pago pero la fila no se puede
  // guardar en `pagos`. No se debe mandar el link (no hay donde anotar el
  // pago para que el webhook lo reclame), pero si avisar honestamente.
  it('la preferencia se crea pero la fila no se puede guardar: 503, aviso y sin boton de pago', async () => {
    const mensajes: string[] = [];
    routeFetch({ crearPago: 500, mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(mensajes).toHaveLength(1);
    const enviado = JSON.parse(mensajes[0]);
    expect(enviado.type).toBe('text');
    expect(enviado.text.body).toContain('problema');
  });

  // Añadido (ronda 3, fix #3 del coordinador): si falta justo MAILER_API_KEY,
  // NINGUN valor de x-api-key puede autorizar. Responder 401 en ese caso
  // confunde a quien despliega, que sale a buscar un problema de credenciales
  // que no existe. Debe responder 503 nombrando la variable, sin tocar fetch.
  it('falta MAILER_API_KEY: 503 nombrandola, no 401', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, { ...ENV, MAILER_API_KEY: undefined } as any);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.faltan).toContain('MAILER_API_KEY');
    expect(spy).not.toHaveBeenCalled();
  });
});
