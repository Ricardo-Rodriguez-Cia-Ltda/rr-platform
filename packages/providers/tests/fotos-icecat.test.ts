import { describe, expect, it, vi } from 'vitest';
import { crearIcecat } from '../src/fotos/icecat.js';

function responde(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL) => new Response(JSON.stringify(body), { status }));
}

describe('crearIcecat', () => {
  it('pide con el usuario, marca = primera palabra y MPN sin sufijo regional', async () => {
    const f = responde(200, { data: { Image: { Pic500x500: 'https://images.icecat.biz/img/500.jpg' } } });
    const buscar = crearIcecat('pyxis.latam', f as unknown as typeof fetch);
    await buscar('D66U4AT#ABM', 'Hp Inc');
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://live.icecat.biz/api');
    expect(url.searchParams.get('UserName')).toBe('pyxis.latam');
    expect(url.searchParams.get('Language')).toBe('es');
    expect(url.searchParams.get('Brand')).toBe('Hp');
    expect(url.searchParams.get('ProductCode')).toBe('D66U4AT');
  });

  it('usa Pic500x500 y cae a HighPic', async () => {
    expect(await crearIcecat('u', responde(200, { data: { Image: { Pic500x500: 'https://a/500.jpg', HighPic: 'https://a/hi.jpg' } } }) as never)('X', 'HP'))
      .toEqual({ url: 'https://a/500.jpg' });
    expect(await crearIcecat('u', responde(200, { data: { Image: { HighPic: 'https://a/hi.jpg' } } }) as never)('X', 'HP'))
      .toEqual({ url: 'https://a/hi.jpg' });
  });

  it('404 es no_encontrado, 403 es icecat_full, 200 sin imagen es no_encontrado', async () => {
    expect(await crearIcecat('u', responde(404, { Code: 404 }) as never)('X', 'HP')).toEqual({ motivo: 'no_encontrado' });
    expect(await crearIcecat('u', responde(403, { Code: 403 }) as never)('X', 'HP')).toEqual({ motivo: 'icecat_full' });
    expect(await crearIcecat('u', responde(200, { data: {} }) as never)('X', 'HP')).toEqual({ motivo: 'no_encontrado' });
  });

  it('cuota, 5xx o red caida se reintentan en otra corrida', async () => {
    expect(await crearIcecat('u', responde(429, {}) as never)('X', 'HP')).toEqual({ reintentar: true });
    expect(await crearIcecat('u', responde(503, {}) as never)('X', 'HP')).toEqual({ reintentar: true });
    const caida = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await crearIcecat('u', caida as never)('X', 'HP')).toEqual({ reintentar: true });
  });
});
