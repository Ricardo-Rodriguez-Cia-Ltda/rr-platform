import { describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSendHandler } from '../src/send.js';

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res as unknown as VercelResponse & { statusCode: number; body: any };
}

function req(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: { 'x-api-key': 'clave-buena' },
    body: { to: 'interno@ejemplo.cl', subject: 's', html: '<p>h</p>', text: 't' },
    ...overrides,
  } as VercelRequest;
}

const deps = (send = vi.fn(async () => ({ id: '<abc>' }))) => ({
  mailer: { send },
  apiKey: 'clave-buena',
  allowedRecipients: ['interno@ejemplo.cl'],
});

describe('POST /api/send', () => {
  it('envia y devuelve el id', async () => {
    const send = vi.fn(async () => ({ id: '<abc>' }));
    const res = fakeRes();
    await createSendHandler(deps(send))(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, id: '<abc>' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('rechaza sin clave', async () => {
    const send = vi.fn();
    const res = fakeRes();
    await createSendHandler(deps(send))(req({ headers: {} }), res);
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza con clave incorrecta', async () => {
    const send = vi.fn();
    const res = fakeRes();
    await createSendHandler(deps(send))(req({ headers: { 'x-api-key': 'otra' } }), res);
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza un destinatario fuera de la lista SIN llamar al transporte', async () => {
    const send = vi.fn();
    const res = fakeRes();
    await createSendHandler(deps(send))(
      req({ body: { to: 'ajeno@spam.cl', subject: 's', html: 'h', text: 't' } }),
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'destinatario_no_permitido' });
    // Lo que importa: la lista blanca corta ANTES de enviar, no despues.
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza un cuerpo incompleto', async () => {
    const send = vi.fn();
    const res = fakeRes();
    await createSendHandler(deps(send))(
      req({ body: { to: 'interno@ejemplo.cl', subject: 's' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza metodos que no son POST', async () => {
    const res = fakeRes();
    await createSendHandler(deps())(req({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('traduce el fallo del transporte a 502 sin filtrar la credencial', async () => {
    const send = vi.fn(async () => {
      throw new Error('535 rechazado para user=x pass=SECRETO123');
    });
    const res = fakeRes();
    await createSendHandler(deps(send))(req(), res);
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('SECRETO123');
  });
});
