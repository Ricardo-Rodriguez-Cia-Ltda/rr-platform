import { describe, expect, it, vi } from 'vitest';
import type { NormalizedProduct } from '@rr/domain/product';
import {
  GUARDAR_CADA, actualizarBancoFotos, csvFaltantes, imagenValida, productosDesdeCatalogos, rutaFoto,
  type DepsBanco, type ProductoBanco,
} from '../src/fotos/banco.js';
import { indiceVacio } from '../src/fotos/indice.js';

const AHORA = new Date('2026-09-24T12:00:00Z');
const JPG = { bytes: new Uint8Array(4000), contentType: 'image/jpeg' };

function prod(clave: string, extra: Partial<ProductoBanco> = {}): ProductoBanco {
  const [mpn, marca] = clave.split('|');
  return { clave, mpn: mpn.toUpperCase(), marca: marca.toUpperCase(), nombre: `Producto ${mpn}`, proveedores: ['intcomex'], conStock: false, ...extra };
}

function deps(over: Partial<DepsBanco> = {}): DepsBanco {
  return {
    productos: [],
    indice: indiceVacio(),
    guardar: vi.fn(),
    fotosIntcomex: async () => new Map(),
    icecat: async () => ({ motivo: 'no_encontrado' }),
    descargar: async () => JPG,
    subir: async (ruta) => `https://storage/${ruta}`,
    ahora: () => AHORA,
    ...over,
  };
}

describe('validaciones', () => {
  it('imagenValida: tipo de imagen y entre 2 KB y 5 MB', () => {
    expect(imagenValida('image/jpeg', 4000)).toBe(true);
    expect(imagenValida('image/png; charset=binary', 4000)).toBe(true);
    expect(imagenValida('text/html', 4000)).toBe(false);
    expect(imagenValida('image/jpeg', 1000)).toBe(false);
    expect(imagenValida('image/jpeg', 6 * 1024 * 1024)).toBe(false);
  });

  it('rutaFoto arma {marca}/{mpn}.{ext} desde la clave', () => {
    expect(rutaFoto('ce310a|hp', 'image/jpeg')).toBe('hp/ce310a.jpg');
    expect(rutaFoto('ab355nxt07|nexxt', 'image/png')).toBe('nexxt/ab355nxt07.png');
  });
});

