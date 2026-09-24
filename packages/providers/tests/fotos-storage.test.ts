import { describe, expect, it, vi } from 'vitest';
import { crearStorage } from '../src/fotos/storage.js';

const CFG = { url: 'https://proyecto.supabase.co/', key: 'service-key' };

describe('crearStorage', () => {
  it('sube con upsert y devuelve la URL publica', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const storage = crearStorage({ ...CFG, fetchImpl: f as unknown as typeof fetch });
    const url = await storage.subir('hp/ce310a.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg');

    expect(url).toBe('https://proyecto.supabase.co/storage/v1/object/public/fotos-productos/hp/ce310a.jpg');
    const [destino, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(destino).toBe('https://proyecto.supabase.co/storage/v1/object/fotos-productos/hp/ce310a.jpg');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer service-key');
    expect(h.apikey).toBe('service-key');
    expect(h['x-upsert']).toBe('true');
    expect(h['content-type']).toBe('image/jpeg');
    expect(h['cache-control']).toBe('max-age=31536000');
  });

  it('una subida rechazada lanza con el status', async () => {
    const f = vi.fn(async () => new Response('{"error":"x"}', { status: 401 }));
    await expect(crearStorage({ ...CFG, fetchImpl: f as never }).subir('a/b.jpg', new Uint8Array(), 'image/jpeg'))
      .rejects.toThrow(/401/);
  });

  it('reintenta tras un error de red y devuelve la URL', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    });
    const esperar = vi.fn(async () => {});
    const url = await crearStorage({ ...CFG, fetchImpl: f as never, esperar }).subir('a/b.jpg', new Uint8Array(), 'image/jpeg');
    expect(url).toBe('https://proyecto.supabase.co/storage/v1/object/public/fotos-productos/a/b.jpg');
    expect(f).toHaveBeenCalledTimes(2);
    expect(esperar).toHaveBeenCalledWith(1000);
  });

  it('un 503 persistente lanza con el status tras 3 intentos', async () => {
    const f = vi.fn(async () => new Response('caido', { status: 503 }));
    const esperar = vi.fn(async () => {});
    await expect(crearStorage({ ...CFG, fetchImpl: f as never, esperar }).subir('a/b.jpg', new Uint8Array(), 'image/jpeg'))
      .rejects.toThrow(/respondio HTTP 503/);
    expect(f).toHaveBeenCalledTimes(3);
    expect(esperar.mock.calls).toEqual([[1000], [3000]]);
  });

  it('un 400 no se reintenta', async () => {
    const f = vi.fn(async () => new Response('mal', { status: 400 }));
    const esperar = vi.fn(async () => {});
    await expect(crearStorage({ ...CFG, fetchImpl: f as never, esperar }).subir('a/b.jpg', new Uint8Array(), 'image/jpeg'))
      .rejects.toThrow(/400/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(esperar).not.toHaveBeenCalled();
  });

  it('un error de red persistente lanza con mensaje claro', async () => {
    const f = vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const esperar = vi.fn(async () => {});
    await expect(crearStorage({ ...CFG, fetchImpl: f as never, esperar }).subir('a/b.jpg', new Uint8Array(), 'image/jpeg'))
      .rejects.toThrow('Supabase Storage no respondio al subir a/b.jpg: The operation was aborted due to timeout');
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('asegurarBucket crea un bucket publico y acepta que ya exista', async () => {
    const f = vi.fn(async () => new Response('{"error":"Duplicate","message":"The resource already exists"}', { status: 409 }));
    await crearStorage({ ...CFG, fetchImpl: f as never }).asegurarBucket();
    const [destino, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(destino).toBe('https://proyecto.supabase.co/storage/v1/bucket');
    expect(JSON.parse(String(init.body))).toEqual({ id: 'fotos-productos', name: 'fotos-productos', public: true });
  });

  it('asegurarBucket lanza ante credenciales invalidas', async () => {
    const f = vi.fn(async () => new Response('{"message":"Invalid JWT"}', { status: 403 }));
    await expect(crearStorage({ ...CFG, fetchImpl: f as never }).asegurarBucket()).rejects.toThrow(/403/);
  });
});
