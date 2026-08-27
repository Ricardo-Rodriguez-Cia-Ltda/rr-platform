import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetSnapshotForTests,
  cargarCatalogoTecnoglobal,
  getPrice,
  getPrices,
  normalizeProduct,
  tecnoglobal,
  type TecnoglobalProduct,
} from '@rr/providers/tecnoglobal';
import { ProviderError } from '@rr/domain/types';

// Respuesta real de http://200.6.78.34/stock/v1/price, recortada a una muestra
// con stock y sin stock, en oferta y no, con UPC real y con el "0" que usan
// cuando el producto no tiene codigo.
const RESPUESTA = JSON.parse(
  readFileSync('packages/providers/tests/fixtures/tecnoglobal-price.json', 'utf8'),
) as { products: TecnoglobalProduct[] };

const PRODUCTOS = RESPUESTA.products;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// El servicio no busca por MPN ni por UPC: hay que resolverlos contra la foto
// del ultimo volcado y recotizar por el SKU encontrado, para no dar un precio
// que puede tener horas.
function fetchQueResuelvePorFoto(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: URL) => {
    const ultimo = url.pathname.split('/').pop()!;
    if (ultimo === 'price') return response(RESPUESTA);
    const producto = PRODUCTOS.find((p) => p.codigoTg === ultimo);
    return response({ error: false, products: producto ? [producto] : [] });
  });
}

beforeEach(() => {
  // La foto se persiste en disco: sin un directorio propio por test, los
  // precios reales que deja una corrida en vivo se cuelan en la suite.
  vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'tg-')));
  // Valor de mentira con la forma de un MD5. La clave real de Tecnoglobal se
  // manda literal en el Basic auth, o sea que ES la contrasena: no puede vivir
  // en un archivo versionado.
  vi.stubEnv('TECNOGLOBAL_USER', 'usuario');
  vi.stubEnv('TECNOGLOBAL_PASSWORD', '0123456789abcdef0123456789abcdef');
  vi.stubEnv('TECNOGLOBAL_BASE_URL', 'http://tecnoglobal.test/stock/v1/');
  _resetSnapshotForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isConfigured', () => {
  it('es false sin credenciales', () => {
    vi.stubEnv('TECNOGLOBAL_USER', '');
    expect(tecnoglobal.isConfigured()).toBe(false);
  });

  it('es true con usuario y clave', () => {
    expect(tecnoglobal.isConfigured()).toBe(true);
  });
});

