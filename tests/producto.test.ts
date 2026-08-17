import { describe, expect, it } from 'vitest';
import { claveUnion, compactarMpn } from '../lib/producto.js';
import type { ProductoNormalizado } from '../lib/producto.js';

function producto(campos: Partial<ProductoNormalizado>): ProductoNormalizado {
  return {
    sku: 'SKU1',
    mpn: null,
    nombre: null,
    marca: null,
    categoria: null,
    subcategorias: [],
    tipo: null,
    ...campos,
  };
}

describe('compactarMpn', () => {
  it('quita puntuacion y mayusculas', () => {
    expect(compactarMpn('2N6G5LT#ABM')).toBe('2n6g5ltabm');
  });

  // El mismo producto viaja escrito distinto entre distribuidores: si la
  // compactacion no los junta, la comparacion de precios nunca los empareja.
  it('iguala las variantes de un mismo MPN', () => {
    expect(compactarMpn('2N6G5LT-ABM')).toBe(compactarMpn('2N6G5LT#ABM'));
    expect(compactarMpn('920-008813')).toBe(compactarMpn('920 008813'));
  });

  it('devuelve vacio para un MPN ausente o sin caracteres utiles', () => {
    expect(compactarMpn(null)).toBe('');
    expect(compactarMpn('   ')).toBe('');
    expect(compactarMpn('---')).toBe('');
  });
});

describe('claveUnion', () => {
  it('combina MPN compactado y marca normalizada', () => {
    expect(claveUnion(producto({ mpn: '2N6G5LT#ABM', marca: 'HP' }))).toBe('2n6g5ltabm|hp');
  });

  it('empareja el mismo producto escrito distinto por dos proveedores', () => {
    const a = producto({ sku: 'NT016HPQ53', mpn: '2N6G5LT#ABM', marca: 'HP' });
    const b = producto({ sku: 'IM-99887', mpn: '2n6g5lt-abm', marca: 'hp' });
    expect(claveUnion(a)).toBe(claveUnion(b));
  });

  it('no empareja el mismo MPN de marcas distintas', () => {
    const a = producto({ mpn: 'X100', marca: 'HP' });
    const b = producto({ mpn: 'X100', marca: 'Dell' });
    expect(claveUnion(a)).not.toBe(claveUnion(b));
  });

  // Decision del spec: sin MPN no se compara. Preferimos perder un match
  // antes que inventarlo: un falso positivo aqui cotiza un producto que no es.
  it('devuelve null cuando no hay MPN', () => {
    expect(claveUnion(producto({ mpn: null, marca: 'HP' }))).toBeNull();
    expect(claveUnion(producto({ mpn: '---', marca: 'HP' }))).toBeNull();
  });

  it('devuelve null cuando no hay marca', () => {
    expect(claveUnion(producto({ mpn: 'X100', marca: null }))).toBeNull();
  });
});
