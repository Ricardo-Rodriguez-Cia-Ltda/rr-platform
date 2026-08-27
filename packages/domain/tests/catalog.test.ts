import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CatalogUnavailableError,
  cargarCatalogo,
  obtenerCatalogo,
  _resetCatalogoParaTests,
} from '@rr/domain/catalog';

// Lo que devuelve la red viene crudo de Intcomex; lo que queda en disco y en
// memoria ya esta normalizado. Mezclar las dos formas esconde justo el paso
// que el catalogo delega en el proveedor.
const CRUDOS = [
  { Sku: 'A1', Mpn: 'M1', Description: 'Producto uno', Brand: { Description: 'HP' } },
  { Sku: 'B2', Mpn: 'M2', Description: 'Producto dos', Brand: { Description: 'Dell' } },
];

const ITEMS = [
  { sku: 'A1', mpn: 'M1', nombre: 'Producto uno', marca: 'HP', categoria: null, subcategorias: [], tipo: null },
  { sku: 'B2', mpn: 'M2', nombre: 'Producto dos', marca: 'Dell', categoria: null, subcategorias: [], tipo: null },
];

let cacheDir: string;
let cachePath: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cat-'));
  cachePath = join(cacheDir, 'catalog-intcomex.json');
  vi.stubEnv('CATALOG_CACHE_DIR', cacheDir);
  vi.stubEnv('INTCOMEX_API_KEY', 'pub');
  vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret-key');
  vi.stubEnv('INTCOMEX_BASE_URL', 'https://intcomex-prod.apigee.net/v1/');
  _resetCatalogoParaTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('obtenerCatalogo', () => {
  it('lanza CatalogUnavailableError si aún no se cargó', () => {
    expect(() => obtenerCatalogo('intcomex')).toThrow(CatalogUnavailableError);
  });
});

describe('cargarCatalogo', () => {
  it('descarga getcatalog, lo persiste en disco y lo deja en memoria', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(CRUDOS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await cargarCatalogo('intcomex');

    expect(catalogo).toEqual(ITEMS);
    expect((fetchMock.mock.calls[0][0] as URL).href).toContain('/v1/getcatalog');
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).productos).toEqual(ITEMS);
    expect(obtenerCatalogo('intcomex')).toEqual(ITEMS);
  });

  it('usa el caché de disco sin llamar a la red si tiene menos de 24 horas', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ descargadoEn: new Date().toISOString(), productos: ITEMS }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await cargarCatalogo('intcomex');

    expect(catalogo).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('vuelve a descargar si el caché tiene más de 24 horas', async () => {
    const viejo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ descargadoEn: viejo, productos: [] }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(CRUDOS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await cargarCatalogo('intcomex');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(catalogo).toHaveLength(2);
  });

  it('si la descarga falla pero hay caché vencido en disco, lo usa igual', async () => {
    const viejo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ descargadoEn: viejo, productos: ITEMS }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    const catalogo = await cargarCatalogo('intcomex');

    expect(catalogo).toHaveLength(2);
  });

  it('rechaza una respuesta 200 que no es un arreglo (p.ej. rate limit de apigee) y no pisa el caché vigente en disco', async () => {
    const viejo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ descargadoEn: viejo, productos: ITEMS }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Message: 'Rate limit exceeded' }), { status: 200 }),
      ),
    );

    const catalogo = await cargarCatalogo('intcomex');

    // Cae al fallback del caché vencido, no al objeto envenenado.
    expect(catalogo).toEqual(ITEMS);
    expect(obtenerCatalogo('intcomex')).toEqual(ITEMS);

    // El archivo en disco sigue siendo el caché viejo válido: no se sobrescribió
    // con el objeto de error ni con una marca de tiempo fresca.
    const enDisco = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(enDisco.descargadoEn).toBe(viejo);
    expect(enDisco.productos).toEqual(ITEMS);
  });

  it('rechaza un arreglo vacío como catálogo válido', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));

    await expect(cargarCatalogo('intcomex')).rejects.toThrow();
    expect(() => obtenerCatalogo('intcomex')).toThrow(CatalogUnavailableError);
  });

  it('una respuesta no-arreglo sin caché de respaldo se propaga como error (no queda catálogo envenenado en memoria)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Message: 'Rate limit exceeded' }), { status: 200 }),
      ),
    );

    await expect(cargarCatalogo('intcomex')).rejects.toThrow();
    expect(() => obtenerCatalogo('intcomex')).toThrow(CatalogUnavailableError);
  });

  it('cachea cada proveedor en su propio archivo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(CRUDOS), { status: 200 })),
    );
    await cargarCatalogo('intcomex');
    expect(existsSync(join(cacheDir, 'catalog-intcomex.json'))).toBe(true);
  });

  it('un proveedor cargado no deja disponible a otro', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(CRUDOS), { status: 200 })),
    );
    await cargarCatalogo('intcomex');
    expect(obtenerCatalogo('intcomex')).toHaveLength(2);
    expect(() => obtenerCatalogo('ingram')).toThrow(CatalogUnavailableError);
  });

  it('lanza para un proveedor que no existe', async () => {
    await expect(cargarCatalogo('nadie')).rejects.toThrow();
  });
});