describe('actualizarBancoFotos', () => {
  it('Intcomex primero; si no tiene, Icecat', async () => {
    const icecat = vi.fn(async () => ({ url: 'https://icecat/b.jpg' }));
    const d = deps({
      productos: [prod('a1|hp'), prod('b2|hp')],
      fotosIntcomex: async () => new Map([['a1|hp', 'https://intcomex/a.jpg']]),
      icecat,
    });
    const r = await actualizarBancoFotos(d);
    expect(d.indice.fotos['a1|hp']).toEqual({ url: 'https://storage/hp/a1.jpg', fuente: 'intcomex', obtenidaEn: AHORA.toISOString() });
    expect(d.indice.fotos['b2|hp'].fuente).toBe('icecat');
    expect(icecat).toHaveBeenCalledTimes(1);
    expect(icecat).toHaveBeenCalledWith('B2', 'HP');
    expect(r.nuevas).toEqual({ intcomex: 1, icecat: 1 });
  });

  it('no vuelve a tocar lo que ya tiene foto', async () => {
    const d = deps({ productos: [prod('a1|hp')], descargar: vi.fn(async () => JPG) });
    d.indice.fotos['a1|hp'] = { url: 'https://vieja', fuente: 'intcomex', obtenidaEn: 'x' };
    await actualizarBancoFotos(d);
    expect(d.descargar).not.toHaveBeenCalled();
    expect(d.indice.fotos['a1|hp'].url).toBe('https://vieja');
  });

  it('reintenta lo marcado sin foto recien despues de 30 dias', async () => {
    const icecat = vi.fn(async () => ({ motivo: 'no_encontrado' as const }));
    const d = deps({ productos: [prod('a1|hp'), prod('b2|hp')], icecat });
    d.indice.sinFoto['a1|hp'] = { motivo: 'no_encontrado', intentadoEn: '2026-09-10T00:00:00Z' };
    d.indice.sinFoto['b2|hp'] = { motivo: 'no_encontrado', intentadoEn: '2026-08-01T00:00:00Z' };
    await actualizarBancoFotos(d);
    expect(icecat).toHaveBeenCalledTimes(1);
    expect(icecat).toHaveBeenCalledWith('B2', 'HP');
    expect(d.indice.sinFoto['b2|hp'].intentadoEn).toBe(AHORA.toISOString());
  });

  it('reintenta si intentadoEn no se puede interpretar como fecha', async () => {
    const icecat = vi.fn(async () => ({ motivo: 'no_encontrado' as const }));
    const d = deps({ productos: [prod('a1|hp')], icecat });
    d.indice.sinFoto['a1|hp'] = { motivo: 'no_encontrado', intentadoEn: 'basura' };
    await actualizarBancoFotos(d);
    expect(icecat).toHaveBeenCalledTimes(1);
  });

  it('registra el motivo: no_encontrado, icecat_full y descarga_fallida', async () => {
    const d = deps({
      productos: [prod('a1|hp'), prod('b2|cisco'), prod('c3|hp')],
      fotosIntcomex: async () => new Map([['c3|hp', 'https://intcomex/rota.jpg']]),
      icecat: async (mpn) => (mpn === 'B2' ? { motivo: 'icecat_full' } : { motivo: 'no_encontrado' }),
      descargar: async () => ({ bytes: new Uint8Array(10), contentType: 'text/html' }),
    });
    const r = await actualizarBancoFotos(d);
    expect(d.indice.sinFoto['a1|hp'].motivo).toBe('no_encontrado');
    expect(d.indice.sinFoto['b2|cisco'].motivo).toBe('icecat_full');
    expect(d.indice.sinFoto['c3|hp'].motivo).toBe('descarga_fallida');
    expect(r.sinFoto).toEqual({ no_encontrado: 1, icecat_full: 1, descarga_fallida: 1 });
  });

  it('si la foto de Intcomex no baja, prueba Icecat antes de rendirse', async () => {
    const d = deps({
      productos: [prod('a1|hp')],
      fotosIntcomex: async () => new Map([['a1|hp', 'https://intcomex/rota.jpg']]),
      icecat: async () => ({ url: 'https://icecat/ok.jpg' }),
      descargar: async (url) => (url.includes('rota') ? null : JPG),
    });
    await actualizarBancoFotos(d);
    expect(d.indice.fotos['a1|hp'].fuente).toBe('icecat');
  });

  it('Intcomex caido: sigue con Icecat y no marca nada como no_encontrado', async () => {
    const d = deps({
      productos: [prod('a1|hp'), prod('b2|hp')],
      fotosIntcomex: async () => { throw new Error('Intcomex caido'); },
      icecat: async (mpn) => (mpn === 'A1' ? { url: 'https://icecat/a.jpg' } : { motivo: 'no_encontrado' }),
    });
    const r = await actualizarBancoFotos(d);
    expect(r.intcomexCaido).toBe(true);
    expect(d.indice.fotos['a1|hp'].fuente).toBe('icecat');
    expect(d.indice.sinFoto['b2|hp']).toBeUndefined();
    expect(r.pendientes).toBe(1);
  });

  it('Intcomex caido: icecat_full tambien queda pendiente, no se descarta por 30 dias', async () => {
    const d = deps({
      productos: [prod('a1|hp')],
      fotosIntcomex: async () => { throw new Error('Intcomex caido'); },
      icecat: async () => ({ motivo: 'icecat_full' }),
    });
    const r = await actualizarBancoFotos(d);
    expect(d.indice.sinFoto['a1|hp']).toBeUndefined();
    expect(r.pendientes).toBe(1);
  });

  it('Icecat con cuota o 5xx deja la clave pendiente, sin motivo', async () => {
    const d = deps({ productos: [prod('a1|hp')], icecat: async () => ({ reintentar: true }) });
    const r = await actualizarBancoFotos(d);
    expect(d.indice.sinFoto['a1|hp']).toBeUndefined();
    expect(r.pendientes).toBe(1);
  });

  it('sin Icecat configurado, lo que Intcomex no tiene queda no_encontrado', async () => {
    const d = deps({ productos: [prod('a1|hp')], icecat: null });
    await actualizarBancoFotos(d);
    expect(d.indice.sinFoto['a1|hp'].motivo).toBe('no_encontrado');
  });

  it('guarda el indice por lotes y al final', async () => {
    const productos = Array.from({ length: GUARDAR_CADA * 2 + 5 }, (_, i) => prod(`m${i}|hp`));
    const d = deps({ productos });
    await actualizarBancoFotos(d);
    expect(d.guardar).toHaveBeenCalledTimes(3);
  });

  it('respeta el limite de la muestra, con stock primero', async () => {
    const d = deps({ productos: [prod('a1|hp'), prod('b2|hp', { conStock: true }), prod('c3|hp')], limite: 1 });
    const r = await actualizarBancoFotos(d);
    expect(r.procesados).toBe(1);
    expect(Object.keys(d.indice.sinFoto)).toEqual(['b2|hp']);
  });

  it('si el storage falla, guarda lo hecho y relanza', async () => {
    const d = deps({
      productos: [prod('a1|hp'), prod('b2|hp')],
      icecat: async () => ({ url: 'https://icecat/x.jpg' }),
      subir: async () => { throw new Error('HTTP 500'); },
      concurrencia: 1,
    });
    await expect(actualizarBancoFotos(d)).rejects.toThrow(/500/);
    expect(d.guardar).toHaveBeenCalled();
  });

  it('si el storage falla, los demas workers paran de tomar items nuevos y se guarda una sola vez', async () => {
    let subidas = 0;
    const subir = vi.fn(async () => {
      subidas++;
      if (subidas === 1) throw new Error('HTTP 500');
      return 'https://storage/ok';
    });
    const descargar = vi.fn(async () => JPG);
    const productos = Array.from({ length: 20 }, (_, i) => prod(`m${i}|hp`));
    const d = deps({
      productos,
      icecat: async () => ({ url: 'https://icecat/x.jpg' }),
      descargar,
      subir,
      concurrencia: 4,
    });
    await expect(actualizarBancoFotos(d)).rejects.toThrow(/500/);
    // Solo los items ya en vuelo al momento del fallo llegan a descargar/subir;
    // no se toman items nuevos despues del aborto.
    expect(descargar.mock.calls.length).toBeLessThanOrEqual(4);
    expect(d.guardar).toHaveBeenCalledTimes(1);
  });
});

