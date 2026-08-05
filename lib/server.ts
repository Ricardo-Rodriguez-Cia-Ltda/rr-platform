import { createServer, type Server } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/price.js';

export function createApp(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

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

    if (url.pathname !== '/api/price') {
      vres.status(404).json({ error: 'not_found', detail: 'Unknown route' });
      return;
    }

    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in query)) query[key] = value;
    }
    (req as unknown as VercelRequest).query = query;

    try {
      await handler(req as unknown as VercelRequest, vres);
    } catch {
      if (!res.headersSent) {
        vres.status(500).json({ error: 'internal', detail: 'Unexpected server error' });
      }
    }
  });
}
