import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  _resetTokenParaTests,
  cargarCatalogoIngram,
  getPrice,
  getPrices,
  ingram,
  normalizarProducto,
  type ProductoIngram,
} from '../lib/providers/ingram.js';
import { ProviderError } from '../lib/types.js';

// Fixtures tomadas de la OpenAPI oficial de Ingram
// (ingrammicro-xvantage/xi-sdk-openapispec). Verifican NUESTRA normalizacion
// contra el contrato publicado; la forma real de la respuesta del tenant de
// Chile queda sin verificar hasta tener credenciales.
const CATALOGO = JSON.parse(readFileSync('tests/fixtures/ingram-catalog.json', 'utf8')) as {
  recordsFound: number;
  catalog: ProductoIngram[];
};
const PRECIOS = JSON.parse(
  readFileSync('tests/fixtures/ingram-priceandavailability.json', 'utf8'),
) as Record<string, unknown>[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function tokenOk(): Response {
  return json({ access_token: 'token-de-prueba', expires_in: '86400' });
}

/** Primera llamada: el token. Las siguientes: lo que se le pase. */
function conToken(...respuestas: Response[]): ReturnType<typeof vi.fn> {
  const cola = [tokenOk(), ...respuestas];
  return vi.fn(async () => cola.shift() ?? json([]));
}

beforeEach(() => {
  vi.stubEnv('INGRAM_CLIENT_ID', 'cliente');
  vi.stubEnv('INGRAM_CLIENT_SECRET', 'secreto');
  vi.stubEnv('INGRAM_CUSTOMER_NUMBER', '20-12345');
  vi.stubEnv('INGRAM_COUNTRY_CODE', 'CL');
  vi.stubEnv('INGRAM_BASE_URL', 'https://ingram.test');
  vi.stubEnv('INGRAM_TOKEN_URL', 'https://ingram.test/oauth/oauth30/token');
  _resetTokenParaTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('estaConfigurado', () => {
  it('es false mientras no lleguen las llaves de Ingram', () => {
    vi.stubEnv('INGRAM_CLIENT_ID', '');
    expect(ingram.estaConfigurado()).toBe(false);
  });

  // El numero de cliente no es opcional: sin el, Ingram rechaza toda consulta
  // de catalogo y precio aunque el token sea valido.
  it('es false si falta el numero de cliente', () => {
    vi.stubEnv('INGRAM_CUSTOMER_NUMBER', '');
    expect(ingram.estaConfigurado()).toBe(false);
  });

  it('es true con client id, secret y numero de cliente', () => {
    expect(ingram.estaConfigurado()).toBe(true);
  });
});

describe('token OAuth', () => {
  it('pide un token client_credentials y lo manda como Bearer', async () => {
    const fetchMock = conToken(json(PRECIOS));
    vi.stubGlobal('fetch', fetchMock);

    await getPrices(['4A0036']);

    const [urlToken, initToken] = fetchMock.mock.calls[0];
    expect(urlToken).toBe('https://ingram.test/oauth/oauth30/token');
    expect((initToken as RequestInit).method).toBe('POST');
    expect(String((initToken as RequestInit).body)).toContain('grant_type=client_credentials');

    const [, initApi] = fetchMock.mock.calls[1];
    expect((initApi as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer token-de-prueba',
      'IM-CustomerNumber': '20-12345',
      'IM-CountryCode': 'CL',
    });
  });

  // Ingram rastrea cada transaccion por este id; repetirlo mezcla peticiones
  // distintas en sus logs y complica cualquier reclamo.
  it('manda un IM-CorrelationID distinto en cada llamada', async () => {
    const fetchMock = conToken(json(PRECIOS), json(PRECIOS));
    vi.stubGlobal('fetch', fetchMock);

    await getPrices(['4A0036']);
    await getPrices(['4A0036']);

    const headers = fetchMock.mock.calls.slice(1).map((c) => (c[1] as RequestInit).headers as Record<string, string>);
    expect(headers[0]['IM-CorrelationID']).not.toBe(headers[1]['IM-CorrelationID']);
  });

  it('reutiliza el token vigente en vez de pedir uno por llamada', async () => {
    const fetchMock = conToken(json(PRECIOS), json(PRECIOS));
    vi.stubGlobal('fetch', fetchMock);

    await getPrices(['4A0036']);
    await getPrices(['4A0036']);

    const pedidosDeToken = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/token'));
    expect(pedidosDeToken).toHaveLength(1);
  });

  // Sin expires_in usable, dar el token por vigente termina en un 401 en medio
  // de una cotizacion; pedir uno de mas es barato.
  it('no da por vigente un token sin expires_in', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/token') ? json({ access_token: 'x' }) : json(PRECIOS),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getPrices(['4A0036']);
    await getPrices(['4A0036']);

    const pedidosDeToken = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/token'));
    expect(pedidosDeToken).toHaveLength(2);
  });

  it('no dispara dos pedidos de token ante llamadas simultaneas', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/token') ? tokenOk() : json(PRECIOS),
    );
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([getPrices(['4A0036']), getPrices(['4A0036'])]);

    const pedidosDeToken = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/token'));
    expect(pedidosDeToken).toHaveLength(1);
  });

  it('reporta credenciales rechazadas como error de proveedor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ fault: { faultstring: 'Invalid client identifier' } }, 401)),
    );

    await expect(getPrices(['4A0036'])).rejects.toThrow(ProviderError);
  });
});

