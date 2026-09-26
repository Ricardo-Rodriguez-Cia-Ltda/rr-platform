import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceInfo, Provider } from '@rr/domain/types';
import { getPriceCache, resetPriceCachesForTests } from '@rr/providers/price-cache';
import { cotizarLote } from '../src/handlers/cotizar-lote.js';

const P = (price: number, inStock = 1): PriceInfo => ({ price, currency: 'USD', inStock });

function proveedor(getPrices: (skus: string[]) => Promise<Map<string, PriceInfo>>, lote = 2): Provider {
  return {
    name: 'ingram', maxSkusPerBatch: lote, isConfigured: () => true,
    loadCatalog: async () => [], getPrices: vi.fn(getPrices), getPrice: async () => { throw new Error('no usado'); },
  } as unknown as Provider;
}

beforeEach(() => {
  vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'lote-')));
  resetPriceCachesForTests();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('cotizarLote', () => {
  it('usa el cache fresco sin llamar al mayorista', async () => {
    getPriceCache('ingram').put(new Map([['A', P(10)]]), ['A']);
    const prov = proveedor(async () => new Map());
    const r = await cotizarLote(prov, ['A'], Date.now() + 5000);
    expect(r.precios.get('A')?.price).toBe(10);
    expect(prov.getPrices).not.toHaveBeenCalled();
    expect(r.incompleto).toBe(false);
  });

  it('cotiza lo pendiente en lotes paralelos y lo guarda en cache', async () => {
    const prov = proveedor(async (skus) => new Map(skus.map((s) => [s, P(s.charCodeAt(0))])));
    const r = await cotizarLote(prov, ['A', 'B', 'C', 'A'], Date.now() + 5000);
    expect(prov.getPrices).toHaveBeenCalledTimes(2); // A,B y C (lote de 2, sin duplicados)
    expect([...r.precios.keys()].sort()).toEqual(['A', 'B', 'C']);
    expect(getPriceCache('ingram').get(['C']).fresh.has('C')).toBe(true);
    expect(r.maxAgeMs).toBe(0);
  });

  it('un lote fallido se rescata del cache utilizable; lo que no esta queda incompleto', async () => {
    const cache = getPriceCache('ingram');
    cache.put(new Map([['A', P(10)]]), ['A']);
    // Envejecer la entrada: pasa de fresca (15 min) a utilizable (24 h).
    vi.useFakeTimers({ now: Date.now() + 20 * 60 * 1000, toFake: ['Date'] });
    const prov = proveedor(async () => { throw new Error('caido'); });
    const r = await cotizarLote(prov, ['A', 'B'], Date.now() + 5000);
    expect(r.precios.get('A')?.price).toBe(10);
    expect(r.precios.has('B')).toBe(false);
    expect(r.incompleto).toBe(true);
    expect(r.sinResolver).toEqual(new Set(['B']));
    expect(r.fallaTotal).toBe(true);
    expect(r.maxAgeMs).toBeGreaterThan(15 * 60 * 1000);
  });

  it('un lote que no responde antes del limite se corta', async () => {
    const prov = proveedor(() => new Promise(() => {}));
    const inicio = Date.now();
    const r = await cotizarLote(prov, ['A'], Date.now() + 50);
    expect(Date.now() - inicio).toBeLessThan(2000);
    expect(r.precios.size).toBe(0);
    expect(r.incompleto).toBe(true);
    expect(r.sinResolver).toEqual(new Set(['A']));
  });

  it('sin SKU no llama a nada', async () => {
    const prov = proveedor(async () => new Map());
    expect(await cotizarLote(prov, [], Date.now() + 5000)).toEqual({ precios: new Map(), maxAgeMs: 0, incompleto: false, sinResolver: new Set(), fallaTotal: false });
    expect(prov.getPrices).not.toHaveBeenCalled();
  });
});
