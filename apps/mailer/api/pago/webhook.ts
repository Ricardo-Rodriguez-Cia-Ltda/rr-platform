import type { VercelRequest, VercelResponse } from '@vercel/node';
import { crearAlertar } from '../../src/pago/alerta.js';
import { createWebhookHandler } from '../../src/pago/webhook.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createWebhookHandler(crearAlertar(process.env))(req, res);
}
