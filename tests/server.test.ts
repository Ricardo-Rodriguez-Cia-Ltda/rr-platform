import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const getPriceMock = vi.fn();

vi.mock('../lib/providers/intcomex.js', () => ({
  intcomex: {
    name: 'intcomex',
    getPrice: (query: unknown) => getPriceMock(query),
  },
}));

const { createApp } = await import('../lib/server.js');

const RESULT = {
  provider: 'intcomex',
  sku: 'SE001MSE01',
  mpn: 'AAA-01148',
  description: 'Microsoft Access 2013',
  price: 103.5294,
  currency: 'US',
  inStock: 203,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('local server adapter', () => {
  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    getPriceMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves GET /api/price end-to-end with query and key', async () => {
    getPriceMock.mockResolvedValue(RESULT);
    const res = await fetch(`${base}/api/price?mpn=AAA-01148`, {
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(RESULT);
    expect(getPriceMock).toHaveBeenCalledWith({ sku: undefined, mpn: 'AAA-01148', upc: undefined });
  });

  it('returns 401 without x-api-key (handler auth reached)', async () => {
    const res = await fetch(`${base}/api/price?sku=X`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${base}/otra-cosa`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('returns 405 for POST (handler method guard reached)', async () => {
    const res = await fetch(`${base}/api/price?sku=X`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(405);
  });

  it('takes the first value of repeated query params', async () => {
    getPriceMock.mockResolvedValue(RESULT);
    const res = await fetch(`${base}/api/price?sku=PRIMERO&sku=SEGUNDO`, {
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(200);
    expect(getPriceMock).toHaveBeenCalledWith({ sku: 'PRIMERO', mpn: undefined, upc: undefined });
  });
});
