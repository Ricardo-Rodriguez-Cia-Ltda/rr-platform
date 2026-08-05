import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ProviderError } from '../lib/types.js';

const getPriceMock = vi.fn();

vi.mock('../lib/providers/intcomex.js', () => ({
  intcomex: {
    name: 'intcomex',
    getPrice: (query: unknown) => getPriceMock(query),
  },
}));

const { default: handler } = await import('../api/price.js');

function makeReq(
  query: Record<string, string | string[]>,
  headers: Record<string, string> = {},
): VercelRequest {
  return { query, headers } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as VercelResponse & { statusCode: number; body: unknown };
}

const AUTH = { 'x-api-key': 'test-secret' };

describe('GET /api/price', () => {
  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    getPriceMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 without x-api-key', async () => {
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'unauthorized' });
  });

  it('returns 401 with wrong x-api-key', async () => {
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }, { 'x-api-key': 'nope' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when no identifier is given', async () => {
    const res = makeRes();
    await handler(makeReq({}, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  it('returns 400 when more than one identifier is given', async () => {
    const res = makeRes();
    await handler(makeReq({ sku: 'X', mpn: 'Y' }, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an unknown provider', async () => {
    const res = makeRes();
    await handler(makeReq({ sku: 'X', provider: 'nadie' }, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with the provider result', async () => {
    const result = {
      provider: 'intcomex',
      sku: 'SE001MSE01',
      mpn: 'AAA-01148',
      description: 'Microsoft Access 2013',
      price: 103.5294,
      currency: 'US',
      inStock: 203,
    };
    getPriceMock.mockResolvedValue(result);

    const res = makeRes();
    await handler(makeReq({ mpn: 'AAA-01148' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(result);
    expect(getPriceMock).toHaveBeenCalledWith({ sku: undefined, mpn: 'AAA-01148', upc: undefined });
  });

  it('maps ProviderError not_found to 404', async () => {
    getPriceMock.mockRejectedValue(new ProviderError('not_found', 'Product not found at Intcomex'));
    const res = makeRes();
    await handler(makeReq({ sku: 'NOPE' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('maps ProviderError upstream to 502', async () => {
    getPriceMock.mockRejectedValue(new ProviderError('upstream', 'Intcomex responded with HTTP 500'));
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }, AUTH), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: 'upstream', detail: 'Intcomex responded with HTTP 500' });
  });

  it('surfaces ProviderError.detail when present', async () => {
    getPriceMock.mockRejectedValue(
      new ProviderError('upstream', 'Intcomex responded with HTTP 500', 'kaboom'),
    );
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }, AUTH), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: 'upstream', detail: 'kaboom' });
  });

  it('returns 405 for non-GET methods', async () => {
    const res = makeRes();
    await handler({ ...makeReq({ sku: 'X' }, AUTH), method: 'POST' } as VercelRequest, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toMatchObject({ error: 'method_not_allowed' });
  });

  it('maps unexpected errors to 502 without leaking details', async () => {
    getPriceMock.mockRejectedValue(new Error('ECONNRESET at secret-host'));
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }, AUTH), res);
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
  });
});
