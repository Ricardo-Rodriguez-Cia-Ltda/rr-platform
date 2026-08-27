import { describe, expect, it } from 'vitest';
import { normalizarMoneda } from '@rr/domain/currency';

describe('normalizarMoneda', () => {
  // El caso que motivo esto: la misma moneda con dos etiquetas en una sola
  // respuesta, porque cada proveedor la escribe distinto.
  it('unifica como escriben el dolar los tres proveedores', () => {
    expect(normalizarMoneda('us')).toBe('USD');
    expect(normalizarMoneda('US')).toBe('USD');
    expect(normalizarMoneda('USD')).toBe('USD');
    expect(normalizarMoneda('usd')).toBe('USD');
  });

  it('asume dolar cuando el proveedor no informa moneda', () => {
    expect(normalizarMoneda(null)).toBe('USD');
    expect(normalizarMoneda(undefined)).toBe('USD');
    expect(normalizarMoneda('   ')).toBe('USD');
  });

  // No se traduce nada mas que la forma: si algun dia cotizan en pesos, tiene
  // que verse, no convertirse en dolares por descuido.
  it('deja pasar cualquier otra moneda, solo en mayusculas', () => {
    expect(normalizarMoneda('clp')).toBe('CLP');
    expect(normalizarMoneda('EUR')).toBe('EUR');
  });
});
