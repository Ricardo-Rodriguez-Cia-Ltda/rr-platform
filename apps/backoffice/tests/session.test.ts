import { describe, expect, it } from 'vitest';
import { crearToken, tokenValido, VIGENCIA_MS } from '../src/lib/session.js';

const SECRET = 'secreto-de-prueba';
const AHORA = 1_756_000_000_000;

describe('sesion', () => {
  it('un token recien creado es valido', async () => {
    const token = await crearToken(SECRET, AHORA);
    expect(await tokenValido(token, SECRET, AHORA)).toBe(true);
  });
  it('expira a los 30 dias', async () => {
    const token = await crearToken(SECRET, AHORA);
    expect(await tokenValido(token, SECRET, AHORA + VIGENCIA_MS - 1)).toBe(true);
    expect(await tokenValido(token, SECRET, AHORA + VIGENCIA_MS + 1)).toBe(false);
  });
  it('un token adulterado (fecha o firma) no valida', async () => {
    const token = await crearToken(SECRET, AHORA);
    const [exp, firma] = token.split('.');
    expect(await tokenValido(`${Number(exp) + 9999}.${firma}`, SECRET, AHORA)).toBe(false);
    expect(await tokenValido(`${exp}.${firma}x`, SECRET, AHORA)).toBe(false);
  });
  it('con otro secreto no valida', async () => {
    const token = await crearToken(SECRET, AHORA);
    expect(await tokenValido(token, 'otro', AHORA)).toBe(false);
  });
  it('undefined, vacio, sin punto, o secreto vacio: false, sin lanzar', async () => {
    expect(await tokenValido(undefined, SECRET, AHORA)).toBe(false);
    expect(await tokenValido('', SECRET, AHORA)).toBe(false);
    expect(await tokenValido('sinpunto', SECRET, AHORA)).toBe(false);
    const token = await crearToken(SECRET, AHORA);
    expect(await tokenValido(token, '', AHORA)).toBe(false);
  });
});
