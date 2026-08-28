import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '@rr/http/auth';
import { firstString } from '@rr/http/http';
import type { Mailer } from '@rr/mailer';

export interface SendDeps {
  mailer: Mailer;
  apiKey: string;
  allowedRecipients: string[];
}

function readMessage(body: unknown): { to: string; subject: string; html: string; text: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const fields = ['to', 'subject', 'html', 'text'] as const;
  for (const field of fields) {
    if (typeof raw[field] !== 'string' || raw[field] === '') return null;
  }
  return {
    to: raw.to as string,
    subject: raw.subject as string,
    html: raw.html as string,
    text: raw.text as string,
  };
}

export function createSendHandler(deps: SendDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'metodo_no_permitido' });
      return;
    }

    if (!isAuthorized(firstString(req.headers['x-api-key']), deps.apiKey)) {
      res.status(401).json({ ok: false, error: 'no_autorizado' });
      return;
    }

    const message = readMessage(req.body);
    if (!message) {
      res.status(400).json({ ok: false, error: 'cuerpo_invalido' });
      return;
    }

    // La lista blanca corta antes de enviar. Un endpoint de envio autenticado
    // solo por una clave es, si esa clave se filtra, un rele de spam a nombre
    // de nuestra cuenta.
    if (!deps.allowedRecipients.includes(message.to)) {
      res.status(403).json({ ok: false, error: 'destinatario_no_permitido' });
      return;
    }

    try {
      const result = await deps.mailer.send(message);
      res.status(200).json({ ok: true, id: result.id });
    } catch (_error) {
      // El error del transporte puede traer la credencial. No se propaga.
      res.status(502).json({ ok: false, error: 'el_envio_fallo' });
    }
  };
}
