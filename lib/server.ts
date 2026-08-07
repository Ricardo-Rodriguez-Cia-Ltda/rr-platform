import { createServer, type Server } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import priceHandler from '../api/price.js';
import searchHandler from '../api/search.js';

// BASE_PATH lets the tunnel expose the API under a path prefix
// (e.g. /rr/captador-precios/price) while /api/price keeps working, so the
// local server and the Vercel deployment answer the same canonical route.
function rutas(): Record<string, string> {
  const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
  const tabla: Record<string, string> = {
    '/api/price': 'price',
    '/api/search': 'search',
  };
  if (basePath) {
    tabla[`${basePath}/price`] = 'price';
    tabla[`${basePath}/search`] = 'search';
  }
  return tabla;
}

const handlers = { price: priceHandler, search: searchHandler };

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
      const nombre = tabla[url.pathname];
      if (!nombre) {
        vres.status(404).json({ error: 'not_found', detail: 'Unknown route' });
        return;
      }

      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (!(key in query)) query[key] = value;
      }
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
