import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createMailer, createGmailTransport } from '@rr/mailer';
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
