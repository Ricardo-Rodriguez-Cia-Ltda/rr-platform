import { describe, expect, it } from 'vitest';
import { mapaFotosIntcomex } from '../src/fotos/intcomex.js';

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
