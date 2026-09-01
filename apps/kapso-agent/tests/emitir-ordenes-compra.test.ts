import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHandler, request } from './load.js';

const handler = loadHandler('apps/kapso-agent/functions/emitir-ordenes-compra.js');

const MINUTE = 60_000;

// D1 falso: guarda filas en un Map y respeta la primary key, que es de donde
// sale la idempotencia real. `fallaInsert` permite simular un INSERT que
// revienta por algo que NO es la clave duplicada (D1 caida, tabla bloqueada):
// ahi el SELECT no encuentra nada y la reserva idempotente no ocurrio.
function fakeD1(options: { failInsert?: (key: string) => boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith('CREATE')) return { success: true };
              if (sql.startsWith('INSERT')) {
                const key = String(args[0]);
                if (options.failInsert?.(key)) throw new Error('D1_ERROR: database is locked');
                if (rows.has(key)) throw new Error('UNIQUE constraint failed');
                // El status va literal en el SQL ('processing'); los bind son
                // order_key, po_id, quote_id, version, proveedor, created_at, updated_at.
                rows.set(key, {
                  order_key: key,
                  po_id: args[1],
                  quote_id: args[2],
                  quote_version: args[3],
                  proveedor: args[4],
                  status: 'processing',
                  created_at: args[5],
                  updated_at: args[6],
                });
                return { success: true };
              }
              if (sql.startsWith('UPDATE')) {
                // En los tres UPDATE de la function el ultimo bind es la clave
                // y el penultimo el updated_at.
                const key = String(args[args.length - 1]);
                const row = rows.get(key);
                if (row) {
                  row.status = sql.includes("'sent'") ? 'sent' : sql.includes("'failed'") ? 'failed' : 'processing';
                  row.updated_at = args[args.length - 2];
                  // En el UPDATE a 'failed' el primer bind es el mensaje de error.
                  if (sql.includes("'failed'")) row.error = args[0];
                  // En el UPDATE a 'sent' el primer bind es el email_id que
                  // devolvio el rele: sin capturarlo aca, una re-invocacion no
                  // puede probar que el email_id del envio real sobrevive.
                  if (sql.includes("'sent'")) row.email_id = args[0];
                }
                return { success: true };
              }
              return { success: true };
            },
            async first() {
              return rows.get(String(args[0])) ?? null;
            },
          };
        },
        async run() { return { success: true }; },
      };
    },
  };
  return { db, rows };
}

const quote = {
  quote_id: 'q-1',
  version: 1,
  lineas: [
    { mpn: 'A-1', marca: 'Epson', nombre: 'Cinta A', cantidad: 2, proveedor: 'ingram', sku_proveedor: 'ING-1', precio_unitario_usd: 11.3, precio_unitario_clp: 10735, subtotal_neto_clp: 21470, disponible: true, abastecimiento: 'stock_inmediato', comparacion: 'completa', ofertas_consideradas: 3, ahorro_vs_peor_clp: 0 },
    { mpn: 'A-2', marca: 'Epson', nombre: 'Cinta B', cantidad: 1, proveedor: 'ingram', sku_proveedor: 'ING-2', precio_unitario_usd: 22.6, precio_unitario_clp: 21470, subtotal_neto_clp: 21470, disponible: true, abastecimiento: 'stock_inmediato', comparacion: 'completa', ofertas_consideradas: 3, ahorro_vs_peor_clp: 0 },
    { mpn: 'B-1', marca: 'HP', nombre: 'Toner', cantidad: 3, proveedor: 'tecnoglobal', sku_proveedor: 'TG-9', precio_unitario_usd: 56.5, precio_unitario_clp: 53675, subtotal_neto_clp: 161025, disponible: false, abastecimiento: 'por_comprar_importar', comparacion: 'completa', ofertas_consideradas: 2, ahorro_vs_peor_clp: 0 },
  ],
  neto_clp: 203965,
  iva_clp: 38753,
  total_clp: 242718,
  proveedores_incompletos: [],
  valid_until: new Date(Date.now() + 3 * 3600_000).toISOString(),
};

