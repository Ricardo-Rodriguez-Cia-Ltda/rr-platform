import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const getPriceMock = vi.fn();

vi.mock('../lib/providers/intcomex.js', () => ({
  cargarCatalogoIntcomex: async () => [],
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
let port: number;

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
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

  it('responds 500 (not a crash) to a malformed Host header and stays alive', async () => {
    // An empty `Host:` header is now handled gracefully by the `||` fallback (falls back to
    // "localhost" and the request proceeds normally), so it no longer reproduces the crash.
    // A Host value with a space and extra colons still fails `new URL()` construction and
    // exercises the try/catch added around the whole request handler.
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /api/price?sku=X HTTP/1.1\r\nHost: exa mple.com:3000:4000\r\nConnection: close\r\n\r\n',
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });

    expect(response).toMatch(/^HTTP\/1\.1 500/);
    expect(response).toContain('"error":"internal"');

    // The server must still be responsive after the malformed request.
    const res = await fetch(`${base}/api/price?sku=X`);
    expect(res.status).toBe(401);
  });
});

describe('cuerpo JSON en POST /credito/mock', () => {
  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lee el cuerpo del socket y lo entrega parseado al handler', async () => {
    const res = await fetch(`${base}/api/credito/mock`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ rut: '11.111.111-1', total_clp: 12_000_000 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      rut: '111111111',
      aprobado: false,
      disponible_clp: 6_000_000,
      faltante_clp: 6_000_000,
      mock: true,
    });
  });

  it('responde 400 a un cuerpo vacio en vez de colgarse', async () => {
    const res = await fetch(`${base}/api/credito/mock`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(400);
  });

  it('responde 405 a GET sobre la ruta de credito', async () => {
    const res = await fetch(`${base}/api/credito/mock`, { headers: { 'x-api-key': 'test-secret' } });
    expect(res.status).toBe(405);
  });

  it('rechaza un cuerpo sobre el tope antes de llegar al handler', async () => {
    const res = await fetch(`${base}/api/credito/mock`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      body: 'x'.repeat(1_000_001),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('no rompe el 405 de los endpoints GET cuando llega un POST con cuerpo', async () => {
    const res = await fetch(`${base}/api/price?sku=X`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-secret' },
      body: JSON.stringify({ algo: true }),
    });
    expect(res.status).toBe(405);
  });
});

describe('BASE_PATH routing', () => {
  let prefixed: Server;
  let prefixedBase: string;

  beforeAll(async () => {
    vi.stubEnv('BASE_PATH', '/rr/captador-precios');
    prefixed = createApp();
    await new Promise<void>((resolve) => prefixed.listen(0, '127.0.0.1', resolve));
    prefixedBase = `http://127.0.0.1:${(prefixed.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    prefixed.closeAllConnections();
    await new Promise((resolve) => prefixed.close(resolve));
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    getPriceMock.mockReset();
  });

  it('serves the price endpoint under the configured prefix', async () => {
    getPriceMock.mockResolvedValue(RESULT);
    const res = await fetch(`${prefixedBase}/rr/captador-precios/price?sku=SE001MSE01`, {
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
  });

  it('still serves /api/price so Vercel and local stay in parity', async () => {
    getPriceMock.mockResolvedValue(RESULT);
    const res = await fetch(`${prefixedBase}/api/price?sku=SE001MSE01`, {
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(200);
  });

  it('404s a path that only partially matches the prefix', async () => {
    const res = await fetch(`${prefixedBase}/rr/captador-precios/otra`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('enruta /product/{sku} tomando el sku del path', async () => {
    const res = await fetch(`${prefixedBase}/rr/captador-precios/product/HP1`);
    // Sin x-api-key el handler responde 401: basta para probar que enrutó.
    expect(res.status).toBe(401);
  });

  it('404 para /product sin sku en el path', async () => {
    const res = await fetch(`${prefixedBase}/rr/captador-precios/product/`);
    expect(res.status).toBe(404);
  });

  it('sirve /credito/mock bajo el prefijo configurado', async () => {
    const res = await fetch(`${prefixedBase}/rr/captador-precios/credito/mock`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ rut: '111111111', total_clp: 1000 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aprobado: true, mock: true });
  });
});
