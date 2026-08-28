import type { VercelRequest, VercelResponse } from '@vercel/node';
// Ruta relativa temporal: Vercel no transpila paquetes del workspace que llegan por
// node_modules (los trata como JS ya compilado); via ruta relativa entran al grafo de
// codigo fuente que si transpila. Volver a '@rr/mailer' cuando el paquete tenga build propio.
import { createMailer, createGmailTransport } from '../../../packages/mailer/src/index.js';
import { createSendHandler } from '../src/send.js';

const REQUIRED = ['MAILER_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'MAILER_FROM', 'MAILER_ALLOWED_RECIPIENTS'];

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    // Se nombran las que faltan; nunca sus valores.
    res.status(500).json({ ok: false, error: 'falta_configuracion', faltan: missing });
    return;
  }

  const transport = createGmailTransport({
    user: process.env.GMAIL_USER as string,
    appPassword: process.env.GMAIL_APP_PASSWORD as string,
  });

  return createSendHandler({
    mailer: createMailer(transport, process.env.MAILER_FROM as string),
    apiKey: process.env.MAILER_API_KEY as string,
    allowedRecipients: (process.env.MAILER_ALLOWED_RECIPIENTS as string)
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean),
  })(req, res);
}
