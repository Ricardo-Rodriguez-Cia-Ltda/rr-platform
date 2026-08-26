import { describe, expect, it } from 'vitest';
import { cargarHandler, peticion } from './cargar.js';

const decision = cargarHandler('docs/kapso/functions-v2/route-quote-decision-v2.js');
const validez = cargarHandler('docs/kapso/functions-v2/check-quote-validity-v2.js');
const rut = cargarHandler('docs/kapso/functions-v2/route-rut-v2.js');

async function rutear(handler: ReturnType<typeof cargarHandler>, vars: unknown, edges: string[]) {
  const res = await handler(peticion({ execution_context: { vars }, available_edges: edges }), {});
  return (await res.json()) as { next_edge: string };
}

describe('route-quote-decision-v2', () => {
  it('rutea accepted', async () => {
    expect((await rutear(decision, { quote_decision: 'accepted' }, ['accepted', 'rejected'])).next_edge).toBe('accepted');
  });

  it('rutea rejected', async () => {
    expect((await rutear(decision, { quote_decision: 'rejected' }, ['accepted', 'rejected'])).next_edge).toBe('rejected');
  });

  it('ante un valor desconocido cae en rejected, que es lo reversible', async () => {
    expect((await rutear(decision, { quote_decision: 'pending' }, ['accepted', 'rejected'])).next_edge).toBe('rejected');
    expect((await rutear(decision, {}, ['accepted', 'rejected'])).next_edge).toBe('rejected');
  });
});

describe('check-quote-validity-v2', () => {
  it('vigente si valid_until esta en el futuro', async () => {
    const futuro = new Date(Date.now() + 3600000).toISOString();
    expect((await rutear(validez, { quote_result: { valid_until: futuro } }, ['valid', 'expired'])).next_edge).toBe('valid');
  });

  it('expirada si valid_until ya paso', async () => {
    const pasado = new Date(Date.now() - 1000).toISOString();
    expect((await rutear(validez, { quote_result: { valid_until: pasado } }, ['valid', 'expired'])).next_edge).toBe('expired');
  });

  it('expirada si no hay fecha: no se emite a ciegas', async () => {
    expect((await rutear(validez, {}, ['valid', 'expired'])).next_edge).toBe('expired');
  });
});

describe('route-rut-v2', () => {
  it('valid solo con rut_valid true', async () => {
    expect((await rutear(rut, { rut_valid: true }, ['valid', 'invalid'])).next_edge).toBe('valid');
  });

  it('invalid cuando el rut no paso la validacion', async () => {
    expect((await rutear(rut, { rut_valid: false }, ['valid', 'invalid'])).next_edge).toBe('invalid');
  });

  it('invalid cuando no hay dato, a diferencia del route-rut de v1', async () => {
    expect((await rutear(rut, {}, ['valid', 'invalid'])).next_edge).toBe('invalid');
  });
});
