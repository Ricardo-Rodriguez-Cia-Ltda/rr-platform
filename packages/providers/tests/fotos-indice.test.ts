import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedProduct } from '@rr/domain/product';
import {
  _resetFotosForTests, fotoDe, guardarIndice, indiceVacio, leerIndice, rutaIndice,
} from '../src/fotos/indice.js';

function producto(mpn: string | null, marca: string | null): NormalizedProduct {
  return { sku: 'S1', mpn, nombre: 'x', marca, categoria: null, subcategorias: [], tipo: null };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fotos-'));
  vi.stubEnv('CATALOG_CACHE_DIR', dir);
  _resetFotosForTests();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('leerIndice / guardarIndice', () => {
  it('un indice ausente o corrupto se lee vacio', () => {
    expect(leerIndice()).toEqual(indiceVacio());
    writeFileSync(rutaIndice(), '{no es json');
    expect(leerIndice()).toEqual(indiceVacio());
  });

  it('guarda y relee lo mismo, sin dejar temporales', () => {
    const indice = indiceVacio();
    indice.fotos['ce310a|hp'] = { url: 'https://x/hp/ce310a.jpg', fuente: 'intcomex', obtenidaEn: '2026-09-24T00:00:00.000Z' };
    guardarIndice(indice);
    expect(leerIndice().fotos['ce310a|hp'].url).toBe('https://x/hp/ce310a.jpg');
    expect(JSON.parse(readFileSync(rutaIndice(), 'utf8')).fotos).toHaveProperty('ce310a|hp');
  });
});

describe('fotoDe', () => {
  it('resuelve por unionKey, aunque el MPN venga escrito distinto', () => {
    const indice = indiceVacio();
    indice.fotos['2n6g5ltabm|hp'] = { url: 'https://x/hp/2n6g5ltabm.jpg', fuente: 'icecat', obtenidaEn: 'x' };
    guardarIndice(indice);
    expect(fotoDe(producto('2N6G5LT#ABM', 'HP Inc.'))).toBe('https://x/hp/2n6g5ltabm.jpg');
    expect(fotoDe(producto('OTRO', 'HP'))).toBeNull();
    expect(fotoDe(producto(null, 'HP'))).toBeNull();
  });

  it('sin indice devuelve null sin lanzar', () => {
    expect(fotoDe(producto('CE310A', 'HP'))).toBeNull();
  });

  it('recarga cuando el archivo cambia, como mucho una vez por minuto', () => {
    vi.useFakeTimers({ now: new Date('2026-09-24T12:00:00Z'), toFake: ['Date'] });
    guardarIndice(indiceVacio());
    expect(fotoDe(producto('CE310A', 'HP'))).toBeNull();

    const indice = indiceVacio();
    indice.fotos['ce310a|hp'] = { url: 'https://x/nueva.jpg', fuente: 'intcomex', obtenidaEn: 'x' };
    guardarIndice(indice);
    const futuro = new Date('2026-09-24T12:05:00Z');
    utimesSync(rutaIndice(), futuro, futuro);

    // Dentro del minuto: sigue con lo cargado.
    expect(fotoDe(producto('CE310A', 'HP'))).toBeNull();
    vi.setSystemTime(new Date('2026-09-24T12:01:01Z'));
    expect(fotoDe(producto('CE310A', 'HP'))).toBe('https://x/nueva.jpg');
  });
});