describe('normalizarProducto', () => {
  it('usa vendorPartNumber como MPN, no el codigo interno de Ingram', () => {
    expect(normalizarProducto(CATALOGO.catalog[0])).toEqual({
      sku: '1A8249',
      mpn: 'SDSQUNC-016G-AN6IA',
      nombre: 'CLASS 10 100MB/S UHS-I CARD',
      marca: 'Sandisk Mobile',
      categoria: 'device storage',
      subcategorias: ['Flash Memory Devices'],
      tipo: null,
    });
  });

  // "IM::Physical" es un prefijo interno de Ingram; el tipo util es
  // productType ("LCD Monitors"), que en esta fixture viene vacio.
  it('toma el tipo de productType y no del type interno', () => {
    expect(normalizarProducto({ ingramPartNumber: 'X', productType: 'LCD Monitors', type: 'IM::Physical' }).tipo).toBe(
      'LCD Monitors',
    );
  });

  it('trata un vendorPartNumber vacio como ausencia de MPN', () => {
    expect(normalizarProducto({ ingramPartNumber: 'X', vendorPartNumber: '  ' }).mpn).toBeNull();
  });
});

describe('cargarCatalogoIngram', () => {
  it('recorre las paginas hasta juntar recordsFound', async () => {
    const pagina = (n: number, items: ProductoIngram[]) =>
      json({ recordsFound: 3, pageSize: 100, pageNumber: n, catalog: items });
    const producto = (sku: string): ProductoIngram => ({
      ingramPartNumber: sku,
      vendorPartNumber: `V-${sku}`,
      description: `Producto ${sku}`,
      vendorName: 'Dell',
    });

    const fetchMock = conToken(
      pagina(1, [producto('A1'), producto('A2')]),
      pagina(2, [producto('A3')]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await cargarCatalogoIngram();

    expect(catalogo.map((p) => p.sku)).toEqual(['A1', 'A2', 'A3']);
    const paginas = fetchMock.mock.calls.slice(1).map((c) => (c[0] as URL).searchParams.get('pageNumber'));
    expect(paginas).toEqual(['1', '2']);
  });

  // recordsFound puede venir desactualizado; la pagina vacia es el fin real.
  it('corta en la primera pagina vacia aunque recordsFound prometa mas', async () => {
    const fetchMock = conToken(
      json({ recordsFound: 999, catalog: [{ ingramPartNumber: 'A1' }] }),
      json({ recordsFound: 999, catalog: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await cargarCatalogoIngram();

    expect(catalogo).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('descarta productos sin ingramPartNumber, que no se pueden cotizar', async () => {
    const fetchMock = conToken(
      json({ recordsFound: 2, catalog: [{ ingramPartNumber: 'A1' }, { description: 'huerfano' }] }),
      json({ recordsFound: 2, catalog: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await cargarCatalogoIngram()).toHaveLength(1);
  });

  // Un catalogo truncado en silencio se lee como "ese producto no existe".
  it('avisa por consola cuando corta por el tope de paginas', async () => {
    vi.stubEnv('INGRAM_MAX_PAGINAS', '2');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/token')
          ? tokenOk()
          : json({ recordsFound: 999, catalog: [{ ingramPartNumber: 'A1' }] }),
      ),
    );

    await cargarCatalogoIngram();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('truncado'));
    errorSpy.mockRestore();
  });

  it('falla si el catalogo viene vacio en vez de dejarlo asi', async () => {
    const fetchMock = conToken(json({ recordsFound: 0, catalog: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cargarCatalogoIngram()).rejects.toThrow();
  });
});

describe('getPrices', () => {
  it('no llama a la red con la lista vacia', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await getPrices([])).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('manda los SKUs como ingramPartNumber y pide precio y disponibilidad', async () => {
    const fetchMock = conToken(json(PRECIOS));
    vi.stubGlobal('fetch', fetchMock);

    await getPrices(['4A0036']);

    const [url, init] = fetchMock.mock.calls[1];
    expect((url as URL).pathname).toBe('/resellers/v6/catalog/priceandavailability');
    expect((url as URL).searchParams.get('includePricing')).toBe('true');
    expect((url as URL).searchParams.get('includeAvailability')).toBe('true');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      products: [{ ingramPartNumber: '4A0036' }],
    });
  });

  // customerPrice es lo que se paga; retailPrice es lista. Cotizar sobre el
  // precio de lista sobrestima el costo y hace perder la venta.
  it('cotiza sobre customerPrice, no sobre retailPrice', async () => {
    vi.stubGlobal('fetch', conToken(json(PRECIOS)));

    const precios = await getPrices(['4A0036']);

    expect(precios.get('4A0036')).toEqual({ price: 74.34, currency: 'USD', inStock: 0 });
  });

  it('cae a retailPrice cuando no hay customerPrice', async () => {
    vi.stubGlobal(
      'fetch',
      conToken(
        json([
          {
            ingramPartNumber: 'A1',
            pricing: { currencyCode: 'CLP', retailPrice: 1000 },
            availability: { totalAvailability: 4 },
          },
        ]),
      ),
    );

    expect((await getPrices(['A1'])).get('A1')).toEqual({
      price: 1000,
      currency: 'CLP',
      inStock: 4,
    });
  });

  it('omite los items que Ingram no pudo cotizar', async () => {
    vi.stubGlobal(
      'fetch',
      conToken(
        json([
          { ingramPartNumber: 'A1', productStatusCode: 'E', pricing: null },
          { ingramPartNumber: 'A2', pricing: { customerPrice: 10, currencyCode: 'USD' } },
        ]),
      ),
    );

    expect([...(await getPrices(['A1', 'A2'])).keys()]).toEqual(['A2']);
  });

  it('rechaza mas SKUs de los que acepta el endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const demasiados = Array.from({ length: 51 }, (_, i) => `S${i}`);

    await expect(getPrices(demasiados)).rejects.toThrow(/at most 50/);
  });

  it('el tope declarado coincide con el que aplica getPrices', () => {
    expect(ingram.maxSkusPorLote).toBe(50);
  });
});

describe('getPrice', () => {
  it('consulta por ingramPartNumber cuando se pasa sku', async () => {
    const fetchMock = conToken(json(PRECIOS));
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await getPrice({ sku: '4A0036' });

    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      products: [{ ingramPartNumber: '4A0036' }],
    });
    expect(resultado).toMatchObject({
      provider: 'ingram',
      sku: '4A0036',
      mpn: 'E2016HV',
      price: 74.34,
      currency: 'USD',
      inStock: 0,
    });
  });

  it('consulta por vendorPartNumber cuando se pasa mpn', async () => {
    const fetchMock = conToken(json(PRECIOS));
    vi.stubGlobal('fetch', fetchMock);

    await getPrice({ mpn: 'E2016HV' });

    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      products: [{ vendorPartNumber: 'E2016HV' }],
    });
  });

  it('consulta por upc cuando se pasa upc', async () => {
    const fetchMock = conToken(json(PRECIOS));
    vi.stubGlobal('fetch', fetchMock);

    await getPrice({ upc: '0884116186519' });

    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      products: [{ upc: '0884116186519' }],
    });
  });

  it('devuelve not_found con una respuesta sin items', async () => {
    vi.stubGlobal('fetch', conToken(json([])));

    await expect(getPrice({ sku: 'NO-EXISTE' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  // Ingram responde 200 con el motivo cuando no puede cotizar; perderlo
  // convierte "no estas autorizado a comprar esto" en un 404 mudo.
  it('conserva el motivo de Ingram cuando el item no trae precio', async () => {
    vi.stubGlobal(
      'fetch',
      conToken(
        json([
          {
            ingramPartNumber: 'A1',
            productStatusCode: 'E',
            productStatusMessage: 'PRODUCT NOT AUTHORIZED FOR THIS CUSTOMER',
            pricing: null,
          },
        ]),
      ),
    );

    await expect(getPrice({ sku: 'A1' })).rejects.toThrow(/NOT AUTHORIZED/);
  });

  it('propaga un HTTP no-2xx de la API como error de proveedor', async () => {
    vi.stubGlobal('fetch', conToken(new Response('boom', { status: 500 })));

    await expect(getPrice({ sku: 'A1' })).rejects.toThrow(ProviderError);
  });
});
