import { describe, expect, it } from 'vitest';
import { armarPayloadEmision, reconstruirQuote, vigenciaUtil } from '../src/pago/quote.js';
import { MARGEN_VIGENCIA_MS } from '../src/pago/mercadopago.js';

const ROW: any = {
  quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  version: '1',
  numero: 1600001,
  telefono: '56941757584',
  total_clp: 1190,
  valida_hasta: '2026-09-10T18:00:00.000Z',
  lineas: [{ proveedor: 'intcomex', cantidad: 1, precio_unitario_usd: 10, subtotal_neto_clp: 1000 }],
  proveedores_incompletos: ['ingram'],
};

describe('reconstruirQuote', () => {
  it('produce los cinco campos que emitir-ordenes-compra lee', () => {
    const q: any = reconstruirQuote(ROW);
    expect(q.quote_id).toBe(ROW.quote_id);
    expect(q.version).toBe('1');
    expect(q.lineas).toEqual(ROW.lineas);
    expect(q.valid_until).toBe(ROW.valida_hasta);
    expect(q.proveedores_incompletos).toEqual(['ingram']);
  });

  it('una fila vieja sin proveedores_incompletos degrada a lista vacia, no a undefined', () => {
    const q: any = reconstruirQuote({ ...ROW, proveedores_incompletos: null });
    expect(q.proveedores_incompletos).toEqual([]);
  });
});

describe('armarPayloadEmision', () => {
  it('manda quote_confirmed true y el telefono en el contexto', () => {
    const p: any = armarPayloadEmision(reconstruirQuote(ROW), {
      quote_customer_name: 'Acme SpA', billing_rut: '76.123.456-7',
    }, '56941757584');
    expect(p.execution_context.vars.quote_confirmed).toBe(true);
    expect(p.execution_context.vars.quote_customer_name).toBe('Acme SpA');
    expect(p.execution_context.vars.billing_rut).toBe('76.123.456-7');
    expect(p.execution_context.vars.quote_result.quote_id).toBe(ROW.quote_id);
    expect(p.execution_context.context.phone_number).toBe('56941757584');
  });

  it('quote_confirmed y quote_result no pueden ser pisados por datos, aunque datos los incluya', () => {
    const quote = reconstruirQuote(ROW);
    const p: any = armarPayloadEmision(quote, {
      quote_customer_name: 'Acme SpA',
      quote_confirmed: false,
      quote_result: { basura: true },
    }, '56941757584');
    // quote_confirmed debe ser true (autoritativa)
    expect(p.execution_context.vars.quote_confirmed).toBe(true);
    // quote_result debe ser el real, no la basura
    expect(p.execution_context.vars.quote_result.quote_id).toBe(ROW.quote_id);
    expect(p.execution_context.vars.quote_result.basura).toBeUndefined();
    // quote_customer_name sí debe pasar desde datos
    expect(p.execution_context.vars.quote_customer_name).toBe('Acme SpA');
  });
});

describe('vigenciaUtil', () => {
  const venceEn = Date.parse(ROW.valida_hasta);

  it('con mas de 15 minutos por delante, hay ventana para pagar', () => {
    expect(vigenciaUtil(ROW.valida_hasta, venceEn - MARGEN_VIGENCIA_MS - 1000)).toBe(true);
  });

  it('justo en el umbral y por debajo, no se crea link', () => {
    expect(vigenciaUtil(ROW.valida_hasta, venceEn - MARGEN_VIGENCIA_MS)).toBe(false);
    expect(vigenciaUtil(ROW.valida_hasta, venceEn)).toBe(false);
    expect(vigenciaUtil(ROW.valida_hasta, venceEn + 1000)).toBe(false);
  });

  it('una fecha ilegible se trata como sin vigencia', () => {
    expect(vigenciaUtil('no-es-fecha', Date.now())).toBe(false);
  });
});
