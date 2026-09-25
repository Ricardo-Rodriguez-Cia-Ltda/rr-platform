import { describe, expect, it } from 'vitest';
import { mensajeError } from '../src/lib/errores-api.js';

describe('mensajeError', () => {
  it('usa faltan cuando viene, antes que cualquier otra cosa', () => {
    expect(mensajeError({ faltan: ['abc123: faltan 2'], error: 'otra_cosa' })).toBe('Falta recibir: abc123: faltan 2');
  });
  it('usa detalle cuando viene y no hay faltan', () => {
    expect(mensajeError({ error: 'faltan_datos', detalle: 'Modalidad y número de pedido del mayorista son obligatorios' }))
      .toBe('Modalidad y número de pedido del mayorista son obligatorios');
  });
  it('mapea los codigos conocidos cuando no hay detalle ni faltan', () => {
    expect(mensajeError({ error: 'courier_sin_modalidad' })).toBe('Este despacho no es por courier: no lleva courier.');
    expect(mensajeError({ error: 'despacho_cerrado' })).toBe('El despacho ya está cerrado; solo se pueden cambiar costo, cobro y nota.');
    expect(mensajeError({ error: 'transicion_invalida' })).toBe('Otro usuario ya cambió este estado. Se recargó la vista.');
    expect(mensajeError({ error: 'pedido_no_pagado' })).toBe('El pedido todavía no está pagado.');
    expect(mensajeError({ error: 'no_admite_recepcion' })).toBe('Esta compra no admite recepciones en su estado actual.');
    expect(mensajeError({ error: 'faltan_datos' })).toBe('Faltan la modalidad y el número de pedido del mayorista.');
    expect(mensajeError({ error: 'upstream' })).toBe('No se pudo conectar con la base. Intenta de nuevo.');
    expect(mensajeError({ error: 'oc_con_despachos' })).toBe('Esta compra ya tiene productos asignados a un despacho. Anula ese despacho primero.');
  });
  it('excede_comprado agrega el pendiente cuando viene', () => {
    expect(mensajeError({ error: 'excede_comprado', pendiente: 3 })).toBe('No se puede recibir más de lo comprado. Quedan 3 por recibir.');
  });
  it('excede_comprado sin pendiente se queda con el mensaje base', () => {
    expect(mensajeError({ error: 'excede_comprado' })).toBe('No se puede recibir más de lo comprado.');
  });
  it('codigo desconocido o ausente cae al generico', () => {
    expect(mensajeError({ error: 'algo_que_no_mapeamos' })).toBe('No se pudo guardar. Intenta de nuevo.');
    expect(mensajeError({})).toBe('No se pudo guardar. Intenta de nuevo.');
  });
});
