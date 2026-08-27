// Servidor que imita el contrato publicado de Ingram, para ejercitar el modulo
// de punta a punta -ruta HTTP -> handler -> proveedor -> red- sin credenciales.
//
// Existe porque el modulo de Ingram esta escrito contra su OpenAPI y no contra
// una respuesta real: esto verifica el cableado, no que le hayamos acertado a
// la forma del tenant. Cuando lleguen las credenciales, sirve para comparar
// esta respuesta simulada con la de verdad.
//
// Uso: levantarlo con `npx tsx apps/pricing-api/scripts/mock-ingram.ts` y arrancar el servidor
// con INGRAM_BASE_URL=http://127.0.0.1:4010,
// INGRAM_TOKEN_URL=http://127.0.0.1:4010/oauth/oauth30/token y cualquier valor
// en INGRAM_CLIENT_ID, INGRAM_CLIENT_SECRET e INGRAM_CUSTOMER_NUMBER.
import { createServer } from 'node:http';

const CATALOGO = Array.from({ length: 230 }, (_, i) => ({
  ingramPartNumber: `IM${String(i).padStart(4, '0')}`,
  vendorPartNumber: `VP-${i}`,
  upcCode: `00000000${i}`,
  description: i % 3 === 0 ? `Notebook Dell Latitude ${i}` : `Monitor Dell P${i}`,
  vendorName: 'DELL',
  category: i % 3 === 0 ? 'Computadores' : 'Displays',
  subCategory: 'Computer Monitors',
  productType: 'LCD Monitors',
  type: 'IM::Physical',
}));

let pedidosDeToken = 0;
let llamadasPA = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  res.setHeader('content-type', 'application/json');

  if (url.pathname.endsWith('/token')) {
    pedidosDeToken += 1;
    res.end(JSON.stringify({ access_token: 'tok-mock', token_type: 'bearer', expires_in: '86400' }));
    return;
  }

  // Toda ruta de negocio exige el Bearer y las cabeceras obligatorias.
  const missing = ['authorization', 'im-customernumber', 'im-countrycode', 'im-correlationid'].filter(
    (h) => !req.headers[h],
  );
  if (missing.length > 0) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: `faltan cabeceras: ${missing.join(', ')}` }));
    return;
  }

  if (url.pathname === '/resellers/v6/catalog') {
    const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
    const pageNumber = Number(url.searchParams.get('pageNumber') ?? 1);
    const offset = (pageNumber - 1) * pageSize;
    res.end(
      JSON.stringify({
        recordsFound: CATALOGO.length,
        pageSize,
        pageNumber,
        catalog: CATALOGO.slice(offset, offset + pageSize),
      }),
    );
    return;
  }

  if (url.pathname === '/resellers/v6/catalog/priceandavailability') {
    llamadasPA += 1;
    const body = await new Promise<string>((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => resolve(d));
    });
    const { products } = JSON.parse(body) as {
      products: { ingramPartNumber?: string; vendorPartNumber?: string; upc?: string }[];
    };

    res.end(
      JSON.stringify(
        products.map((p, i) => {
          const found =
            CATALOGO.find((c) => c.ingramPartNumber === p.ingramPartNumber) ??
            CATALOGO.find((c) => c.vendorPartNumber === p.vendorPartNumber) ??
            CATALOGO.find((c) => c.upcCode === p.upc);
          if (!found) {
            return {
              index: i,
              productStatusCode: 'E',
              productStatusMessage: 'PRODUCT NOT FOUND',
              ingramPartNumber: p.ingramPartNumber,
            };
          }
          const n = Number(found.ingramPartNumber.slice(2));
          return {
            index: i,
            ingramPartNumber: found.ingramPartNumber,
            vendorPartNumber: found.vendorPartNumber,
            description: found.description,
            vendorName: found.vendorName,
            availability: { available: n % 4 !== 0, totalAvailability: n % 4 === 0 ? 0 : n },
            pricing: { currencyCode: 'USD', retailPrice: 100 + n, customerPrice: 80 + n },
          };
        }),
      ),
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'ruta no simulada', path: url.pathname }));
});

server.listen(4010, '127.0.0.1', () => console.log('mock de Ingram en :4010'));

process.on('SIGTERM', () => {
  console.log(`tokens pedidos: ${pedidosDeToken} | llamadas P&A: ${llamadasPA}`);
  server.close();
});
