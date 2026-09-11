import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createCrearHandler } from '../../src/pago/crear.js';

// Envoltorio fino, igual que api/cotizacion/[id].ts. La validacion de entorno
// vive en el handler, porque las pruebas lo ejercitan inyectando `env` en el
// factory (api/send.ts en cambio valida el entorno aqui mismo, en el
// envoltorio).
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createCrearHandler()(req, res);
}