describe('autenticacion', () => {
  it('manda Basic con la clave tal cual la entrega TI, sin volver a hashearla', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);

    await cargarCatalogoTecnoglobal();

    const [url, init] = fetchMock.mock.calls[0];
    expect((url as URL).href).toBe('http://tecnoglobal.test/stock/v1/price');
    const expected = Buffer.from('usuario:0123456789abcdef0123456789abcdef').toString('base64');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Basic ${expected}` });
  });
});

describe('normalizeProduct', () => {
  it('mapea los campos de Tecnoglobal a la forma comun', () => {
    expect(normalizeProduct(PRODUCTOS[0])).toEqual({
      sku: 'KN3-661',
      mpn: 'SDS3/128GB',
      nombre: 'Memoria 128GB SD XC Canvas Select Plus Gen3 150MB/',
      marca: 'KINGSTON',
      categoria: 'TG Almacenamiento de datos',
      subcategorias: ['Memoria Flash'],
      tipo: null,
    });
  });

  it('deja la subcategoria vacia cuando no viene', () => {
    expect(normalizeProduct({ codigoTg: 'X1' }).subcategorias).toEqual([]);
  });

  // El MPN es la unica clave de union entre distribuidores: una cadena vacia
  // colandose como MPN emparejaria productos sin relacion.
  it('trata un pnFabricante vacio como ausencia de MPN', () => {
    expect(normalizeProduct({ codigoTg: 'X1', pnFabricante: '   ' }).mpn).toBeNull();
  });
});

describe('cargarCatalogoTecnoglobal', () => {
  it('normaliza el catalogo completo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(RESPUESTA)));

    const catalogo = await cargarCatalogoTecnoglobal();

    expect(catalogo).toHaveLength(PRODUCTOS.length);
    expect(catalogo.map((p) => p.sku)).toEqual(PRODUCTOS.map((p) => p.codigoTg));
  });

  it('rechaza una respuesta sin productos en vez de dejar el catalogo vacio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ error: false, message: 'Articulos no fueron encontrados' })),
    );

    await expect(cargarCatalogoTecnoglobal()).rejects.toThrow();
  });

  it('propaga un HTTP no-2xx como error de proveedor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

    await expect(cargarCatalogoTecnoglobal()).rejects.toThrow(ProviderError);
  });

  // El servicio devuelve 200 con error:true; confiar en el status dejaria
  // entrar un cuerpo de error como si fuera catalogo.
  it('trata error:true como falla aunque el status sea 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ error: true, message: 'Credenciales invalidas' })),
    );

    await expect(cargarCatalogoTecnoglobal()).rejects.toThrow(/Credenciales invalidas/);
  });
});

describe('getPrices', () => {
  it('no llama a la red con la lista vacia', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await getPrices([])).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Una ficha o una cotizacion puntual valen el precio del momento: el
  // volcado se agota en pocas llamadas y ademas puede tener una hora.
  it('un lote chico se consulta SKU por SKU, sin tocar el volcado completo', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      const sku = url.pathname.split('/').pop()!;
      const producto = PRODUCTOS.find((p) => p.codigoTg === sku);
      return response({ error: false, products: producto ? [producto] : [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const precios = await getPrices(['KN3-661', 'TM0-943']);

    const rutas = fetchMock.mock.calls.map((c) => (c[0] as URL).pathname);
    expect(rutas.sort()).toEqual(['/stock/v1/price/KN3-661', '/stock/v1/price/TM0-943']);
    expect(rutas.some((r) => r.endsWith('/v1/price'))).toBe(false);
    expect(precios.get('KN3-661')).toEqual({ price: 21.18, currency: 'USD', inStock: 117 });
  });

  it('omite los SKUs que el proveedor no reconoce', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        const sku = url.pathname.split('/').pop()!;
        const producto = PRODUCTOS.find((p) => p.codigoTg === sku);
        return response(
          producto
            ? { error: false, products: [producto] }
            : { error: false, message: 'Articulos no fueron encontrados' },
        );
      }),
    );

    const precios = await getPrices(['KN3-661', 'NO-EXISTE']);

    expect([...precios.keys()]).toEqual(['KN3-661']);
  });

  it('conserva el stock en cero en vez de descartar el producto', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: false, products: [PRODUCTOS[1]] })),
    );

    const precios = await getPrices(['TM0-943']);

    expect(precios.get('TM0-943')).toEqual({ price: 316.08, currency: 'USD', inStock: 0 });
  });

  it('rechaza un lote mayor al tope declarado', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const demasiados = Array.from({ length: 301 }, (_, i) => `S${i}`);

    await expect(getPrices(demasiados)).rejects.toThrow(/de a 300/);
  });

  it('el tope declarado coincide con el que aplica getPrices', () => {
    expect(tecnoglobal.maxSkusPerBatch).toBe(300);
  });

  // Pedir 25 en vivo son ~37 s contra su servicio: el ranking de una busqueda
  // sale de la foto, y el precio definitivo se confirma con /product.
  it('un lote grande sale de la foto, con una sola llamada', async () => {
    const fetchMock = fetchQueResuelvePorFoto();
    vi.stubGlobal('fetch', fetchMock);

    const precios = await getPrices([...PRODUCTOS.map((p) => p.codigoTg), 'X1', 'X2', 'X3']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].pathname).toBe('/stock/v1/price');
    expect(precios.size).toBe(PRODUCTOS.length);
  });

  // La cuota del volcado es tan estrecha que un refresco rechazado es
  // esperable; quedarse sin precios por eso seria peor que darlos algo viejos.
  it('si el refresco de la foto falla, sigue cotizando con la foto vencida', async () => {
    vi.stubEnv('TECNOGLOBAL_PRECIOS_TTL_MS', '0');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let primera = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (primera) {
          primera = false;
          return response(RESPUESTA);
        }
        return new Response(
          JSON.stringify({ error: true, message: 'Excede la cantidad máx. de consultas' }),
          { status: 401 },
        );
      }),
    );

    const grande = [...PRODUCTOS.map((p) => p.codigoTg), 'X1', 'X2', 'X3'];
    expect((await getPrices(grande)).size).toBe(PRODUCTOS.length);
    expect((await getPrices(grande)).size).toBe(PRODUCTOS.length);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('getPrice', () => {
  it('cotiza por SKU contra el endpoint directo', async () => {
    const fetchMock = vi.fn(async (_url: URL) =>
      response({ error: false, products: [PRODUCTOS[0]] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await getPrice({ sku: 'KN3-661' });

    expect(fetchMock.mock.calls[0][0].pathname).toBe('/stock/v1/price/KN3-661');
    expect(resultado).toEqual({
      provider: 'tecnoglobal',
      sku: 'KN3-661',
      mpn: 'SDS3/128GB',
      description: 'Memoria 128GB SD XC Canvas Select Plus Gen3 150MB/',
      price: 21.18,
      currency: 'USD',
      inStock: 117,
    });
  });

  it('cotiza por MPN resolviendo contra la foto y recotizando por SKU', async () => {
    const fetchMock = fetchQueResuelvePorFoto();
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await getPrice({ mpn: 'C31CJ57012' });

    expect(resultado.sku).toBe('TM0-943');
    const rutas = fetchMock.mock.calls.map((c) => (c[0] as URL).pathname);
    expect(rutas).toEqual(['/stock/v1/price', '/stock/v1/price/TM0-943']);
  });

  it('cotiza por UPC', async () => {
    vi.stubGlobal('fetch', fetchQueResuelvePorFoto());

    const resultado = await getPrice({ upc: '740617348286' });
    expect(resultado.sku).toBe('KN3-661');
  });

  // El "0" del UPC no es un codigo: si contara como tal, cualquier consulta
  // por upc=0 emparejaria un producto al azar.
  it('no empareja por el UPC "0" que usan para los productos sin codigo', async () => {
    vi.stubGlobal('fetch', fetchQueResuelvePorFoto());

    await expect(getPrice({ upc: '0' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('devuelve not_found cuando el SKU no existe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: false, message: 'Articulos no fueron encontrados' })),
    );

    await expect(getPrice({ sku: 'NO-EXISTE' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

// El volcado completo (/price) se agota en pocas llamadas y sigue bloqueado
// bastante mas que los 10 minutos que anuncia; el endpoint por SKU aguanta
// decenas. La foto existe para lo que el servicio no sabe resolver -buscar por
// MPN o UPC- y la deja lista el refresco diario del catalogo.
describe('foto del volcado completo', () => {
  it('el refresco del catalogo deja la foto lista, sin una segunda descarga', async () => {
    const fetchMock = fetchQueResuelvePorFoto();
    vi.stubGlobal('fetch', fetchMock);

    await cargarCatalogoTecnoglobal();
    await getPrice({ mpn: 'C31CJ57012' });

    const volcados = fetchMock.mock.calls.filter((c) => (c[0] as URL).pathname.endsWith('/v1/price'));
    expect(volcados).toHaveLength(1);
  });

  it('vuelve a descargar cuando la foto vencio', async () => {
    vi.stubEnv('TECNOGLOBAL_PRECIOS_TTL_MS', '0');
    const fetchMock = fetchQueResuelvePorFoto();
    vi.stubGlobal('fetch', fetchMock);

    await getPrice({ mpn: 'C31CJ57012' });
    await getPrice({ mpn: 'C31CJ57012' });

    const volcados = fetchMock.mock.calls.filter((c) => (c[0] as URL).pathname.endsWith('/v1/price'));
    expect(volcados).toHaveLength(2);
  });

  it('no dispara descargas en paralelo ante peticiones simultaneas', async () => {
    const fetchMock = fetchQueResuelvePorFoto();
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([getPrice({ mpn: 'C31CJ57012' }), getPrice({ upc: '740617348286' })]);

    const volcados = fetchMock.mock.calls.filter((c) => (c[0] as URL).pathname.endsWith('/v1/price'));
    expect(volcados).toHaveLength(1);
  });

  it('una descarga fallida no deja la foto rota para la siguiente consulta', async () => {
    let primera = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname.endsWith('/v1/price') && primera) {
          primera = false;
          return new Response('boom', { status: 500 });
        }
        return fetchQueResuelvePorFoto()(url);
      }),
    );

    await expect(getPrice({ mpn: 'C31CJ57012' })).rejects.toThrow(ProviderError);
    expect((await getPrice({ mpn: 'C31CJ57012' })).sku).toBe('TM0-943');
  });

  // El limite de cuota llega como 401, igual que unas credenciales malas: si
  // no se distingue, quien lea el log va a rotar llaves que estan bien.
  it('nombra el limite de consultas en vez de reportar un 401 generico', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: true,
              message: 'Acceso denegado. Excede la cantidad máx. de consultas en el tiempo [10 min.]',
            }),
            { status: 401 },
          ),
      ),
    );

    await expect(getPrices(['KN3-661'])).rejects.toThrow(/exceso de llamadas/i);
  });
});

// Una foto vacia vigente devuelve "sin precio" para todo el catalogo sin que
// nada parezca haber fallado; es peor que no tener foto.
describe('una respuesta vacia no queda cacheada como foto', () => {
  it('no deja vigente una foto sin productos', async () => {
    const fetchMock = vi.fn(async (url: URL) =>
      url.pathname.endsWith('/v1/price')
        ? response({ error: false, message: 'Articulos no fueron encontrados' })
        : response({ error: false, products: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(cargarCatalogoTecnoglobal()).rejects.toThrow();

    // La siguiente cotizacion masiva vuelve a intentar la descarga en vez de
    // servir la foto vacia.
    const grande = [...PRODUCTOS.map((p) => p.codigoTg), 'X1', 'X2', 'X3'];
    await expect(getPrices(grande)).rejects.toThrow(ProviderError);
  });
});

// Al reiniciar, el catalogo se recupera de su cache en disco sin gastar una
// descarga, pero la foto arrancaba vacia: la primera busqueda tenia que bajar
// el volcado completo y, con la cuota gastada, respondia 502.
describe('la foto sobrevive a un reinicio', () => {
  it('la persiste en disco al descargarla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(RESPUESTA)));
    await cargarCatalogoTecnoglobal();

    const ruta = join(process.env.CATALOG_CACHE_DIR!, 'tecnoglobal-precios.json');
    const guardada = JSON.parse(readFileSync(ruta, 'utf8'));
    expect(guardada.productos).toHaveLength(PRODUCTOS.length);
    expect(typeof guardada.obtenidaEn).toBe('number');
  });

  it('cotiza desde la foto de disco tras reiniciar, sin volver a descargar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(RESPUESTA)));
    await cargarCatalogoTecnoglobal();

    // Reinicio: se pierde la memoria, queda el disco.
    _resetSnapshotForTests();

    const fetchMock = vi.fn(async () => response(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);
    const grande = [...PRODUCTOS.map((p) => p.codigoTg), 'X1', 'X2', 'X3'];

    expect((await getPrices(grande)).size).toBe(PRODUCTOS.length);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // El caso que provoco el 502: foto de disco vencida y cuota agotada.
  it('con la foto de disco vencida y la cuota agotada, cotiza igual', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(RESPUESTA)));
    await cargarCatalogoTecnoglobal();
    _resetSnapshotForTests();

    vi.stubEnv('TECNOGLOBAL_PRECIOS_TTL_MS', '0');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: true, message: 'Excede la cantidad máx. de consultas' }),
            { status: 401 },
          ),
      ),
    );

    const grande = [...PRODUCTOS.map((p) => p.codigoTg), 'X1', 'X2', 'X3'];
    expect((await getPrices(grande)).size).toBe(PRODUCTOS.length);
    errorSpy.mockRestore();
  });

  it('ignora una foto de disco corrupta en vez de arrastrar el error', async () => {
    writeFileSync(join(process.env.CATALOG_CACHE_DIR!, 'tecnoglobal-precios.json'), 'no json');
    vi.stubGlobal('fetch', vi.fn(async () => response(RESPUESTA)));

    const grande = [...PRODUCTOS.map((p) => p.codigoTg), 'X1', 'X2', 'X3'];
    expect((await getPrices(grande)).size).toBe(PRODUCTOS.length);
  });
});
