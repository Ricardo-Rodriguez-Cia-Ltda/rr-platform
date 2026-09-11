import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createCrearHandler } from '../../src/pago/crear.js';

// Mismo techo que api/pago/webhook.ts, declarado en el archivo por la misma
// razon: gana sobre los globs de `vercel.json` sin depender del orden en que
// Vercel los resuelva. La justificacion del 300 esta en webhook.ts.
export const maxDuration = 300;

// Envoltorio fino, igual que api/cotizacion/[id].ts. La validacion de entorno
// vive en el handler, porque las pruebas lo ejercitan inyectando `env` en el
// factory (api/send.ts en cambio valida el entorno aqui mismo, en el
// envoltorio).
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createCrearHandler()(req, res);
}
