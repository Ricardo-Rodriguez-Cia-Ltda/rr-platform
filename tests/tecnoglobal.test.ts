import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  _resetFotoParaTests,
  cargarCatalogoTecnoglobal,
  getPrice,
  getPrices,
  normalizarProducto,
  tecnoglobal,
  type ProductoTecnoglobal,
} from '../lib/providers/tecnoglobal.js';
import { ProviderError } from '../lib/types.js';

// Respuesta real de http://200.6.78.34/stock/v1/price, recortada a una muestra
// con stock y sin stock, en oferta y no, con UPC real y con el "0" que usan
// cuando el producto no tiene codigo.
const RESPUESTA = JSON.parse(
  readFileSync('tests/fixtures/tecnoglobal-price.json', 'utf8'),
) as { products: ProductoTecnoglobal[] };

const PRODUCTOS = RESPUESTA.products;

function respuesta(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubEnv('TECNOGLOBAL_USER', 'usuario');
  vi.stubEnv('TECNOGLOBAL_PASSWORD', 'a6deb7170539fa7cf45c44b0d3505a8c');
  vi.stubEnv('TECNOGLOBAL_BASE_URL', 'http://tecnoglobal.test/stock/v1/');
  _resetFotoParaTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('estaConfigurado', () => {
  it('es false sin credenciales', () => {
    vi.stubEnv('TECNOGLOBAL_USER', '');
    expect(tecnoglobal.estaConfigurado()).toBe(false);
  });

  it('es true con usuario y clave', () => {
    expect(tecnoglobal.estaConfigurado()).toBe(true);
  });
});

describe('autenticacion', () => {
  it('manda Basic con la clave tal cual la entrega TI, sin volver a hashearla', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);

    await cargarCatalogoTecnoglobal();

    const [url, init] = fetchMock.mock.calls[0];
    expect((url as URL).href).toBe('http://tecnoglobal.test/stock/v1/price');
    const esperado = Buffer.from('usuario:a6deb7170539fa7cf45c44b0d3505a8c').toString('base64');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Basic ${esperado}` });
  });
});

describe('normalizarProducto', () => {
  it('mapea los campos de Tecnoglobal a la forma comun', () => {
    expect(normalizarProducto(PRODUCTOS[0])).toEqual({
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
    expect(normalizarProducto({ codigoTg: 'X1' }).subcategorias).toEqual([]);
  });

  // El MPN es la unica clave de union entre distribuidores: una cadena vacia
  // colandose como MPN emparejaria productos sin relacion.
  it('trata un pnFabricante vacio como ausencia de MPN', () => {
    expect(normalizarProducto({ codigoTg: 'X1', pnFabricante: '   ' }).mpn).toBeNull();
  });
});

describe('cargarCatalogoTecnoglobal', () => {
  it('normaliza el catalogo completo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(RESPUESTA)));

    const catalogo = await cargarCatalogoTecnoglobal();

    expect(catalogo).toHaveLength(PRODUCTOS.length);
    expect(catalogo.map((p) => p.sku)).toEqual(PRODUCTOS.map((p) => p.codigoTg));
  });

  it('rechaza una respuesta sin productos en vez de dejar el catalogo vacio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respuesta({ error: false, message: 'Articulos no fueron encontrados' })),
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
      vi.fn().mockResolvedValue(respuesta({ error: true, message: 'Credenciales invalidas' })),
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

  it('pide el catalogo completo y filtra los SKUs pedidos', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);

    const precios = await getPrices(['KN3-661', 'TM0-943', 'NO-EXISTE']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][0] as URL).href).toMatch(/\/price$/);
    expect([...precios.keys()].sort()).toEqual(['KN3-661', 'TM0-943']);
  });

  it('conserva el stock en cero en vez de descartar el producto', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(RESPUESTA)));

    const precios = await getPrices(['TM0-943', 'KN3-661']);

    expect(precios.get('TM0-943')).toEqual({ price: 316.08, currency: 'USD', inStock: 0 });
  });
});

describe('getPrice', () => {
  it('cotiza por SKU', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(RESPUESTA)));

    expect(await getPrice({ sku: 'KN3-661' })).toEqual({
      provider: 'tecnoglobal',
      sku: 'KN3-661',
      mpn: 'SDS3/128GB',
      description: 'Memoria 128GB SD XC Canvas Select Plus Gen3 150MB/',
      price: 21.18,
      currency: 'USD',
      inStock: 117,
    });
  });

  it('cotiza por MPN recorriendo el catalogo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(RESPUESTA)));

    const resultado = await getPrice({ mpn: 'C31CJ57012' });
    expect(resultado.sku).toBe('TM0-943');
  });

  it('cotiza por UPC', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(RESPUESTA)));

    const resultado = await getPrice({ upc: '740617348286' });
    expect(resultado.sku).toBe('KN3-661');
  });

  // El "0" del UPC no es un codigo: si contara como tal, cualquier consulta
  // por upc=0 emparejaria un producto al azar.
  it('no empareja por el UPC "0" que usan para los productos sin codigo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(RESPUESTA)));

    await expect(getPrice({ upc: '0' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('devuelve not_found cuando el SKU no existe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(RESPUESTA)));

    await expect(getPrice({ sku: 'NO-EXISTE' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

// Tecnoglobal corta el acceso por cantidad de consultas en 10 minutos y no
// tiene endpoint de precios por lote: sin foto en memoria, una sola busqueda
// nos deja sin cuota.
describe('foto de precios en memoria', () => {
  it('cotiza varias veces con una sola descarga mientras la foto esta vigente', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);

    await getPrices(['KN3-661']);
    await getPrices(['TM0-943']);
    await getPrice({ sku: 'KN3-661' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('vuelve a descargar cuando la foto vencio', async () => {
    vi.stubEnv('TECNOGLOBAL_PRECIOS_TTL_MS', '0');
    const fetchMock = vi.fn(async () => respuesta(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);

    await getPrices(['KN3-661']);
    await getPrices(['KN3-661']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('no dispara descargas en paralelo ante peticiones simultaneas', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([getPrices(['KN3-661']), getPrices(['TM0-943']), getPrice({ sku: 'AUD-027' })]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el refresco del catalogo deja la foto lista, sin una segunda descarga', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);

    await cargarCatalogoTecnoglobal();
    await getPrices(['KN3-661']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('una descarga fallida no deja la foto rota para la siguiente consulta', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValue(respuesta(RESPUESTA));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPrices(['KN3-661'])).rejects.toThrow(ProviderError);
    expect((await getPrices(['KN3-661'])).get('KN3-661')).toBeDefined();
  });

  // El limite de cuota llega como 401, igual que unas credenciales malas: si
  // no se distingue, quien lea el log va a rotar llaves que estan bien.
  it('nombra el limite de consultas en vez de reportar un 401 generico', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
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
