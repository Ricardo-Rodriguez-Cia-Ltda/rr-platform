import { createServer, type Server } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/price.js';

// BASE_PATH lets the tunnel expose the API under a path prefix
// (e.g. /rr/captador-precios/price) while /api/price keeps working, so the
// local server and the Vercel deployment answer the same canonical route.
function priceRoutes(): string[] {
  const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
  return basePath ? ['/api/price', `${basePath}/price`] : ['/api/price'];
}

export function createApp(): Server {
  const routes = priceRoutes();

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
      if (!routes.includes(url.pathname)) {
        vres.status(404).json({ error: 'not_found', detail: 'Unknown route' });
        return;
      }

      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (!(key in query)) query[key] = value;
      }
      (req as unknown as VercelRequest).query = query;

      await handler(req as unknown as VercelRequest, vres);
    } catch (error) {
      console.error('[server] unhandled request error', error);
      if (!res.headersSent) {
        vres.status(500).json({ error: 'internal', detail: 'Unexpected server error' });
      }
    }
  });
}
