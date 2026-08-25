import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchConTimeout, timeoutProveedor } from '../lib/http.js';

// Un servidor que acepta la conexion y nunca contesta: es el proveedor
// colgado, que es distinto del proveedor caido. El caido ya estaba cubierto
// —la conexion falla y se propaga—; el colgado dejaba la peticion esperando
// para siempre, y con ella la comparacion de precios entera.
let servidor: Server;
let base: string;

beforeAll(async () => {
  servidor = createServer(() => {
    // A proposito: nunca se responde ni se cierra.
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  servidor.closeAllConnections();
  await new Promise((resolve) => servidor.close(resolve));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('timeoutProveedor', () => {
  it('usa 20 segundos por defecto', () => {
    expect(timeoutProveedor()).toBe(20_000);
  });

  it('se puede ajustar por entorno', () => {
    vi.stubEnv('PROVEEDOR_TIMEOUT_MS', '5000');
    expect(timeoutProveedor()).toBe(5000);
  });

  // Un valor invalido no debe dejar la peticion sin tope: se cae al default.
  it.each(['0', '-1', 'abc', ''])('ignora el valor invalido %s', (valor) => {
    vi.stubEnv('PROVEEDOR_TIMEOUT_MS', valor);
    expect(timeoutProveedor()).toBe(20_000);
  });
});

describe('fetchConTimeout', () => {
  it('aborta contra un servidor que nunca responde', async () => {
    vi.stubEnv('PROVEEDOR_TIMEOUT_MS', '300');

    const inicio = Date.now();
    await expect(fetchConTimeout(`${base}/cuelga`)).rejects.toThrow();

    // Lo que se verifica es que corte, no cuanto tarda exactamente.
    expect(Date.now() - inicio).toBeLessThan(5000);
  });

  it('no estorba una respuesta normal', async () => {
    const rapido = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => rapido.listen(0, '127.0.0.1', resolve));
    const puerto = (rapido.address() as AddressInfo).port;

    const res = await fetchConTimeout(`http://127.0.0.1:${puerto}/`);
    expect(await res.text()).toBe('ok');

    rapido.closeAllConnections();
    await new Promise((resolve) => rapido.close(resolve));
  });
});
