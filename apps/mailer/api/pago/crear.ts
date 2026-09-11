import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createCrearHandler } from '../../src/pago/crear.js';

// Envoltorio fino, igual que api/send.ts. La validacion de entorno vive en el
// handler, porque las pruebas lo ejercitan inyectando `env` en el factory.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createCrearHandler()(req, res);
}
