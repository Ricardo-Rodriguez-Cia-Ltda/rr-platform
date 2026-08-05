import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intcomex } from '../lib/providers/intcomex';
import { ProviderError } from '../lib/types';

const IWS_PRODUCT = {
  Sku: 'SE001MSE01',
  Mpn: 'AAA-01148',
  Description: 'Microsoft Access 2013 - License - 1 PC',
  Price: { UnitPrice: 103.5294, CurrencyId: 'US' },
  InStock: 203,
};

describe('intcomex.getPrice', () => {
  beforeEach(() => {
    vi.stubEnv('INTCOMEX_API_KEY', 'pub-key');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret-key');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://intcomex-test.apigee.net/v1/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('calls /getproduct with the query param and auth header, and normalizes the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(IWS_PRODUCT), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await intcomex.getPrice({ sku: 'SE001MSE01' });

    expect(result).toEqual({
      provider: 'intcomex',
      sku: 'SE001MSE01',
      mpn: 'AAA-01148',
      description: 'Microsoft Access 2013 - License - 1 PC',
      price: 103.5294,
      currency: 'US',
      inStock: 203,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toContain('https://intcomex-test.apigee.net/v1/getproduct');
    expect(url.href).toContain('sku=SE001MSE01');
    expect(url.href).toContain('includePriceData=true');
    expect(url.href).toContain('includeInventoryData=true');
    const auth = new Headers(init.headers).get('authorization') ?? '';
    expect(auth).toMatch(/^Bearer apiKey=pub-key&utcTimeStamp=.+&signature=[0-9a-f]{64}$/);
  });

  it('throws not_found on HTTP 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Code: 20, Message: 'Invalid product.' }), { status: 404 }),
      ),
    );

    await expect(intcomex.getPrice({ mpn: 'NOPE' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('throws not_found when the product has no price data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Sku: 'X', Price: null }), { status: 200 }),
      ),
    );

    await expect(intcomex.getPrice({ sku: 'X' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('throws upstream on HTTP 500 without leaking credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('kaboom', { status: 500 })),
    );

    const error = await intcomex.getPrice({ sku: 'X' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('upstream');
    expect((error as ProviderError).message).not.toContain('secret-key');
    expect((error as ProviderError).detail ?? '').not.toContain('secret-key');
  });

  it('throws upstream when credentials are not configured', async () => {
    vi.stubEnv('INTCOMEX_ACCESS_KEY', '');

    await expect(intcomex.getPrice({ sku: 'X' })).rejects.toMatchObject({
      kind: 'upstream',
    });
  });
});
