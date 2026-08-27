import { describe, expect, it } from 'vitest';
import { loadHandler, request } from './load.js';

const decision = loadHandler('apps/kapso-agent/functions/route-quote-decision-v2.js');
const validity = loadHandler('apps/kapso-agent/functions/check-quote-validity-v2.js');
const rut = loadHandler('apps/kapso-agent/functions/route-rut-v2.js');

async function route(handler: ReturnType<typeof loadHandler>, vars: unknown, edges: string[]) {
  const res = await handler(request({ execution_context: { vars }, available_edges: edges }), {});
  return (await res.json()) as { next_edge: string };
}

describe('route-quote-decision-v2', () => {
  it('rutea accepted', async () => {
    expect((await route(decision, { quote_decision: 'accepted' }, ['accepted', 'rejected'])).next_edge).toBe('accepted');
  });

  it('rutea rejected', async () => {
    expect((await route(decision, { quote_decision: 'rejected' }, ['accepted', 'rejected'])).next_edge).toBe('rejected');
  });

  it('ante un valor desconocido cae en rejected, que es lo reversible', async () => {
    expect((await route(decision, { quote_decision: 'pending' }, ['accepted', 'rejected'])).next_edge).toBe('rejected');
    expect((await route(decision, {}, ['accepted', 'rejected'])).next_edge).toBe('rejected');
  });
});

describe('check-quote-validity-v2', () => {
  it('vigente si valid_until esta en el futuro', async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    expect((await route(validity, { quote_result: { valid_until: future } }, ['valid', 'expired'])).next_edge).toBe('valid');
  });

  it('expirada si valid_until ya paso', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect((await route(validity, { quote_result: { valid_until: past } }, ['valid', 'expired'])).next_edge).toBe('expired');
  });

  it('expirada si no hay fecha: no se emite a ciegas', async () => {
    expect((await route(validity, {}, ['valid', 'expired'])).next_edge).toBe('expired');
  });
});

describe('route-rut-v2', () => {
  it('valid solo con rut_valid true', async () => {
    expect((await route(rut, { rut_valid: true }, ['valid', 'invalid'])).next_edge).toBe('valid');
  });

  it('invalid cuando el rut no paso la validacion', async () => {
    expect((await route(rut, { rut_valid: false }, ['valid', 'invalid'])).next_edge).toBe('invalid');
  });

  it('invalid cuando no hay dato, a diferencia del route-rut de v1', async () => {
    expect((await route(rut, {}, ['valid', 'invalid'])).next_edge).toBe('invalid');
  });
});
