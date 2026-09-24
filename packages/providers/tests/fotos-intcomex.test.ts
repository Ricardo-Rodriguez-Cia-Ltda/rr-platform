import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/intcomex.js', () => ({ fetchIws: vi.fn() }));

import { fetchIws } from '../src/intcomex.js';
import { fotosIntcomex, mapaFotosIntcomex } from '../src/fotos/intcomex.js';

// Forma real de downloadextendedcatalog?format=json (medida el 2026-09-22).
const ITEMS = [
  {
    mpn: 'V13H010L57', DescripcionMarca: 'Epson',
    Imagenes: [
      { angulo: null, isMainImage: false, url: 'https://intcomexpim.blob.core.windows.net/assets/images/lateral.jpg' },
      { angulo: null, isMainImage: true, url: 'https://intcomexpim.blob.core.windows.net/assets/images/principal.jpg' },
    ],
  },
  { mpn: 'AB355NXT07', DescripcionMarca: 'Nexxt Solutions Infrastructure',
    Imagenes: [{ isMainImage: false, url: 'https://intcomexpim.blob.core.windows.net/assets/images/unica.png' }] },
  { mpn: 'CE310A', DescripcionMarca: 'HP', Imagenes: [] },
  { mpn: '', DescripcionMarca: 'HP', Imagenes: [{ isMainImage: true, url: 'https://x/sin-mpn.jpg' }] },
  { mpn: 'X1', DescripcionMarca: 'HP', Imagenes: [{ isMainImage: true, url: 'http://inseguro/x.jpg' }] },
];

describe('mapaFotosIntcomex', () => {
  it('toma la imagen principal, o la primera si ninguna lo es', () => {
    const mapa = mapaFotosIntcomex(ITEMS);
    expect(mapa.get('v13h010l57|epson')).toBe('https://intcomexpim.blob.core.windows.net/assets/images/principal.jpg');
    expect(mapa.get('ab355nxt07|nexxt')).toBe('https://intcomexpim.blob.core.windows.net/assets/images/unica.png');
  });

  it('descarta productos sin imagen, sin clave o con URL que no es https', () => {
    const mapa = mapaFotosIntcomex(ITEMS);
    expect(mapa.has('ce310a|hp')).toBe(false);
    expect(mapa.has('x1|hp')).toBe(false);
    expect(mapa.size).toBe(2);
  });

  it('tolera items malformados', () => {
    expect(mapaFotosIntcomex([{}, { Imagenes: 'no-es-arreglo' }, null as never]).size).toBe(0);
  });
});

describe('fotosIntcomex', () => {
  const mock = vi.mocked(fetchIws);
  const responder = (cuerpo: string, status = 200) => mock.mockResolvedValue(new Response(cuerpo, { status }));

  beforeEach(() => mock.mockReset());

  it('un HTTP no ok lanza', async () => {
    responder('caido', 500);
    await expect(fotosIntcomex()).rejects.toThrow(/HTTP 500/);
  });

  it('un JSON invalido lanza', async () => {
    responder('<html>');
    await expect(fotosIntcomex()).rejects.toThrow('El catalogo extendido de Intcomex no es JSON valido');
  });

  it('un payload que no es arreglo lanza', async () => {
    responder('{"error":"x"}');
    await expect(fotosIntcomex()).rejects.toThrow(/no es un arreglo/);
  });

  it('un arreglo vacio cuenta como Intcomex caido', async () => {
    responder('[]');
    await expect(fotosIntcomex()).rejects.toThrow(/vacio/);
  });

  it('items sin ninguna imagen usable lanzan', async () => {
    responder(JSON.stringify([{ mpn: 'CE310A', DescripcionMarca: 'HP', Imagenes: [] }]));
    await expect(fotosIntcomex()).rejects.toThrow(/ninguna imagen/);
  });

  it('un payload valido devuelve el mapa', async () => {
    responder(JSON.stringify(ITEMS));
    const mapa = await fotosIntcomex();
    expect(mapa.size).toBe(2);
    expect(mock).toHaveBeenCalledWith('downloadextendedcatalog', { format: 'json', locale: 'es' });
  });
});
