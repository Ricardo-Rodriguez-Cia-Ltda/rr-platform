import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  forgetToken,
  loadIngramCatalog,
  getPrice,
  getPrices,
  ingram,
  normalizeProduct,
  type IngramProduct,
} from '@rr/providers/ingram';
import { ProviderError } from '@rr/domain/types';

// Fixtures tomadas de la OpenAPI oficial de Ingram
// (ingrammicro-xvantage/xi-sdk-openapispec). Verifican NUESTRA normalizacion
// contra el contrato publicado; la forma real de la respuesta del tenant de
// Chile queda sin verificar hasta tener credenciales.
const CATALOGO = JSON.parse(readFileSync('packages/providers/tests/fixtures/ingram-catalog.json', 'utf8')) as {
  recordsFound: number;
  catalog: IngramProduct[];
};
const PRECIOS = JSON.parse(
  readFileSync('packages/providers/tests/fixtures/ingram-priceandavailability.json', 'utf8'),
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
  // Sin pausa entre paginas: el ritmo real se verifica aparte.
  vi.stubEnv('INGRAM_MS_ENTRE_PAGINAS', '0');
  forgetToken();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isConfigured', () => {
  it('es false mientras no lleguen las llaves de Ingram', () => {
    vi.stubEnv('INGRAM_CLIENT_ID', '');
    expect(ingram.isConfigured()).toBe(false);
  });

  // El numero de cliente no es opcional: sin el, Ingram rechaza toda consulta
  // de catalogo y precio aunque el token sea valido.
  it('es false si falta el numero de cliente', () => {
    vi.stubEnv('INGRAM_CUSTOMER_NUMBER', '');
    expect(ingram.isConfigured()).toBe(false);
  });

  it('es true con client id, secret y numero de cliente', () => {
    expect(ingram.isConfigured()).toBe(true);
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

describe('normalizeProduct', () => {
  it('usa vendorPartNumber como MPN, no el codigo interno de Ingram', () => {
    expect(normalizeProduct(CATALOGO.catalog[0])).toEqual({
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
    expect(normalizeProduct({ ingramPartNumber: 'X', productType: 'LCD Monitors', type: 'IM::Physical' }).tipo).toBe(
      'LCD Monitors',
    );
  });

  it('trata un vendorPartNumber vacio como ausencia de MPN', () => {
    expect(normalizeProduct({ ingramPartNumber: 'X', vendorPartNumber: '  ' }).mpn).toBeNull();
  });
});

describe('loadIngramCatalog', () => {
  it('recorre las paginas hasta la primera vacia', async () => {
    const pagina = (n: number, items: IngramProduct[]) =>
      json({ recordsFound: 3, pageSize: 100, pageNumber: n, catalog: items });
    const producto = (sku: string): IngramProduct => ({
      ingramPartNumber: sku,
      vendorPartNumber: `V-${sku}`,
      description: `Producto ${sku}`,
      vendorName: 'Dell',
    });

    const fetchMock = conToken(
      pagina(1, [producto('A1'), producto('A2')]),
      pagina(2, [producto('A3')]),
      pagina(3, []),
    );
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await loadIngramCatalog();

    expect(catalogo.map((p) => p.sku)).toEqual(['A1', 'A2', 'A3']);
    const paginas = fetchMock.mock.calls.slice(1).map((c) => (c[0] as URL).searchParams.get('pageNumber'));
    expect(paginas).toEqual(['1', '2', '3']);
  });

  // Medido contra la API real: Ingram devuelve ~la mitad de lo pedido y su
  // recordsFound varia entre llamadas. Cortar con ese contador deja el
  // catalogo a medias, y un catalogo incompleto se lee como "no existe".
  it('no corta por recordsFound, que Ingram reporta de forma inestable', async () => {
    const fetchMock = conToken(
      json({ recordsFound: 2, catalog: [{ ingramPartNumber: 'A1' }, { ingramPartNumber: 'A2' }] }),
      json({ recordsFound: 9999, catalog: [{ ingramPartNumber: 'A3' }] }),
      json({ recordsFound: 2, catalog: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await loadIngramCatalog()).toHaveLength(3);
  });

  it('corta en la primera pagina vacia aunque recordsFound prometa mas', async () => {
    const fetchMock = conToken(
      json({ recordsFound: 999, catalog: [{ ingramPartNumber: 'A1' }] }),
      json({ recordsFound: 999, catalog: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await loadIngramCatalog();

    expect(catalogo).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // Ingram permite 60 llamadas por minuto y por endpoint; el catalogo de Chile
  // son ~60 paginas. Sin pausa el volcado real se corta a la mitad por cuota.
  it('espera entre paginas para no pasarse de la cuota', async () => {
    vi.stubEnv('INGRAM_MS_ENTRE_PAGINAS', '40');
    const fetchMock = conToken(
      json({ catalog: [{ ingramPartNumber: 'A1' }] }),
      json({ catalog: [{ ingramPartNumber: 'A2' }] }),
      json({ catalog: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const t0 = Date.now();
    await loadIngramCatalog();

    // Tres paginas => dos pausas.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  // "esperar" no es lo mismo que "algo se rompio": quien lea el log tiene que
  // saber que la cura es bajar el ritmo, no investigar una caida. Ahora un
  // 429 aislado se reintenta (ver describe de mas abajo); esto verifica que
  // seis 429 seguidos en la misma pagina si terminan en error nombrando la
  // cuota.
  it('nombra la cuota cuando Ingram corta por exceso de llamadas seis veces seguidas', async () => {
    vi.useFakeTimers();
    const pagina429 = () =>
      new Response(
        JSON.stringify({ errors: [{ message: 'The quota limit exceeds for calls on your API app.' }] }),
        { status: 429 },
      );
    vi.stubGlobal(
      'fetch',
      conToken(pagina429(), pagina429(), pagina429(), pagina429(), pagina429(), pagina429()),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const promesa = loadIngramCatalog();
    const expectativa = expect(promesa).rejects.toThrow(/corto por cuota/i);
    // Sin cabecera de reset se cae al fallback de 60 s; cinco esperas (una
    // por reintento) antes de darse por vencido.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    await expectativa;

    expect(errorSpy).toHaveBeenCalledTimes(5);
    errorSpy.mockRestore();
  });

  // Medido contra la API real (diagnostico de hoy): remaining bajo de 59 a 0
  // en 77 paginas y solo se recargo una vez, a medias. Sin usar la cabecera,
  // el volcado real se corta por cuota bastante antes de terminar el
  // catalogo (~13.200 productos).
  describe('cuota casi agotada (cabeceras x-ratelimit-*)', () => {
    it('con remaining bajo espera hasta el reset antes de pedir la siguiente pagina', async () => {
      vi.useFakeTimers();
      const ahora = Date.now();
      const pagina1 = new Response(JSON.stringify({ catalog: [{ ingramPartNumber: 'A1' }] }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '3',
          'x-ratelimit-reset': String(ahora + 5000),
        },
      });
      const fetchMock = conToken(pagina1, json({ catalog: [] }));
      vi.stubGlobal('fetch', fetchMock);

      let listo = false;
      const promesa = loadIngramCatalog().then((r) => {
        listo = true;
        return r;
      });

      // Todavia no pasaron los ~6 s (reset + 1 s): la pagina 2 sigue esperando.
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchMock).toHaveBeenCalledTimes(2); // token + pagina 1
      expect(listo).toBe(false);

      await vi.advanceTimersByTimeAsync(3500);
      const catalogo = await promesa;

      expect(listo).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(catalogo.map((p) => p.sku)).toEqual(['A1']);
    });

    it('avisa por consola cada vez que espera por cuota casi agotada', async () => {
      vi.useFakeTimers();
      const ahora = Date.now();
      const pagina1 = new Response(JSON.stringify({ catalog: [{ ingramPartNumber: 'A1' }] }), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': String(ahora + 5000) },
      });
      vi.stubGlobal('fetch', conToken(pagina1, json({ catalog: [] })));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const promesa = loadIngramCatalog();
      await vi.advanceTimersByTimeAsync(7000);
      await promesa;

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\[ingram\] catalogo: cuota casi agotada en pagina 2, espera \d+s$/),
      );
      errorSpy.mockRestore();
    });

    it('un 429 de cuota en una pagina se reintenta tras esperar y el catalogo se completa', async () => {
      vi.useFakeTimers();
      const ahora = Date.now();
      const pagina1 = json({ catalog: [{ ingramPartNumber: 'A1' }] });
      const pagina2Con429 = new Response(
        JSON.stringify({ errors: [{ message: 'The quota limit exceeds for calls on your API app.' }] }),
        {
          status: 429,
          // reset a 6 s: por encima del piso de 5 s de quotaWaitMs, asi la
          // espera sale de la cabecera y no del fallback de 60 s (ver test
          // aparte para el caso con reset ya vencido).
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(ahora + 6000) },
        },
      );
      const pagina2Ok = json({ catalog: [{ ingramPartNumber: 'A2' }] });
      const paginaVacia = json({ catalog: [] });

      vi.stubGlobal('fetch', conToken(pagina1, pagina2Con429, pagina2Ok, paginaVacia));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const promesa = loadIngramCatalog();
      await vi.advanceTimersByTimeAsync(8000);
      const catalogo = await promesa;

      expect(catalogo.map((p) => p.sku)).toEqual(['A1', 'A2']);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('429 por cuota en pagina 2, reintento 1/5'),
      );
      errorSpy.mockRestore();
    });

    // El reset puede llegar ya vencido (cabecera stale, o el reloj del host
    // adelantado respecto al de Ingram): el calculo crudo (reset + 1s - ahora)
    // da un numero negativo, y sin piso el reintento saldria casi de
    // inmediato, quemando los 5 intentos en segundos en vez de dar tiempo a
    // que la cuota se recargue.
    it('un reset ya vencido no dispara un reintento casi inmediato: usa el fallback de 60 s', async () => {
      vi.useFakeTimers();
      const ahora = Date.now();
      const pagina1 = json({ catalog: [{ ingramPartNumber: 'A1' }] });
      const pagina2Con429 = new Response(
        JSON.stringify({ errors: [{ message: 'The quota limit exceeds for calls on your API app.' }] }),
        {
          status: 429,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(ahora - 5000) },
        },
      );
      const pagina2Ok = json({ catalog: [{ ingramPartNumber: 'A2' }] });
      const paginaVacia = json({ catalog: [] });

      vi.stubGlobal('fetch', conToken(pagina1, pagina2Con429, pagina2Ok, paginaVacia));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      let listo = false;
      const promesa = loadIngramCatalog().then((r) => {
        listo = true;
        return r;
      });

      // A los 10 s todavia no paso el fallback de 60 s: el reintento no salio.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listo).toBe(false);

      await vi.advanceTimersByTimeAsync(55_000);
      const catalogo = await promesa;

      expect(listo).toBe(true);
      expect(catalogo.map((p) => p.sku)).toEqual(['A1', 'A2']);
      errorSpy.mockRestore();
    });

    // Sin cabeceras, el volcado se comporta igual que antes: nada de esperas
    // largas de cuota, solo la pausa fija entre paginas (aca en 0).
    it('sin cabeceras de cuota no agrega esperas extra', async () => {
      const fetchMock = conToken(
        json({ catalog: [{ ingramPartNumber: 'A1' }] }),
        json({ catalog: [] }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const t0 = Date.now();
      await loadIngramCatalog();

      expect(Date.now() - t0).toBeLessThan(500);
    });
  });

  it('descarta productos sin ingramPartNumber, que no se pueden cotizar', async () => {
    const fetchMock = conToken(
      json({ recordsFound: 2, catalog: [{ ingramPartNumber: 'A1' }, { description: 'huerfano' }] }),
      json({ recordsFound: 2, catalog: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await loadIngramCatalog()).toHaveLength(1);
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

    await loadIngramCatalog();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('truncado'));
    errorSpy.mockRestore();
  });

  it('falla si el catalogo viene vacio en vez de dejarlo asi', async () => {
    const fetchMock = conToken(json({ recordsFound: 0, catalog: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadIngramCatalog()).rejects.toThrow();
  });

  // Visto en una descarga real: pasada la ultima pagina Ingram no devuelve una
  // pagina vacia como las demas, responde 404 con "Record not found". El
  // volcado viejo no llegaba tan lejos y nunca lo vio.
  describe('fin de catalogo con 404 "Record not found"', () => {
    function pagina404RecordNotFound(): Response {
      return new Response(
        JSON.stringify([{ traceid: 'abc123', type: 'Errors', message: 'Record not found', fields: [] }]),
        { status: 404 },
      );
    }

    it('un 404 "Record not found" pasada la primera pagina termina el catalogo ahi', async () => {
      const fetchMock = conToken(
        json({ catalog: [{ ingramPartNumber: 'A1' }] }),
        json({ catalog: [{ ingramPartNumber: 'A2' }] }),
        pagina404RecordNotFound(),
      );
      vi.stubGlobal('fetch', fetchMock);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const catalogo = await loadIngramCatalog();

      expect(catalogo.map((p) => p.sku)).toEqual(['A1', 'A2']);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('pagina 3 respondio 404 Record not found'),
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('2 productos'));
      errorSpy.mockRestore();
    });

    it('un 404 "Record not found" en la primera pagina sigue siendo un error', async () => {
      const fetchMock = conToken(pagina404RecordNotFound());
      vi.stubGlobal('fetch', fetchMock);

      await expect(loadIngramCatalog()).rejects.toThrow(/HTTP 404/);
    });
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
    expect(ingram.maxSkusPerBatch).toBe(50);
  });

  // El 429 real dice "quota limit exceeds ... on your API app": la cuota es
  // del app completo, no de 60 llamadas por minuto y por endpoint como decia
  // antes este mensaje.
  it('un 429 de cuota nombra que la cuota es del API app completo, no por endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      conToken(
        new Response(
          JSON.stringify({ errors: [{ message: 'The quota limit exceeds for calls on your API app.' }] }),
          { status: 429 },
        ),
      ),
    );

    await expect(getPrices(['4A0036'])).rejects.toThrow(/cuota es del API app completo/);
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

// Visto en produccion: el proceso llevaba ~24 h y Ingram devolvia 401 en todas
// las llamadas, incluido el refresco de catalogo, mientras un proceso nuevo
// funcionaba perfecto. El token cacheado estaba muerto antes de su expires_in
// —Ingram lo invalida, por ejemplo, al emitir otro para el mismo cliente— y
// nada lo renovaba: Ingram quedaba fuera de toda comparacion, en silencio.
describe('token invalidado antes de tiempo', () => {
  it('ante un 401 pide un token nuevo y reintenta una vez', async () => {
    let tokensEmitidos = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/token')) {
        tokensEmitidos += 1;
        return json({ access_token: `token-${tokensEmitidos}`, expires_in: '86400' });
      }
      // El primer token esta muerto; el segundo sirve.
      const cabeceras = init?.headers as Record<string, string> | undefined;
      return cabeceras?.Authorization === 'Bearer token-1'
        ? json({ error: 'unauthorized' }, 401)
        : json(PRECIOS);
    });
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const precios = await getPrices(['4A0036']);

    expect(precios.get('4A0036')).toBeDefined();
    expect(tokensEmitidos).toBe(2);
    errorSpy.mockRestore();
  });

  // Si el token recien pedido tambien da 401, el problema son las credenciales
  // y reintentar en bucle solo esconde el error.
  it('no reintenta mas de una vez', async () => {
    let tokensEmitidos = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/token')) {
        tokensEmitidos += 1;
        return json({ access_token: `token-${tokensEmitidos}`, expires_in: '86400' });
      }
      return json({ error: 'unauthorized' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getPrices(['4A0036'])).rejects.toThrow(ProviderError);
    expect(tokensEmitidos).toBe(2);
    errorSpy.mockRestore();
  });

  it('una respuesta normal no dispara ningun token extra', async () => {
    const fetchMock = conToken(json(PRECIOS));
    vi.stubGlobal('fetch', fetchMock);

    await getPrices(['4A0036']);

    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/token'))).toHaveLength(1);
  });
});
