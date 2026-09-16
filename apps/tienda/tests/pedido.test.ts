import { describe, expect, it } from 'vitest';
import { armarCuerpoCrearPago, armarPayloadCotizacion, validarPedido } from '../src/lib/pedido.js';

const ITEM = { sku: 'A', mpn: 'M-1', marca: 'HP', nombre: 'Prod', cantidad: 2, precioNetoClp: 840, precioTiendaClp: 1000 };
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
  it.each([
    ['null', null],
    ['string', 'texto'],
    ['undefined', undefined],
  ])('rechaza linea que no es objeto: %s', (_tipo, valor) => {
    expect(validarPedido({ ...BASE, items: [valor] })).toHaveProperty('error');
  });
});

describe('payloads', () => {
  it('cotizacion: cart_items con la forma exacta del bot y phone en context', () => {
    const p = armarPayloadCotizacion([ITEM], '56941757584') as any;
    expect(p.execution_context.vars.cart_items).toEqual([{ sku: 'A', mpn: 'M-1', marca: 'HP', cantidad: 2 }]);
    expect(p.execution_context.context.phone_number).toBe('56941757584');
  });
  it('cuerpo para crear pago: confirmacion booleana, origen tienda y sin facturacion solo billing_email', () => {
    const quote = { quote_id: 'q-1', lineas: [], total_clp: 2000 };
    const sin = armarCuerpoCrearPago(quote, { nombre: 'Vicente', telefono: '56941757584', email: 'comprador@a.cl' }, null);
    expect(sin).toEqual({
      quote_id: 'q-1',
      quote_version: '1',
      quote_confirmed: true,
      origen: 'tienda',
      phone_number: '56941757584',
      customer_name: 'Vicente',
      billing_email: 'comprador@a.cl',
    });
    // Ni phone_number_id (no hay WhatsApp) ni execution_context (no es Kapso).
    expect(sin).not.toHaveProperty('phone_number_id');
    expect(sin).not.toHaveProperty('execution_context');
  });
  it('con facturacion completa viajan los siete billing_*, y billing_email es el de factura', () => {
    const quote = { quote_id: 'q-1', quote_version: 2 };
    const conF = armarCuerpoCrearPago(quote, { nombre: 'V', telefono: '569', email: 'comprador@a.cl' },
      { rut: '1-9', razonSocial: 'Acme', giro: 'G', direccion: 'D', comuna: 'C', ciudad: 'S', emailFactura: 'f@a.cl' });
    expect(conF.quote_version).toBe('2');
    expect(conF.billing_rut).toBe('1-9');
    expect(conF.billing_razon_social).toBe('Acme');
    expect(conF.billing_giro).toBe('G');
    expect(conF.billing_direccion).toBe('D');
    expect(conF.billing_comuna).toBe('C');
    expect(conF.billing_ciudad).toBe('S');
    expect(conF.billing_email).toBe('f@a.cl');
  });
});
