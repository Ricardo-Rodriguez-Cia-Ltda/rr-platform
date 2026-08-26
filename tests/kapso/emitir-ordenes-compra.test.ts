import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarHandler, peticion } from './cargar.js';

const handler = cargarHandler('docs/kapso/functions-v2/emitir-ordenes-compra.js');

// D1 falso: guarda filas en un Map y respeta la primary key, que es de donde
// sale la idempotencia real.
function faseD1() {
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
                if (filas.has(clave)) throw new Error('UNIQUE constraint failed');
                filas.set(clave, { order_key: clave, po_id: args[1], status: args[4] });
                return { success: true };
              }
              if (sql.startsWith('UPDATE')) {
                const clave = String(args[args.length - 1]);
                const fila = filas.get(clave);
                if (fila) fila.status = sql.includes("'sent'") ? 'sent' : sql.includes("'failed'") ? 'failed' : fila.status;
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
};

// Cada llamada a env() estrena una base: la idempotencia se prueba compartiendo
// el MISMO entorno entre dos invocaciones, no reusandolo por accidente.
const env = () => ({
  MARGEN: '0.13',
  RESEND_API_KEY: 'key',
  RESEND_FROM_EMAIL: 'ordenes@rr.cl',
  OC_EMAIL_DESTINO: 'pyxis.latam@gmail.com',
  DB: faseD1().db,
});

function vars(extra: Record<string, unknown> = {}) {
  return { quote_result: quote, quote_confirmed: true, quote_customer_name: 'Vicente', billing_rut: '21088369-K', billing_razon_social: 'Acme SpA', billing_email: 'v@acme.cl', ...extra };
}

function resendOk() {
  const spy = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('emitir-ordenes-compra', () => {
  it('emite una orden por mayorista', async () => {
    const spy = resendOk();
    const res = await handler(peticion({ execution_context: { vars: vars() } }), env());
    const datos = await res.json() as any;
    expect(datos.ok).toBe(true);
    expect(datos.vars.purchase_orders_count).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    const proveedores = datos.vars.purchase_orders_result.map((o: { proveedor: string }) => o.proveedor).sort();
    expect(proveedores).toEqual(['ingram', 'tecnoglobal']);
  });

  it('agrupa las lineas del mismo mayorista en una sola orden', async () => {
    resendOk();
    const res = await handler(peticion({ execution_context: { vars: vars() } }), env());
    const datos = await res.json() as any;
    const ingram = datos.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
    expect(ingram.lineas).toBe(2);
  });

  it('reconstruye el costo dividiendo por el margen', async () => {
    const spy = resendOk();
    await handler(peticion({ execution_context: { vars: vars() } }), env());
    const call = spy.mock.calls[0] as any[];
    const cuerpo = JSON.parse(String((call[1] as RequestInit).body));
    // 11.3 / 1.13 = 10.00
    expect(cuerpo.text).toContain('10');
    expect(cuerpo.text).not.toContain('11.3');
  });

  it('usa el sku del proveedor que gana, no el de Intcomex', async () => {
    const spy = resendOk();
    await handler(peticion({ execution_context: { vars: vars() } }), env());
    const cuerpos = spy.mock.calls.map((c: any[]) => String((c[1] as RequestInit).body));
    expect(cuerpos.some((c) => c.includes('ING-1') && c.includes('ING-2'))).toBe(true);
    expect(cuerpos.some((c) => c.includes('TG-9'))).toBe(true);
  });

  it('la segunda ejecucion no reenvia correos', async () => {
    const spy = resendOk();
    const entorno = env();
    await handler(peticion({ execution_context: { vars: vars() } }), entorno);
    expect(spy).toHaveBeenCalledTimes(2);
    const res = await handler(peticion({ execution_context: { vars: vars() } }), entorno);
    const datos = await res.json() as any;
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
    const res = await handler(peticion({ execution_context: { vars: vars() } }), env());
    const datos = await res.json() as any;
    expect(datos.vars.purchase_orders_ok).toBe(false);
    const estados = datos.vars.purchase_orders_result.map((o: { status: string }) => o.status).sort();
    expect(estados).toEqual(['failed', 'sent']);
  });

  it('no emite sin confirmacion del cliente', async () => {
    resendOk();
    const res = await handler(peticion({ execution_context: { vars: vars({ quote_confirmed: false }) } }), env());
    expect(res.status).toBe(400);
  });

  it('no emite sin cotizacion', async () => {
    resendOk();
    const res = await handler(peticion({ execution_context: { vars: { quote_confirmed: true } } }), env());
    expect(res.status).toBe(400);
  });
});
