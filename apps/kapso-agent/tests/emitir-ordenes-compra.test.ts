import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarHandler, peticion } from './load.js';

const handler = cargarHandler('apps/kapso-agent/functions/emitir-ordenes-compra.js');

const MINUTO = 60_000;

// D1 falso: guarda filas en un Map y respeta la primary key, que es de donde
// sale la idempotencia real. `fallaInsert` permite simular un INSERT que
// revienta por algo que NO es la clave duplicada (D1 caida, tabla bloqueada):
// ahi el SELECT no encuentra nada y la reserva idempotente no ocurrio.
function faseD1(opciones: { fallaInsert?: (clave: string) => boolean } = {}) {
  const filas = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith('CREATE')) return { success: true };
              if (sql.startsWith('INSERT')) {
                const clave = String(args[0]);
                if (opciones.fallaInsert?.(clave)) throw new Error('D1_ERROR: database is locked');
                if (filas.has(clave)) throw new Error('UNIQUE constraint failed');
                // El status va literal en el SQL ('processing'); los bind son
                // order_key, po_id, quote_id, version, proveedor, created_at, updated_at.
                filas.set(clave, {
                  order_key: clave,
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
                const clave = String(args[args.length - 1]);
                const fila = filas.get(clave);
                if (fila) {
                  fila.status = sql.includes("'sent'") ? 'sent' : sql.includes("'failed'") ? 'failed' : 'processing';
                  fila.updated_at = args[args.length - 2];
                }
                return { success: true };
              }
              return { success: true };
            },
            async first() {
              return filas.get(String(args[0])) ?? null;
            },
          };
        },
        async run() { return { success: true }; },
      };
    },
  };
  return { db, filas };
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
const env = (db: unknown = faseD1().db) => ({
  MARGEN: '0.13',
  RESEND_API_KEY: 'key',
  RESEND_FROM_EMAIL: 'ordenes@rr.cl',
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

function cuerpos(spy: ReturnType<typeof resendOk>): string[] {
  return spy.mock.calls.map((c: any[]) => String((c[1] as RequestInit).body));
}

async function emitir(entorno: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await handler(peticion({ execution_context: { vars: vars(extra) } }), entorno);
  return { res, datos: (await res.json()) as any };
}

// Recorre recursivamente un valor visitando cada par (clave, valor). Es lo
// unico que detecta una fuga de costo enterrada en un objeto anidado: una
// lista de claves conocidas no ve lo que todavia no existe.
function recorrer(valor: unknown, visita: (clave: string | null, v: unknown) => void, clave: string | null = null): void {
  visita(clave, valor);
  if (Array.isArray(valor)) {
    for (const v of valor) recorrer(v, visita, clave);
    return;
  }
  if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) recorrer(v, visita, k);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('emitir-ordenes-compra', () => {
  it('emite una orden por mayorista', async () => {
    const spy = resendOk();
    const { datos } = await emitir(env());
    expect(datos.ok).toBe(true);
    expect(datos.vars.purchase_orders_count).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    const proveedores = datos.vars.purchase_orders_result.map((o: { proveedor: string }) => o.proveedor).sort();
    expect(proveedores).toEqual(['ingram', 'tecnoglobal']);
  });

  it('agrupa las lineas del mismo mayorista en una sola orden', async () => {
    resendOk();
    const { datos } = await emitir(env());
    const ingram = datos.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
    expect(ingram.lineas).toBe(2);
  });

  it('reconstruye el costo dividiendo por el margen', async () => {
    const spy = resendOk();
    await emitir(env());
    const cuerpo = JSON.parse(cuerpos(spy)[0]);
    // 11.3 / 1.13 = 10.00
    expect(cuerpo.text).toContain('10');
    expect(cuerpo.text).not.toContain('11.3');
  });

  it('usa el sku del proveedor que gana, no el de Intcomex', async () => {
    const spy = resendOk();
    await emitir(env());
    const ingram = cuerpos(spy).find((c) => c.includes('ING-1'));
    const tecno = cuerpos(spy).find((c) => c.includes('TG-9'));
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
    const entorno = env();
    await emitir(entorno);
    expect(spy).toHaveBeenCalledTimes(2);
    const { datos } = await emitir(entorno);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(datos.vars.purchase_orders_result.every((o: { status: string }) => o.status === 'duplicate')).toBe(true);
  });

  it('un correo caido no impide el otro', async () => {
    let llamada = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      llamada += 1;
      return llamada === 1
        ? new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 })
        : new Response(JSON.stringify({ id: 'email-2' }), { status: 200 });
    }));
    const { datos } = await emitir(env());
    expect(datos.vars.purchase_orders_ok).toBe(false);
    const estados = datos.vars.purchase_orders_result.map((o: { status: string }) => o.status).sort();
    expect(estados).toEqual(['failed', 'sent']);
  });

  it('no emite sin confirmacion del cliente', async () => {
    resendOk();
    const { res } = await emitir(env(), { quote_confirmed: false });
    expect(res.status).toBe(400);
  });

  it('no emite sin cotizacion', async () => {
    resendOk();
    const res = await handler(peticion({ execution_context: { vars: { quote_confirmed: true } } }), env());
    expect(res.status).toBe(400);
  });

  it('un fetch lanzado no impide el otro y es reintentable', async () => {
    let llamada = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      llamada += 1;
      if (llamada === 1) throw new Error('Network timeout');
      return new Response(JSON.stringify({ id: 'email-3' }), { status: 200 });
    }));
    const entorno = env();
    const { datos } = await emitir(entorno);
    expect(datos.vars.purchase_orders_ok).toBe(false);
    let resultados = datos.vars.purchase_orders_result;
    expect(resultados.some((o: { proveedor: string; status: string }) => o.proveedor === 'ingram' && o.status === 'failed')).toBe(true);
    expect(resultados.some((o: { proveedor: string; status: string }) => o.proveedor === 'tecnoglobal' && o.status === 'sent')).toBe(true);

    // Reintentar con el MISMO entorno: ingram (que estaba failed) se reintenta y queda sent;
    // tecnoglobal (que estaba sent) queda duplicate
    // (NO reiniciar llamada: el contador persiste, así ingram en la segunda invocación no lanza)
    const { datos: datos2 } = await emitir(entorno);
    resultados = datos2.vars.purchase_orders_result;
    expect(resultados.some((o: { proveedor: string; status: string }) => o.proveedor === 'ingram' && o.status === 'sent')).toBe(true);
    expect(resultados.some((o: { proveedor: string; status: string }) => o.proveedor === 'tecnoglobal' && o.status === 'duplicate')).toBe(true);
  });

  // Hallazgo 1: la idempotencia no puede fallar abierta.
  describe('reserva idempotente', () => {
    it('no manda el correo si el INSERT falla por algo que no es la clave duplicada', async () => {
      const spy = resendOk();
      const { db } = faseD1({ fallaInsert: (clave) => clave.endsWith(':ingram') });
      const { datos } = await emitir(env(db));

      // Sin fila persistida, cada reintento reenviaria la misma orden: hay que
      // abortar esa orden, no seguir hasta Resend.
      expect(cuerpos(spy).some((c) => c.includes('ING-1'))).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(cuerpos(spy)[0]).toContain('TG-9');

      const ingram = datos.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
      expect(ingram.status).not.toBe('sent');
      expect(ingram.status).not.toBe('duplicate');
      expect(datos.vars.purchase_orders_ok).toBe(false);
    });
  });

  // Hallazgo 2: la vigencia se revisa en la function que emite, no solo en el
  // nodo `decide` que corre antes de una conversacion sin limite de tiempo.
  describe('vigencia de la cotizacion', () => {
    it('no emite nada si la cotizacion expiro', async () => {
      const spy = resendOk();
      const vencida = { ...quote, valid_until: new Date(Date.now() - MINUTO).toISOString() };
      const res = await handler(peticion({ execution_context: { vars: vars({ quote_result: vencida }) } }), env());
      expect(res.status).toBe(409);
      expect(spy).not.toHaveBeenCalled();
    });

    it('no emite nada si la cotizacion no trae vigencia', async () => {
      const spy = resendOk();
      const { valid_until: _omitida, ...sinVigencia } = quote;
      const res = await handler(peticion({ execution_context: { vars: vars({ quote_result: sinVigencia }) } }), env());
      expect(res.status).toBe(409);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Hallazgo 3: una fila trabada en `processing` no puede reportarse como exito.
  describe('filas abandonadas en processing', () => {
    const sembrar = (updatedAt: string) => {
      const { db, filas } = faseD1();
      filas.set('q-1:1:ingram', {
        order_key: 'q-1:1:ingram', po_id: 'oc-viejo', quote_id: 'q-1', quote_version: '1',
        proveedor: 'ingram', status: 'processing', created_at: updatedAt, updated_at: updatedAt,
      });
      return db;
    };

    it('reintenta una fila processing que quedo vieja', async () => {
      const spy = resendOk();
      const db = sembrar(new Date(Date.now() - 30 * MINUTO).toISOString());
      const { datos } = await emitir(env(db));
      expect(cuerpos(spy).some((c) => c.includes('ING-1'))).toBe(true);
      const ingram = datos.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
      expect(ingram.status).toBe('sent');
    });

    it('trata como duplicado una fila processing recien creada', async () => {
      const spy = resendOk();
      const db = sembrar(new Date(Date.now() - MINUTO).toISOString());
      const { datos } = await emitir(env(db));
      expect(cuerpos(spy).some((c) => c.includes('ING-1'))).toBe(false);
      const ingram = datos.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
      expect(ingram.status).toBe('duplicate');
    });
  });

  // Hallazgo 4: `quote_confirmed` la escribe un LLM con save_variable, asi que
  // puede llegar como cadena.
  describe('normalizacion de quote_confirmed', () => {
    it.each([true, 'true', 'TRUE', ' true '])('emite con %p', async (valor) => {
      const spy = resendOk();
      const { res } = await emitir(env(), { quote_confirmed: valor });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it.each([false, 'false', '', 'si', 'yes', '1', null, undefined])('no emite con %p', async (valor) => {
      const spy = resendOk();
      const { res } = await emitir(env(), { quote_confirmed: valor });
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Hallazgo 5: la invariante del diseno es que ningun costo vive en una
  // variable que un `get_variable` pueda leer.
  describe('ningun costo sale de la function', () => {
    const costos = () => {
      const valores = new Set<number>();
      const porProveedor = new Map<string, number>();
      for (const linea of quote.lineas) {
        const unitario = Math.round((linea.precio_unitario_usd / 1.13) * 100) / 100;
        const total = Math.round(unitario * linea.cantidad * 100) / 100;
        valores.add(unitario);
        valores.add(total);
        porProveedor.set(linea.proveedor, (porProveedor.get(linea.proveedor) ?? 0) + total);
      }
      for (const total of porProveedor.values()) valores.add(Math.round(total * 100) / 100);
      return valores;
    };

    it('ni las claves ni los valores de la respuesta llevan un costo', async () => {
      resendOk();
      const { datos } = await emitir(env());
      const prohibidos = costos();
      expect(prohibidos.size).toBeGreaterThan(0);

      // El nodo function guarda la respuesta COMPLETA en `purchase_orders_response`
      // (save_response_to), asi que el recorrido cubre el cuerpo entero, no solo `vars`.
      recorrer(datos, (clave, valor) => {
        if (clave) expect(clave, `la clave ${clave} suena a costo`).not.toMatch(/cost|_usd|margen|margin/i);
        if (typeof valor === 'number') {
          expect(prohibidos.has(valor), `el valor ${valor} es un costo reconstruido`).toBe(false);
        }
        // Una cadena que coacciona a un costo es el mismo dato con otra forma.
        // No se busca como substring: los ids y las fechas traen digitos y
        // darian falsos positivos.
        if (typeof valor === 'string' && valor.trim() !== '') {
          expect(prohibidos.has(Number(valor)), `el texto "${valor}" es un costo`).toBe(false);
        }
      });
    });

    it('el correo si lleva el costo: ahi es donde tiene que estar', async () => {
      const spy = resendOk();
      await emitir(env());
      const ingram = cuerpos(spy).find((c) => c.includes('ING-1')) ?? '';
      expect(ingram).toContain('10');
      expect(ingram).toContain('40');
    });
  });

  // Hallazgo 10: un MARGEN vacio coacciona a 0 y dejaria el costo igual al
  // precio de venta.
  it('rechaza un margen de cero', async () => {
    const spy = resendOk();
    const { res } = await emitir({ ...env(), MARGEN: '' });
    expect(res.status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
  });
});
