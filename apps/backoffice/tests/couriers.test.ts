import { describe, expect, it } from 'vitest';
import { COURIERS, DIRECCION_RETIRO, mensajeCliente } from '../src/lib/couriers.js';

describe('COURIERS.urlSeguimiento', () => {
  it('Starken lleva el numero en la URL', () => {
    expect(COURIERS.starken.urlSeguimiento(' 123456789 ')).toEqual({ url: 'https://www.starken.cl/seguimiento?codigo=123456789', conNumero: true });
  });
  it('Blue Express y Chilexpress dan su pagina sin el numero; otro no da link', () => {
    expect(COURIERS.bluexpress.urlSeguimiento('1')).toEqual({ url: 'https://www.blue.cl/seguimiento/', conNumero: false });
    expect(COURIERS.chilexpress.urlSeguimiento('1')).toEqual({ url: 'https://www.chilexpress.cl/estado-envio-paquete-courier', conNumero: false });
    expect(COURIERS.otro.urlSeguimiento('1')).toBeNull();
  });
  it('sin numero no hay link', () => {
    expect(COURIERS.starken.urlSeguimiento('')).toBeNull();
    expect(COURIERS.bluexpress.urlSeguimiento(' ')).toBeNull();
  });
});

describe('mensajeCliente', () => {
  const p = { numeroCotizacion: 1600010, contacto: 'María López' };
  const base = { courier: null, numero_seguimiento: null, fecha_programada: null } as const;
  it('retiro listo: da la direccion de la oficina', () => {
    const m = mensajeCliente({ ...base, estado: 'listo', modalidad: 'retiro_oficina' }, p);
    expect(m).toBe(`Hola María, tu pedido N° 1600010 está listo para retiro en ${DIRECCION_RETIRO}.`);
  });
  it('courier en ruta: numero y link segun el courier', () => {
    expect(mensajeCliente({ ...base, estado: 'en_ruta', modalidad: 'courier', courier: 'starken', numero_seguimiento: '999' }, p))
      .toBe('Hola María, tu pedido N° 1600010 va en camino por Starken. N° de seguimiento: 999. Síguelo aquí: https://www.starken.cl/seguimiento?codigo=999');
    expect(mensajeCliente({ ...base, estado: 'en_ruta', modalidad: 'courier', courier: 'bluexpress', numero_seguimiento: '999' }, p))
      .toContain('ingresando ese número en https://www.blue.cl/seguimiento/');
  });
  it('despacho propio en ruta, con y sin fecha', () => {
    expect(mensajeCliente({ ...base, estado: 'en_ruta', modalidad: 'propio', fecha_programada: '2026-09-28' }, p))
      .toBe('Hola María, tu pedido N° 1600010 va en camino; te lo entregamos el 28-09-2026.');
    expect(mensajeCliente({ ...base, estado: 'en_ruta', modalidad: 'propio' }, { numeroCotizacion: null, contacto: null }))
      .toBe('Hola, tu pedido va en camino.');
  });
  it('entregado agradece; por_preparar no tiene mensaje', () => {
    expect(mensajeCliente({ ...base, estado: 'entregado', modalidad: 'propio' }, p)).toBe('Hola María, tu pedido N° 1600010 quedó entregado. ¡Gracias por tu compra!');
    expect(mensajeCliente({ ...base, estado: 'por_preparar', modalidad: 'propio' }, p)).toBeNull();
  });
});
