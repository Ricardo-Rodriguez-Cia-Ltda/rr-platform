import { describe, expect, it, vi } from 'vitest';
import { createMailer } from '@rr/mailer';

describe('createMailer', () => {
  it('arma el mensaje con el remitente configurado', async () => {
    const sendMail = vi.fn(async () => ({ messageId: '<abc@gmail.com>' }));
    const mailer = createMailer({ sendMail }, 'ordenes@ejemplo.cl');

    await mailer.send({
      to: 'destino@ejemplo.cl',
      subject: 'Asunto',
      html: '<p>hola</p>',
      text: 'hola',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'ordenes@ejemplo.cl',
      to: 'destino@ejemplo.cl',
      subject: 'Asunto',
      html: '<p>hola</p>',
      text: 'hola',
    });
  });

  it('devuelve el messageId del transporte', async () => {
    const mailer = createMailer(
      { sendMail: async () => ({ messageId: '<xyz@gmail.com>' }) },
      'ordenes@ejemplo.cl',
    );
    const result = await mailer.send({ to: 'a@b.cl', subject: 's', html: 'h', text: 't' });
    expect(result).toEqual({ id: '<xyz@gmail.com>' });
  });

  it('propaga el error del transporte', async () => {
    const mailer = createMailer(
      { sendMail: async () => { throw new Error('535 autenticacion rechazada'); } },
      'ordenes@ejemplo.cl',
    );
    await expect(mailer.send({ to: 'a@b.cl', subject: 's', html: 'h', text: 't' }))
      .rejects.toThrow('535 autenticacion rechazada');
  });
});
