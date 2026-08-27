import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrices } from '../lib/providers/intcomex.js';
import { ProviderError } from '@rr/domain/types';

const IWS_ITEMS = [
  { Sku: 'A1', Mpn: 'M1', Price: { UnitPrice: 10.5, CurrencyId: 'us' }, InStock: 3 },
  { Sku: 'B2', Mpn: 'M2', Price: { UnitPrice: 20, CurrencyId: 'us' }, InStock: 0 },
  { Sku: 'C3', Mpn: 'M3', Price: null, InStock: 5 },
];

describe('getPrices', () => {
  beforeEach(() => {
    vi.stubEnv('INTCOMEX_API_KEY', 'pub');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret-key');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://intcomex-prod.apigee.net/v1/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('requests getproducts with a comma separated skusList and maps the results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(IWS_ITEMS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const prices = await getPrices(['A1', 'B2', 'C3']);

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.href).toContain('/v1/getproducts');
    expect(url.searchParams.get('skusList')).toBe('A1,B2,C3');
    expect(url.searchParams.get('includePriceData')).toBe('true');
    expect(url.searchParams.get('includeInventoryData')).toBe('true');

    // Intcomex manda 'us'; nosotros exponemos ISO 4217, igual que los otros dos.
    expect(prices.get('A1')).toEqual({ price: 10.5, currency: 'USD', inStock: 3 });
    expect(prices.get('B2')).toEqual({ price: 20, currency: 'USD', inStock: 0 });
    // Sin precio: no aparece en el Map.
    expect(prices.has('C3')).toBe(false);
  });

  it('returns an empty map without calling the network for an empty list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const prices = await getPrices([]);

    expect(prices.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects more than 100 skus', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `S${i}`);
    await expect(getPrices(many)).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws upstream on a non-ok response without leaking credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    const error = await getPrices(['A1']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('upstream');
    expect(JSON.stringify(error)).not.toContain('secret-key');
  });
});
