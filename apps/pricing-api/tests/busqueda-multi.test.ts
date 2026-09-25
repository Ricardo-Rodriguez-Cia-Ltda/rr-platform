import { describe, expect, it } from 'vitest';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo } from '@rr/domain/types';
import { agruparCoincidencias, elegirGanador } from '../src/handlers/busqueda-multi.js';

function prod(sku: string, mpn: string | null, marca: string | null, nombre = sku): NormalizedProduct {
  return { sku, mpn, nombre, marca, categoria: 'Componentes', subcategorias: [], tipo: null };
}
const precio = (price: number, inStock: number | null): PriceInfo => ({ price, currency: 'USD', inStock });

describe('agruparCoincidencias', () => {
  it('junta el mismo producto de dos mayoristas aunque el MPN venga escrito distinto', () => {
    const grupos = agruparCoincidencias([
      { proveedor: 'intcomex', matches: [{ product: prod('I1', 'BX8071514100F', 'Intel'), score: 5 }] },
      { proveedor: 'ingram', matches: [{ product: prod('G1', 'BX80715-14100F', 'INTEL CORP'), score: 7 }] },
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].score).toBe(7);
    expect(Object.keys(grupos[0].porProveedor).sort()).toEqual(['ingram', 'intcomex']);
    expect(grupos[0].representante.sku).toBe('I1');
  });

  it('sin clave solo entra desde Intcomex, cada uno como grupo propio', () => {
    const grupos = agruparCoincidencias([
      { proveedor: 'intcomex', matches: [{ product: prod('I1', null, 'HP'), score: 3 }, { product: prod('I2', null, null), score: 2 }] },
      { proveedor: 'tecnoglobal', matches: [{ product: prod('T1', null, 'HP'), score: 9 }] },
    ]);
    expect(grupos.map((g) => g.representante.sku)).toEqual(['I1', 'I2']);
  });

  it('ordena por puntaje; en empate respeta el orden de llegada', () => {
    const grupos = agruparCoincidencias([
      { proveedor: 'intcomex', matches: [{ product: prod('I1', 'A1', 'HP'), score: 2 }, { product: prod('I2', 'B2', 'HP'), score: 2 }] },
      { proveedor: 'ingram', matches: [{ product: prod('G3', 'C3', 'HP'), score: 5 }] },
    ]);
    expect(grupos.map((g) => g.representante.sku)).toEqual(['G3', 'I1', 'I2']);
  });
});

describe('elegirGanador', () => {
  const grupo = agruparCoincidencias([
    { proveedor: 'intcomex', matches: [{ product: prod('I1', 'BX8071514100F', 'Intel'), score: 5 }] },
    { proveedor: 'ingram', matches: [{ product: prod('G1', 'BX8071514100F', 'Intel'), score: 5 }] },
  ])[0];

  it('caso real: Ingram con stock gana a Intcomex sin stock', () => {
    const g = elegirGanador(grupo, { intcomex: new Map([['I1', precio(169.23, 0)]]), ingram: new Map([['G1', precio(93.49, 16)]]) });
    expect(g).toMatchObject({ proveedor: 'ingram', sku: 'G1', precio: 93.49, stock: 16, criterio: 'mas_barato_con_stock' });
    expect(g?.producto.sku).toBe('G1');
  });

  it('con stock en los dos gana el mas barato; un mayorista sin precio no participa', () => {
    expect(elegirGanador(grupo, { intcomex: new Map([['I1', precio(90, 3)]]), ingram: new Map([['G1', precio(93, 16)]]) })?.proveedor).toBe('intcomex');
    expect(elegirGanador(grupo, { intcomex: new Map([['I1', precio(169, 0)]]), ingram: new Map() })?.proveedor).toBe('intcomex');
    expect(elegirGanador(grupo, { intcomex: new Map(), ingram: new Map() })).toBeNull();
  });

  it('un precio no positivo no compite', () => {
    expect(elegirGanador(grupo, { intcomex: new Map([['I1', precio(0, 5)]]), ingram: new Map([['G1', precio(93, 0)]]) })?.proveedor).toBe('ingram');
  });

  it('dentro de un mayorista toma su SKU mas barato', () => {
    const dos = agruparCoincidencias([{ proveedor: 'intcomex', matches: [
      { product: prod('I1', 'X1', 'HP'), score: 1 }, { product: prod('I2', 'X-1', 'HP'), score: 1 },
    ] }])[0];
    expect(elegirGanador(dos, { intcomex: new Map([['I1', precio(20, 5)], ['I2', precio(18, 5)]]) })?.sku).toBe('I2');
  });
});