describe('productosDesdeCatalogos', () => {
  const p = (sku: string, mpn: string | null, marca: string): NormalizedProduct =>
    ({ sku, mpn, nombre: `N ${sku}`, marca, categoria: null, subcategorias: [], tipo: null });

  it('une por clave, junta proveedores y marca stock si alguno lo tiene', () => {
    const out = productosDesdeCatalogos(
      { intcomex: [p('I1', 'CE310A', 'HP')], tecnoglobal: [p('T1', 'CE-310A', 'HP INC'), p('T2', null, 'HP')] },
      (prov, sku) => prov === 'tecnoglobal' && sku === 'T1',
    );
    expect(out).toEqual([
      { clave: 'ce310a|hp', mpn: 'CE310A', marca: 'HP', nombre: 'N I1', proveedores: ['intcomex', 'tecnoglobal'], conStock: true },
    ]);
  });
});

describe('csvFaltantes', () => {
  it('lista lo que no tiene foto: stock primero, luego mas proveedores', () => {
    const indice = indiceVacio();
    indice.fotos['a1|hp'] = { url: 'x', fuente: 'intcomex', obtenidaEn: 'x' };
    indice.sinFoto['c3|hp'] = { motivo: 'icecat_full', intentadoEn: 'x' };
    const csv = csvFaltantes([
      prod('a1|hp'),
      prod('b2|hp', { proveedores: ['intcomex', 'ingram'] }),
      prod('c3|hp', { conStock: true, nombre: 'Toner "negro", XL' }),
      prod('d4|hp'),
    ], indice);
    expect(csv.split('\n')).toEqual([
      'clave,mpn,marca,nombre,proveedores,con_stock,motivo',
      'c3|hp,C3,HP,"Toner ""negro"", XL",intcomex,si,icecat_full',
      'b2|hp,B2,HP,Producto b2,intcomex ingram,no,pendiente',
      'd4|hp,D4,HP,Producto d4,intcomex,no,pendiente',
    ]);
  });
});