// Cada llamada a env() estrena una base: la idempotencia se prueba compartiendo
// el MISMO entorno entre dos invocaciones, no reusandolo por accidente.
const env = (db: unknown = fakeD1().db) => ({
  MARGEN: '0.13',
  MAILER_URL: 'https://mailer.test/api/send',
  MAILER_API_KEY: 'clave',
  OC_EMAIL_DESTINO: 'pyxis.latam@gmail.com',
  DB: db,
});

function vars(extra: Record<string, unknown> = {}) {
  return { quote_result: quote, quote_confirmed: true, quote_customer_name: 'Vicente', billing_rut: '21088369-K', billing_razon_social: 'Acme SpA', billing_email: 'v@acme.cl', ...extra };
}

function resendOk() {
  const spy = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function bodies(spy: ReturnType<typeof resendOk>): string[] {
  return spy.mock.calls.map((c: any[]) => String((c[1] as RequestInit).body));
}

// Enruta fetch por URL: lo que va a supabase.test pasa por el callback (un
// throw simula caida, el retorno se envuelve en Response 200 JSON); el resto
// sigue yendo al mock del rele de correo (mismo formato que resendOk: 200 con
// {id: 'email-1'}), que es lo que estas pruebas de persistencia necesitan
// para que la emision del correo no interfiera con lo que se prueba.
function routeFetch(handlers: {
  supabase?: (url: string, init?: RequestInit) => unknown;
}) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith('https://supabase.test')) {
      if (!handlers.supabase) throw new Error('llamada inesperada a supabase');
      const resultado = handlers.supabase(href, init);
      return new Response(JSON.stringify(resultado), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function issue(environment: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await handler(request({ execution_context: { vars: vars(extra) } }), environment);
  return { res, data: (await res.json()) as any };
}

// Recorre recursivamente un valor visitando cada par (clave, valor). Es lo
// unico que detecta una fuga de costo enterrada en un objeto anidado: una
// lista de claves conocidas no ve lo que todavia no existe.
function walk(value: unknown, visit: (key: string | null, v: unknown) => void, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, key);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, visit, k);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('emitir-ordenes-compra', () => {
  it('llama al rele con la clave y el cuerpo esperado', async () => {
    const spy = resendOk();
    await handler(request({ execution_context: { vars: vars() } }), env());
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mailer.test/api/send');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('clave');
    const cuerpo = JSON.parse(String(init.body));
    expect(Object.keys(cuerpo).sort()).toEqual(['html', 'subject', 'text', 'to']);
  });

  it('emite una orden por mayorista', async () => {
    const spy = resendOk();
    const { data } = await issue(env());
    expect(data.ok).toBe(true);
    expect(data.vars.purchase_orders_count).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    const providers = data.vars.purchase_orders_result.map((o: { proveedor: string }) => o.proveedor).sort();
    expect(providers).toEqual(['ingram', 'tecnoglobal']);
  });

  it('agrupa las lineas del mismo mayorista en una sola orden', async () => {
    resendOk();
    const { data } = await issue(env());
    const ingram = data.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
    expect(ingram.lineas).toBe(2);
  });

  it('reconstruye el costo dividiendo por el margen', async () => {
    const spy = resendOk();
    await issue(env());
    const body = JSON.parse(bodies(spy)[0]);
    // 11.3 / 1.13 = 10.00
    expect(body.text).toContain('10');
    expect(body.text).not.toContain('11.3');
  });

  it('usa el sku del proveedor que gana, no el de Intcomex', async () => {
    const spy = resendOk();
    await issue(env());
    const ingram = bodies(spy).find((c) => c.includes('ING-1'));
    const tecno = bodies(spy).find((c) => c.includes('TG-9'));
    expect(ingram).toBeDefined();
    expect(tecno).toBeDefined();
    // Una orden no puede arrastrar la linea del otro mayorista: eso seria
    // comprarle a Ingram un producto que gano Tecnoglobal.
    expect(ingram).toContain('ING-2');
    expect(ingram).not.toContain('TG-9');
    expect(tecno).not.toContain('ING-1');
    expect(tecno).not.toContain('ING-2');
  });

  it('la segunda ejecucion no reenvia correos', async () => {
    const spy = resendOk();
    const environment = env();
    await issue(environment);
    expect(spy).toHaveBeenCalledTimes(2);
    const { data } = await issue(environment);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(data.vars.purchase_orders_result.every((o: { status: string }) => o.status === 'duplicate')).toBe(true);
  });

  it('un correo caido no impide el otro', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 })
        : new Response(JSON.stringify({ id: 'email-2' }), { status: 200 });
    }));
    const { data } = await issue(env());
    expect(data.vars.purchase_orders_ok).toBe(false);
    const statuses = data.vars.purchase_orders_result.map((o: { status: string }) => o.status).sort();
    expect(statuses).toEqual(['failed', 'sent']);
  });

  // El rele nunca devuelve `message` (eso es Resend): devuelve `error` y, en
  // fallas de transporte, tambien `codigo`. Sin leer los campos correctos,
  // cada falla del rele cae al generico y no dice nada util para depurar.
  it('combina error y codigo del rele en el mensaje que queda en D1', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'el_envio_fallo', codigo: 'EAUTH' }), { status: 502 })
    ));
    const { db, rows } = fakeD1();
    const { data } = await issue(env(db));

    const ingram = data.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
    expect(ingram.status).toBe('failed');

    const fila = rows.get('q-1:1:ingram');
    expect(fila?.error).toContain('el_envio_fallo');
    expect(fila?.error).toContain('EAUTH');
    expect(fila?.error).not.toBe('No se pudo enviar la orden.');
  });

  it('no emite sin confirmacion del cliente', async () => {
    resendOk();
    const { res } = await issue(env(), { quote_confirmed: false });
    expect(res.status).toBe(400);
  });

  it('no emite sin cotizacion', async () => {
    resendOk();
    const res = await handler(request({ execution_context: { vars: { quote_confirmed: true } } }), env());
    expect(res.status).toBe(400);
  });

  it('un fetch lanzado no impide el otro y es reintentable', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Network timeout');
      return new Response(JSON.stringify({ id: 'email-3' }), { status: 200 });
    }));
    const environment = env();
    const { data } = await issue(environment);
    expect(data.vars.purchase_orders_ok).toBe(false);
    let results = data.vars.purchase_orders_result;
    expect(results.some((o: { proveedor: string; status: string }) => o.proveedor === 'ingram' && o.status === 'failed')).toBe(true);
    expect(results.some((o: { proveedor: string; status: string }) => o.proveedor === 'tecnoglobal' && o.status === 'sent')).toBe(true);

    // Reintentar con el MISMO entorno: ingram (que estaba failed) se reintenta y queda sent;
    // tecnoglobal (que estaba sent) queda duplicate
    // (NO reiniciar llamada: el contador persiste, así ingram en la segunda invocación no lanza)
    const { data: data2 } = await issue(environment);
    results = data2.vars.purchase_orders_result;
    expect(results.some((o: { proveedor: string; status: string }) => o.proveedor === 'ingram' && o.status === 'sent')).toBe(true);
    expect(results.some((o: { proveedor: string; status: string }) => o.proveedor === 'tecnoglobal' && o.status === 'duplicate')).toBe(true);
  });

  // Hallazgo 1: la idempotencia no puede fallar abierta.
  describe('reserva idempotente', () => {
    it('no manda el correo si el INSERT falla por algo que no es la clave duplicada', async () => {
      const spy = resendOk();
      const { db } = fakeD1({ failInsert: (key) => key.endsWith(':ingram') });
      const { data } = await issue(env(db));

      // Sin fila persistida, cada reintento reenviaria la misma orden: hay que
      // abortar esa orden, no seguir hasta Resend.
      expect(bodies(spy).some((c) => c.includes('ING-1'))).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(bodies(spy)[0]).toContain('TG-9');

      const ingram = data.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
      expect(ingram.status).not.toBe('sent');
      expect(ingram.status).not.toBe('duplicate');
      expect(data.vars.purchase_orders_ok).toBe(false);
    });
  });

  // Hallazgo 2: la vigencia se revisa en la function que emite, no solo en el
  // nodo `decide` que corre antes de una conversacion sin limite de tiempo.
  describe('vigencia de la cotizacion', () => {
    it('no emite nada si la cotizacion expiro', async () => {
      const spy = resendOk();
      const expiredQuote = { ...quote, valid_until: new Date(Date.now() - MINUTE).toISOString() };
      const res = await handler(request({ execution_context: { vars: vars({ quote_result: expiredQuote }) } }), env());
      expect(res.status).toBe(409);
      expect(spy).not.toHaveBeenCalled();
    });

    it('no emite nada si la cotizacion no trae vigencia', async () => {
      const spy = resendOk();
      const { valid_until: _validUntil, ...withoutValidity } = quote;
      const res = await handler(request({ execution_context: { vars: vars({ quote_result: withoutValidity }) } }), env());
      expect(res.status).toBe(409);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Hallazgo 3: una fila trabada en `processing` no puede reportarse como exito.
  describe('filas abandonadas en processing', () => {
    const seed = (updatedAt: string) => {
      const { db, rows } = fakeD1();
      rows.set('q-1:1:ingram', {
        order_key: 'q-1:1:ingram', po_id: 'oc-viejo', quote_id: 'q-1', quote_version: '1',
        proveedor: 'ingram', status: 'processing', created_at: updatedAt, updated_at: updatedAt,
      });
      return db;
    };

    it('reintenta una fila processing que quedo vieja', async () => {
      const spy = resendOk();
      const db = seed(new Date(Date.now() - 30 * MINUTE).toISOString());
      const { data } = await issue(env(db));
      expect(bodies(spy).some((c) => c.includes('ING-1'))).toBe(true);
      const ingram = data.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
      expect(ingram.status).toBe('sent');
    });

    it('trata como duplicado una fila processing recien creada', async () => {
      const spy = resendOk();
      const db = seed(new Date(Date.now() - MINUTE).toISOString());
      const { data } = await issue(env(db));
      expect(bodies(spy).some((c) => c.includes('ING-1'))).toBe(false);
      const ingram = data.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
      expect(ingram.status).toBe('duplicate');
    });
  });

  // Hallazgo 4: `quote_confirmed` la escribe un LLM con save_variable, asi que
  // puede llegar como cadena.
  describe('normalizacion de quote_confirmed', () => {
    it.each([true, 'true', 'TRUE', ' true '])('emite con %p', async (value) => {
      const spy = resendOk();
      const { res } = await issue(env(), { quote_confirmed: value });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it.each([false, 'false', '', 'si', 'yes', '1', null, undefined])('no emite con %p', async (value) => {
      const spy = resendOk();
      const { res } = await issue(env(), { quote_confirmed: value });
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Hallazgo 5: la invariante del diseno es que ningun costo vive en una
  // variable que un `get_variable` pueda leer.
  describe('ningun costo sale de la function', () => {
    const costs = () => {
      const values = new Set<number>();
      const byProvider = new Map<string, number>();
      for (const line of quote.lineas) {
        const unit = Math.round((line.precio_unitario_usd / 1.13) * 100) / 100;
        const total = Math.round(unit * line.cantidad * 100) / 100;
        values.add(unit);
        values.add(total);
        byProvider.set(line.proveedor, (byProvider.get(line.proveedor) ?? 0) + total);
      }
      for (const total of byProvider.values()) values.add(Math.round(total * 100) / 100);
      return values;
    };

    it('ni las claves ni los valores de la respuesta llevan un costo', async () => {
      resendOk();
      const { data } = await issue(env());
      const forbidden = costs();
      expect(forbidden.size).toBeGreaterThan(0);

      // El nodo function guarda la respuesta COMPLETA en `purchase_orders_response`
      // (save_response_to), asi que el recorrido cubre el cuerpo entero, no solo `vars`.
      walk(data, (key, value) => {
        if (key) expect(key, `la clave ${key} suena a costo`).not.toMatch(/cost|_usd|margen|margin/i);
        if (typeof value === 'number') {
          expect(forbidden.has(value), `el valor ${value} es un costo reconstruido`).toBe(false);
        }
        // Una cadena que coacciona a un costo es el mismo dato con otra forma.
        // No se busca como substring: los ids y las fechas traen digitos y
        // darian falsos positivos.
        if (typeof value === 'string' && value.trim() !== '') {
          expect(forbidden.has(Number(value)), `el texto "${value}" es un costo`).toBe(false);
        }
      });
    });

    it('el correo si lleva el costo: ahi es donde tiene que estar', async () => {
      const spy = resendOk();
      await issue(env());
      const ingram = bodies(spy).find((c) => c.includes('ING-1')) ?? '';
      expect(ingram).toContain('10');
      expect(ingram).toContain('40');
    });
  });

  // Hallazgo 10: un MARGEN vacio coacciona a 0 y dejaria el costo igual al
  // precio de venta.
  it('rechaza un margen de cero', async () => {
    const spy = resendOk();
    const { res } = await issue({ ...env(), MARGEN: '' });
    expect(res.status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
  });

  // Hallazgo final 5: la lista blanca del rele compara exacto contra un
  // destino que si viene recortado del otro lado (apps/mailer/api/send.ts).
  // Un OC_EMAIL_DESTINO con espacios pegados no puede convertirse en
  // 403 destinatario_no_permitido.
  it('envia igual con OC_EMAIL_DESTINO con espacios alrededor', async () => {
    const spy = resendOk();
    const { data } = await issue({ ...env(), OC_EMAIL_DESTINO: '  pyxis.latam@gmail.com  ' });
    expect(data.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [, init] of spy.mock.calls as unknown as [string, RequestInit][]) {
      const cuerpo = JSON.parse(String(init.body));
      expect(cuerpo.to).toBe('pyxis.latam@gmail.com');
    }
  });
});

// La persistencia es memoria del negocio, no un eslabon: estas pruebas
// verifican tanto que se use como que su ausencia no cambie nada.
describe('emitir-ordenes-compra: persistencia', () => {
  // Dos proveedores, cotizacion propia (quote_id distinto de la de arriba)
  // para no chocar con la idempotencia de D1 de las otras pruebas.
  const quoteDosProveedores = {
    quote_id: 'q-persistencia',
    version: 1,
    lineas: [
      { mpn: 'A-1', marca: 'Epson', nombre: 'Cinta A', cantidad: 2, proveedor: 'ingram', sku_proveedor: 'ING-1', precio_unitario_usd: 11.3, precio_unitario_clp: 10735, subtotal_neto_clp: 21470, disponible: true, abastecimiento: 'stock_inmediato', comparacion: 'completa', ofertas_consideradas: 3, ahorro_vs_peor_clp: 0 },
      { mpn: 'B-1', marca: 'HP', nombre: 'Toner', cantidad: 3, proveedor: 'intcomex', sku_proveedor: 'IC-9', precio_unitario_usd: 56.5, precio_unitario_clp: 53675, subtotal_neto_clp: 161025, disponible: false, abastecimiento: 'por_comprar_importar', comparacion: 'completa', ofertas_consideradas: 2, ahorro_vs_peor_clp: 0 },
    ],
    neto_clp: 182495,
    iva_clp: 34674,
    total_clp: 217169,
    proveedores_incompletos: [],
    valid_until: new Date(Date.now() + 3 * 3600_000).toISOString(),
  };

  const billing = {
    billing_rut: '21099234-0',
    billing_razon_social: 'Vicente Pareja',
    billing_giro: 'Servicios',
    billing_direccion: 'Holanda 222',
    billing_comuna: 'Ñuñoa',
    billing_ciudad: 'Santiago',
    billing_email: 'parejavice@gmail.com',
  };

  const BODY_DOS_PROVEEDORES = {
    execution_context: {
      vars: { quote_result: quoteDosProveedores, quote_confirmed: true, quote_customer_name: 'Vicente Pareja', ...billing },
      context: { phone_number: '+56 9 4175 7584' },
    },
  };

  const BODY_SIN_TELEFONO = {
    execution_context: {
      vars: { quote_result: quoteDosProveedores, quote_confirmed: true, quote_customer_name: 'Vicente Pareja', ...billing },
    },
  };

  // Funciones, no constantes: cada prueba necesita su propio D1 fresco, si no
  // la idempotencia de la segunda prueba que reusa BODY_DOS_PROVEEDORES vería
  // la orden de la primera ya como 'sent' y todo el resto correría 'duplicate'.
  const ENV_SB = () => ({ ...env(), SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave-de-prueba' });
  const ENV_SIN_SUPABASE = () => env();

  it('guarda una fila de pedido por proveedor, con las lineas del grupo', async () => {
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { if (url.includes('/pedidos')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    await handler(request(BODY_DOS_PROVEEDORES), ENV_SB());
    expect(cuerpos).toHaveLength(1);           // un solo POST con arreglo
    expect(cuerpos[0]).toHaveLength(2);        // dos proveedores = dos filas
    const proveedores = cuerpos[0].map((p: any) => p.proveedor).sort();
    expect(proveedores).toEqual(['ingram', 'intcomex']);
    expect(cuerpos[0][0].estado).toBe('sent');
    expect(cuerpos[0][0].rut).toBe('21099234-0');
  });

  it('hace upsert del cliente confirmado por telefono', async () => {
    const urls: string[] = [];
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { urls.push(url); if (url.includes('/clientes')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    await handler(request(BODY_DOS_PROVEEDORES), ENV_SB());
    expect(urls.some((u) => u.includes('/clientes?on_conflict=telefono'))).toBe(true);
    expect(cuerpos[0].telefono).toBe('56941757584');
    expect(cuerpos[0].razon_social).toBe('Vicente Pareja');
  });

  it('con Supabase caido, la emision completa igual y persistencia es fallo', async () => {
    routeFetch({ supabase: () => { throw new Error('ECONNRESET'); } });
    const res = await handler(request(BODY_DOS_PROVEEDORES), ENV_SB());
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.vars.purchase_orders_ok).toBe(true);
    expect(data.persistencia).toBe('fallo');
  });

  it('sin secretos, ni llama a Supabase ni agrega el campo', async () => {
    const urls: string[] = [];
    routeFetch({ supabase: (url) => { urls.push(url); return {}; } });
    const res = await handler(request(BODY_DOS_PROVEEDORES), ENV_SIN_SUPABASE());
    expect(urls).toHaveLength(0);
    expect(((await res.json()) as any).persistencia).toBeUndefined();
  });

  it('sin telefono en contexto, el pedido se guarda con telefono null y el cliente no se toca', async () => {
    const urls: string[] = [];
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { urls.push(url); if (url.includes('/pedidos')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    await handler(request(BODY_SIN_TELEFONO), ENV_SB());
    expect(urls.some((u) => u.includes('/clientes'))).toBe(false);
    expect(cuerpos[0][0].telefono).toBeNull();
  });

  // Con 6 de 7 campos informados (falta billing_giro) el upsert de cliente
  // tiene que omitirse por completo, sin que eso afecte al pedido: el correo
  // ya salio y la venta no depende de esta escritura de memoria.
  it('con un campo de facturacion sin informar, no hace upsert de cliente pero el pedido se guarda igual', async () => {
    const urls: string[] = [];
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { urls.push(url); if (url.includes('/pedidos')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    const { billing_giro: _giro, ...billingSinGiro } = billing;
    const body = {
      execution_context: {
        vars: { quote_result: quoteDosProveedores, quote_confirmed: true, quote_customer_name: 'Vicente Pareja', ...billingSinGiro },
        context: { phone_number: '+56 9 4175 7584' },
      },
    };
    await handler(request(body), ENV_SB());
    expect(urls.some((u) => u.includes('/clientes'))).toBe(false);
    expect(urls.some((u) => u.includes('/pedidos'))).toBe(true);
    expect(cuerpos[0]).toHaveLength(2);
  });

  // Hallazgo de la revision final: una re-invocacion (candado D1 = 'duplicate')
  // no puede pisar la fila buena del primer envio. El estado y el email_id de
  // la segunda fila /pedidos tienen que ser los que quedaron en D1 la primera
  // vez, no el literal "duplicate" con email_id null.
  it('la re-invocacion no pisa el email_id del envio real con "duplicate"/null', async () => {
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { if (url.includes('/pedidos')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    const environment = ENV_SB(); // MISMO entorno (mismo D1) para las dos invocaciones
    await handler(request(BODY_DOS_PROVEEDORES), environment);
    await handler(request(BODY_DOS_PROVEEDORES), environment);

    expect(cuerpos).toHaveLength(2);
    for (const fila of cuerpos[1]) {
      expect(fila.estado).toBe('sent');
      expect(fila.email_id).toBe('email-1');
    }
  });
});
