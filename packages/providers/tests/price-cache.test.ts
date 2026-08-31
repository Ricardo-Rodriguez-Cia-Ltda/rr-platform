import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRESH_MS, PriceCache, USABLE_MS, getPriceCache, resetPriceCachesForTests } from '@rr/providers/price-cache';

const P = { price: 100, currency: 'USD', inStock: 5 };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'price-cache-'));
  vi.stubEnv('CATALOG_CACHE_DIR', dir);
  resetPriceCachesForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('PriceCache: umbrales por edad', () => {
  it('lo recien guardado sale como fresco', () => {
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    const { fresh, usable } = cache.get(['A']);
    expect(fresh.get('A')?.info).toEqual(P);
    expect(usable.size).toBe(0);
  });

  it('pasados 15 minutos deja de ser fresco pero sigue utilizable', () => {
    vi.useFakeTimers();
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    vi.advanceTimersByTime(FRESH_MS + 1000);
    const { fresh, usable } = cache.get(['A']);
    expect(fresh.size).toBe(0);
    expect(usable.get('A')?.info).toEqual(P);
  });

  it('pasadas 24 horas se descarta', () => {
    vi.useFakeTimers();
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    vi.advanceTimersByTime(USABLE_MS + 1000);
    const { fresh, usable } = cache.get(['A']);
    expect(fresh.size).toBe(0);
    expect(usable.size).toBe(0);
  });

  it('una entrada con quotedAt en el futuro se trata como vencida', () => {
    const cache = new PriceCache('intcomex');
    // Se escribe a mano un archivo con fecha futura y se lee con otra instancia.
    cache.put(new Map([['A', P]]), ['A']);
    const raw = JSON.parse(readFileSync(join(dir, 'prices-intcomex.json'), 'utf8'));
    raw.entries.A.quotedAt = Date.now() + 60 * 60 * 1000;
    writeFileSync(join(dir, 'prices-intcomex.json'), JSON.stringify(raw));
    const releida = new PriceCache('intcomex');
    const { fresh, usable } = releida.get(['A']);
    expect(fresh.size + usable.size).toBe(0);
  });
});

describe('PriceCache: negativos', () => {
  it('un SKU pedido que no vino en los resultados se cachea con info null', () => {
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A', 'MUERTO']);
    const { fresh } = cache.get(['MUERTO']);
    expect(fresh.get('MUERTO')?.info).toBeNull();
  });
});

describe('PriceCache: disco', () => {
  it('sobrevive un reinicio: otra instancia lee lo persistido', () => {
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    const releida = new PriceCache('intcomex');
    expect(releida.get(['A']).fresh.get('A')?.info).toEqual(P);
  });

  it('un archivo corrupto parte con cache vacio, sin lanzar', () => {
    writeFileSync(join(dir, 'prices-intcomex.json'), '{esto no es json');
    const cache = new PriceCache('intcomex');
    expect(cache.get(['A']).fresh.size).toBe(0);
  });

  it('escribe via temporal + rename: no queda archivo .tmp tras un put', () => {
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    expect(() => readFileSync(join(dir, 'prices-intcomex.json.tmp'))).toThrow();
  });
});

describe('getPriceCache', () => {
  it('devuelve el mismo singleton por proveedor', () => {
    expect(getPriceCache('intcomex')).toBe(getPriceCache('intcomex'));
    expect(getPriceCache('intcomex')).not.toBe(getPriceCache('ingram'));
  });
});
