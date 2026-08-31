import { describe, expect, it } from 'vitest';
import { loadHandler, request } from './load.js';

const router = loadHandler('apps/kapso-agent/functions/router-v2.js');

async function route(vars: unknown, edges: string[]) {
  const res = await router(request({ execution_context: { vars }, available_edges: edges }), {});
  return (await res.json()) as { next_edge: string; vars?: { quote_expired: boolean } };
}

describe('router-v2: decision del cliente sobre la cotizacion', () => {
  it('rutea accepted', async () => {
    expect((await route({ quote_decision: 'accepted' }, ['accepted', 'rejected'])).next_edge).toBe('accepted');
  });

  it('rutea rejected', async () => {
    expect((await route({ quote_decision: 'rejected' }, ['accepted', 'rejected'])).next_edge).toBe('rejected');
  });

  it('ante un valor desconocido cae en rejected, que es lo reversible', async () => {
    expect((await route({ quote_decision: 'pending' }, ['accepted', 'rejected'])).next_edge).toBe('rejected');
    expect((await route({}, ['accepted', 'rejected'])).next_edge).toBe('rejected');
  });
});

describe('router-v2: vigencia de la cotizacion', () => {
  it('vigente si valid_until esta en el futuro', async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    expect((await route({ quote_result: { valid_until: future } }, ['valid', 'expired'])).next_edge).toBe('valid');
  });

  it('expirada si valid_until ya paso', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect((await route({ quote_result: { valid_until: past } }, ['valid', 'expired'])).next_edge).toBe('expired');
  });

  it('expirada si no hay fecha: no se emite a ciegas', async () => {
    expect((await route({}, ['valid', 'expired'])).next_edge).toBe('expired');
  });

  it('expone quote_expired para que el flujo lo pueda leer', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect((await route({ quote_valid_until: past }, ['valid', 'expired'])).vars).toEqual({ quote_expired: true });
  });
});

describe('router-v2: resultado de la validacion de RUT', () => {
  it('valid solo con rut_valid true', async () => {
    expect((await route({ rut_valid: true }, ['valid', 'invalid'])).next_edge).toBe('valid');
  });

  it('invalid cuando el rut no paso la validacion', async () => {
    expect((await route({ rut_valid: false }, ['valid', 'invalid'])).next_edge).toBe('invalid');
  });

  it('invalid cuando no hay dato, a diferencia del route-rut de v1', async () => {
    expect((await route({}, ['valid', 'invalid'])).next_edge).toBe('invalid');
  });
});

// Estas son las que protegen la fusion. Los tres nodos comparten una function,
// asi que lo unico que los separa son sus aristas: si el despacho se confunde,
// el RUT invalido podria terminar rejectando una cotizacion, o al reves.
describe('router-v2: despacho entre las tres decisiones', () => {
  it('no confunde la vigencia con el RUT, que comparten la arista valid', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    // Mismos vars, aristas distintas: cada nodo recibe su propia respuesta.
    const vars = { rut_valid: true, quote_result: { valid_until: past } };
    expect((await route(vars, ['valid', 'expired'])).next_edge).toBe('expired');
    expect((await route(vars, ['valid', 'invalid'])).next_edge).toBe('valid');
  });

  it('la decision de la cotizacion gana aunque haya datos de las otras dos', async () => {
    const vars = { rut_valid: false, quote_decision: 'accepted', quote_valid_until: '' };
    expect((await route(vars, ['accepted', 'rejected'])).next_edge).toBe('accepted');
  });

  it('con aristas desconocidas toma la primera en vez de reventar', async () => {
    expect((await route({}, ['seguir', 'terminar'])).next_edge).toBe('seguir');
  });

  it('sin aristas devuelve vacio sin lanzar', async () => {
    expect((await route({}, [])).next_edge).toBe('');
  });
});
