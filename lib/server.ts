import { createServer, type Server } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import facetasHandler from '../api/facetas.js';
import priceHandler from '../api/price.js';
import productHandler from '../api/product.js';
import searchHandler from '../api/search.js';

// BASE_PATH lets the tunnel expose the API under a path prefix
// (e.g. /rr/captador-precios/price) while /api/price keeps working, so the
// local server and the Vercel deployment answer the same canonical route.
function rutas(): Record<string, string> {
  const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
  const nombres = ['price', 'search', 'product', 'facetas'];
  const tabla: Record<string, string> = {};
  for (const nombre of nombres) {
    tabla[`/api/${nombre}`] = nombre;
    if (basePath) tabla[`${basePath}/${nombre}`] = nombre;
  }
  return tabla;
}

const handlers = {
  price: priceHandler,
  search: searchHandler,
  product: productHandler,
  facetas: facetasHandler,
};

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
      const patronProducto = new RegExp(`^(?:${escapado})?(?:/api)?/product/(.+)$`);

      const conSku = patronProducto.exec(url.pathname);
      const nombre = conSku ? 'product' : tabla[url.pathname];

      if (!nombre) {
        vres.status(404).json({ error: 'not_found', detail: 'Unknown route' });
        return;
      }

      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (!(key in query)) query[key] = value;
      }
      if (conSku) query.sku = decodeURIComponent(conSku[1]);
      (req as unknown as VercelRequest).query = query;

      await handlers[nombre as keyof typeof handlers](req as unknown as VercelRequest, vres);
    } catch (error) {
      console.error('[server] unhandled request error', error);
      if (!res.headersSent) {
        vres.status(500).json({ error: 'internal', detail: 'Unexpected server error' });
      }
    }
  });
}
