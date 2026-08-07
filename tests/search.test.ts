import { describe, expect, it } from 'vitest';
import { buscar, calcularFacetas, normalizar, tokenizar } from '../lib/search.js';
import type { CatalogProduct } from '../lib/search.js';

function producto(
  Sku: string,
  Mpn: string,
  Description: string,
  marca: string,
  categoria = 'Computadores',
): CatalogProduct {
  return {
    Sku,
    Mpn,
    Description,
    Brand: { Description: marca },
    Category: { Description: categoria, Subcategories: [] },
  };
}

const CATALOGO: CatalogProduct[] = [
  producto('MT027DEL20', 'P2725HE', 'Dell P2725HE - 27" - 1920 x 1080 - IPS - USB-C', 'Dell', 'Monitores'),
  producto('NT016HPQ53', '2N6G5LT#ABM', 'HP ProBook 640 G8 - Notebook - 14" - Intel Core i7', 'HP'),
  producto('100016385', '4P5H8AA', 'HyperX CloudX Gaming - Auricular - tamaño completo - cableado', 'HyperX', 'Audio'),
  producto('ID020LOG11', '920-008813', 'Logitech K380 - Teclado - inalámbrico - Bluetooth', 'Logitech', 'Accesorios'),
];

describe('normalizar', () => {
  it('pasa a minúsculas y quita tildes', () => {
    expect(normalizar('Inalámbrico ÑOÑO')).toBe('inalambrico nono');
  });
});

describe('tokenizar', () => {
  it('parte en palabras completas descartando puntuación', () => {
    expect(tokenizar('HP ProBook 640 G8 - 14"')).toEqual(['hp', 'probook', '640', 'g8', '14']);
  });
});

describe('buscar', () => {
  it('no devuelve HyperX al buscar hp (palabras completas, no subcadenas)', () => {
    const skus = buscar(CATALOGO, { q: 'hp' }).map((r) => r.product.Sku);
    expect(skus).toContain('NT016HPQ53');
    expect(skus).not.toContain('100016385');
  });

  it('encuentra el monitor Dell aunque su descripción no diga "monitor"', () => {
    const skus = buscar(CATALOGO, { q: 'monitor dell 27' }).map((r) => r.product.Sku);
    expect(skus[0]).toBe('MT027DEL20');
  });

  it('encuentra "inalámbrico" buscando sin tilde', () => {
    const skus = buscar(CATALOGO, { q: 'teclado logitech inalambrico' }).map((r) => r.product.Sku);
    expect(skus[0]).toBe('ID020LOG11');
  });

  it('da la máxima prioridad a una coincidencia exacta de MPN', () => {
    const resultados = buscar(CATALOGO, { q: 'P2725HE' });
    expect(resultados[0].product.Sku).toBe('MT027DEL20');
    expect(resultados[0].score).toBeGreaterThanOrEqual(100);
  });

  it('ordena por cantidad de términos coincidentes', () => {
    const resultados = buscar(CATALOGO, { q: 'hp probook notebook' });
    expect(resultados[0].product.Sku).toBe('NT016HPQ53');
  });

  it('filtra por marca sin considerarla en el puntaje de texto', () => {
    const skus = buscar(CATALOGO, { q: 'notebook', marca: 'HP' }).map((r) => r.product.Sku);
    expect(skus).toEqual(['NT016HPQ53']);
  });

  it('filtra por categoría', () => {
    const skus = buscar(CATALOGO, { q: 'dell', categoria: 'Monitores' }).map((r) => r.product.Sku);
    expect(skus).toEqual(['MT027DEL20']);
  });

  it('devuelve vacío cuando ningún término calza', () => {
    expect(buscar(CATALOGO, { q: 'tractor agricola' })).toEqual([]);
  });

  it('reconoce MPN exacto con puntuación (#)', () => {
    const resultados = buscar(CATALOGO, { q: '2N6G5LT#ABM' });
    expect(resultados[0].product.Sku).toBe('NT016HPQ53');
    expect(resultados[0].score).toBeGreaterThanOrEqual(100);
  });

  it('reconoce MPN exacto con guión (-)', () => {
    const resultados = buscar(CATALOGO, { q: '920-008813' });
    expect(resultados[0].product.Sku).toBe('ID020LOG11');
    expect(resultados[0].score).toBeGreaterThanOrEqual(100);
  });

  it('MPN exacto con puntuación recibe el bonus', () => {
    const resultados = buscar(CATALOGO, { q: '2N6G5LT#ABM' });
    expect(resultados[0].product.Sku).toBe('NT016HPQ53');
    expect(resultados[0].score).toBeGreaterThanOrEqual(100);
  });
});

describe('calcularFacetas', () => {
  it('cuenta marcas y categorías presentes, ordenadas por frecuencia', () => {
    const facetas = calcularFacetas([CATALOGO[1], CATALOGO[1], CATALOGO[0]]);
    expect(facetas.marca[0]).toEqual({ valor: 'HP', n: 2 });
    expect(facetas.marca).toContainEqual({ valor: 'Dell', n: 1 });
    expect(facetas.categoria[0]).toEqual({ valor: 'Computadores', n: 2 });
  });
});
