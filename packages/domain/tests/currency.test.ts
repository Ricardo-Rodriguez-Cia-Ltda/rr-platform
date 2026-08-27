import { describe, expect, it } from 'vitest';
import { normalizeCurrency } from '@rr/domain/currency';

describe('normalizeCurrency', () => {
  // El caso que motivo esto: la misma moneda con dos etiquetas en una sola
  // respuesta, porque cada proveedor la escribe distinto.
  it('unifica como escriben el dolar los tres proveedores', () => {
    expect(normalizeCurrency('us')).toBe('USD');
    expect(normalizeCurrency('US')).toBe('USD');
    expect(normalizeCurrency('USD')).toBe('USD');
    expect(normalizeCurrency('usd')).toBe('USD');
  });

  it('asume dolar cuando el proveedor no informa moneda', () => {
    expect(normalizeCurrency(null)).toBe('USD');
    expect(normalizeCurrency(undefined)).toBe('USD');
    expect(normalizeCurrency('   ')).toBe('USD');
  });

  // No se traduce nada mas que la forma: si algun dia cotizan en pesos, tiene
  // que verse, no convertirse en dolares por descuido.
  it('deja pasar cualquier otra moneda, solo en mayusculas', () => {
    expect(normalizeCurrency('clp')).toBe('CLP');
    expect(normalizeCurrency('EUR')).toBe('EUR');
  });
});
