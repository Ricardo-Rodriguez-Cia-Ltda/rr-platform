import { describe, expect, it } from 'vitest';
import { armarPayloadCotizacion, armarPayloadEmision, validarPedido } from '../src/lib/pedido.js';

const ITEM = { sku: 'A', mpn: 'M-1', marca: 'HP', nombre: 'Prod', cantidad: 2, precioTiendaClp: 1000 };
const BASE = {
  items: [ITEM],
  comprador: { nombre: 'Vicente', telefono: '+56 9 4175 7584', email: 'v@a.cl' },
  sitio_web: '',
  totalConfirmadoClp: 2000,
};

describe('validarPedido', () => {
  it('caso feliz: normaliza el telefono a digitos', () => {
    const r = validarPedido(BASE);
    if ('error' in r) throw new Error(r.error);
    expect(r.comprador.telefono).toBe('56941757584');
    expect(r.facturacion).toBeNull();
  });
  it('honeypot con texto => error (y no dice por que)', () => {
    expect(validarPedido({ ...BASE, sitio_web: 'spam.com' })).toHaveProperty('error');
  });
  it.each([
    ['nombre corto', { nombre: 'V', telefono: '56941757584', email: 'v@a.cl' }],
    ['telefono corto', { nombre: 'Vicente', telefono: '123', email: 'v@a.cl' }],
    ['email sin arroba', { nombre: 'Vicente', telefono: '56941757584', email: 'va.cl' }],
  ])('rechaza %s', (_caso, comprador) => {
    expect(validarPedido({ ...BASE, comprador })).toHaveProperty('error');
  });
  it('facturacion parcial => error; completa => pasa', () => {
    const parcial = { rut: '1-9', razonSocial: '', giro: '', direccion: '', comuna: '', ciudad: '', emailFactura: '' };
    expect(validarPedido({ ...BASE, facturacion: parcial })).toHaveProperty('error');
    const completa = { rut: '1-9', razonSocial: 'Acme', giro: 'Ventas', direccion: 'Calle 1', comuna: 'Ñuñoa', ciudad: 'Santiago', emailFactura: 'f@a.cl' };
    const r = validarPedido({ ...BASE, facturacion: completa });
    if ('error' in r) throw new Error(r.error);
    expect(r.facturacion?.razonSocial).toBe('Acme');
  });
  it('rechaza carro vacio, >10 lineas, cantidad 0 o >20, item sin sku', () => {
    expect(validarPedido({ ...BASE, items: [] })).toHaveProperty('error');
    expect(validarPedido({ ...BASE, items: Array.from({ length: 11 }, (_, i) => ({ ...ITEM, sku: `S${i}` })) })).toHaveProperty('error');
    expect(validarPedido({ ...BASE, items: [{ ...ITEM, cantidad: 0 }] })).toHaveProperty('error');
    expect(validarPedido({ ...BASE, items: [{ ...ITEM, cantidad: 21 }] })).toHaveProperty('error');
    expect(validarPedido({ ...BASE, items: [{ ...ITEM, sku: '' }] })).toHaveProperty('error');
  });
});

describe('payloads', () => {
  it('cotizacion: cart_items con la forma exacta del bot y phone en context', () => {
    const p = armarPayloadCotizacion([ITEM], '56941757584') as any;
    expect(p.execution_context.vars.cart_items).toEqual([{ sku: 'A', mpn: 'M-1', marca: 'HP', cantidad: 2 }]);
    expect(p.execution_context.context.phone_number).toBe('56941757584');
  });
  it('emision: quote_confirmed true; billing_* solo con facturacion', () => {
    const quote = { quote_id: 'q-1', lineas: [], total_clp: 2000 };
    const sin = armarPayloadEmision(quote, { nombre: 'V', telefono: 'x', email: 'e' }, null, '569') as any;
    expect(sin.execution_context.vars.quote_confirmed).toBe(true);
    expect(sin.execution_context.vars.quote_result).toBe(quote);
    expect(sin.execution_context.vars.billing_rut).toBeUndefined();
    const conF = armarPayloadEmision(quote, { nombre: 'V', telefono: 'x', email: 'e' },
      { rut: '1-9', razonSocial: 'Acme', giro: 'G', direccion: 'D', comuna: 'C', ciudad: 'S', emailFactura: 'f@a.cl' }, '569') as any;
    expect(conF.execution_context.vars.billing_razon_social).toBe('Acme');
    expect(conF.execution_context.vars.billing_email).toBe('f@a.cl');
  });
});
