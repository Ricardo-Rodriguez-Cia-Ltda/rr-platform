import { describe, expect, it, vi } from 'vitest';
import { crearAlertar } from '../src/pago/alerta.js';

const ENV = {
  GMAIL_USER: 'interna@ejemplo.cl', GMAIL_APP_PASSWORD: 'x',
  MAILER_FROM: 'interna@ejemplo.cl', MAILER_ALLOWED_RECIPIENTS: 'interna@ejemplo.cl',
};

describe('crearAlertar', () => {
  it('manda el asunto y el detalle a la casilla interna', async () => {
    const send = vi.fn(async (_mensaje: unknown) => ({ id: 'msg-1' }));
    await crearAlertar(ENV, { send } as any)('Pago sin emitir', 'cotizacion X');
    expect(send).toHaveBeenCalledTimes(1);
    const mensaje = send.mock.calls[0][0] as any;
    expect(mensaje.to).toBe('interna@ejemplo.cl');
    expect(mensaje.subject).toContain('Pago sin emitir');
    expect(mensaje.text).toContain('cotizacion X');
  });

  it('un fallo del envio no propaga: la alerta es best-effort', async () => {
    const send = vi.fn(async () => { throw new Error('EAUTH'); });
    await expect(crearAlertar(ENV, { send } as any)('a', 'b')).resolves.toBeUndefined();
  });

  it('sin destinatario configurado no revienta', async () => {
    const send = vi.fn();
    await crearAlertar({ ...ENV, MAILER_ALLOWED_RECIPIENTS: '' }, { send } as any)('a', 'b');
    expect(send).not.toHaveBeenCalled();
  });
});
