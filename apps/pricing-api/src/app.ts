import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import porRutaFacetasHandler from '../api/[proveedor]/facetas.js';
import porRutaProductHandler from '../api/[proveedor]/product.js';
import porRutaSearchHandler from '../api/[proveedor]/search.js';
import creditoMockHandler from '../api/credito/mock.js';
import facetasHandler from '../api/facetas.js';
import mejorPrecioHandler from '../api/mejor-precio.js';
import priceHandler from '../api/price.js';
import productHandler from '../api/product.js';
import searchHandler from '../api/search.js';
import { PROVEEDORES } from '@rr/providers';

// BASE_PATH lets the tunnel expose the API under a path prefix
// (e.g. /rr/captador-precios/price) while /api/price keeps working, so the
// local server and the Vercel deployment answer the same canonical route.
const RECURSOS_POR_PROVEEDOR = ['search', 'product', 'facetas'];

interface Ruta {
  handler: string;
  /** Solo en las rutas con proveedor en el path: Vercel lo pasa como segmento dinamico. */
  proveedor?: string;
}

function rutas(): Record<string, Ruta> {
  const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
  const nombres = ['price', 'search', 'product', 'facetas', 'mejor-precio', 'credito/mock'];
  const tabla: Record<string, Ruta> = {};
  for (const nombre of nombres) {
    tabla[`/api/${nombre}`] = { handler: nombre };
    if (basePath) tabla[`${basePath}/${nombre}`] = { handler: nombre };
  }
  // Un proveedor no registrado no entra en la tabla, asi que cae en el 404
  // generico de ruta. El proveedor_desconocido con cuerpo detallado lo entrega
  // Vercel, donde el segmento es dinamico y siempre llega al handler.
  for (const proveedor of Object.keys(PROVEEDORES)) {
    for (const recurso of RECURSOS_POR_PROVEEDOR) {
      const ruta: Ruta = { handler: `proveedor:${recurso}`, proveedor };
      tabla[`/api/${proveedor}/${recurso}`] = ruta;
      if (basePath) tabla[`${basePath}/${proveedor}/${recurso}`] = ruta;
    }
  }
  return tabla;
}

const handlers = {
  price: priceHandler,
  search: searchHandler,
  product: productHandler,
  facetas: facetasHandler,
  'mejor-precio': mejorPrecioHandler,
  'credito/mock': creditoMockHandler,
  'proveedor:search': porRutaSearchHandler,
  'proveedor:product': porRutaProductHandler,
  'proveedor:facetas': porRutaFacetasHandler,
};

// En Vercel el runtime parsea el cuerpo por su cuenta; aca hay que leerlo del
// socket. El tope evita que un cliente sin autenticar (el cuerpo se lee antes
// de que el handler valide la api key) mantenga el proceso leyendo para
// siempre.
const CUERPO_MAXIMO_BYTES = 1_000_000;

class CuerpoDemasiadoGrandeError extends Error {}

function leerCuerpo(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    let bytes = 0;

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CUERPO_MAXIMO_BYTES) {
        // Se deja de leer pero no se destruye el socket: hay que alcanzar a
        // escribir el 413. Node cierra la conexion solo al terminar la
        // respuesta, porque el cuerpo quedo sin consumir.
        req.pause();
        reject(new CuerpoDemasiadoGrandeError());
        return;
      }
      partes.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const tabla = rutas();

  return createServer(async (req, res) => {
    const vres = res as unknown as VercelResponse;
    vres.status = (code: number) => {
      res.statusCode = code;
      return vres;
    };
    vres.json = (payload: unknown) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return vres;
    };

    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

      const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
      const escapado = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // El sku puede venir en el path con o sin prefijo de proveedor:
      // /api/product/HP1 y /api/intcomex/product/HP1.
      const patronProducto = new RegExp(
        `^(?:${escapado})?(?:/api)?(?:/([a-z0-9-]+))?/product/(.+)$`,
      );

      const conSku = patronProducto.exec(url.pathname);
      const proveedorDelPath = conSku?.[1];
      const ruta: Ruta | undefined = conSku
        ? proveedorDelPath
          ? { handler: 'proveedor:product', proveedor: proveedorDelPath }
          : { handler: 'product' }
        : tabla[url.pathname];

      if (!ruta) {
        vres.status(404).json({ error: 'not_found', detail: 'Unknown route' });
        return;
      }

      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (!(key in query)) query[key] = value;
      }
      if (conSku) query.sku = decodeURIComponent(conSku[2]);
      // En Vercel el segmento [proveedor] llega como query param; aca hay que
      // ponerlo a mano o el handler por ruta no sabe a quien preguntarle.
      if (ruta.proveedor) query.proveedor = ruta.proveedor;
      (req as unknown as VercelRequest).query = query;

      // Se lee despues de resolver la ruta: una ruta desconocida no deberia
      // hacernos consumir el cuerpo.
      if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          (req as unknown as VercelRequest).body = await leerCuerpo(req);
        } catch (error) {
          if (error instanceof CuerpoDemasiadoGrandeError) {
            res.setHeader('connection', 'close');
            vres.status(413).json({
              error: 'payload_too_large',
              detail: `El cuerpo supera el maximo de ${CUERPO_MAXIMO_BYTES} bytes`,
            });
            return;
          }
          throw error;
        }
      }

      await handlers[ruta.handler as keyof typeof handlers](req as unknown as VercelRequest, vres);
    } catch (error) {
      console.error('[server] unhandled request error', error);
      if (!res.headersSent) {
        vres.status(500).json({ error: 'internal', detail: 'Unexpected server error' });
      }
    }
  });
}
