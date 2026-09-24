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
  });

  it('una subida rechazada lanza con el status', async () => {
    const f = vi.fn(async () => new Response('{"error":"x"}', { status: 401 }));
    await expect(crearStorage({ ...CFG, fetchImpl: f as never }).subir('a/b.jpg', new Uint8Array(), 'image/jpeg'))
      .rejects.toThrow(/401/);
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
