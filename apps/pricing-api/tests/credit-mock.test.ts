import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const { default: handler } = await import('../api/credito/mock.js');

const CREDIT_LINE = 10_000_000;
const USED = 4_000_000;
const AVAILABLE = CREDIT_LINE - USED;

function makeReq(body: unknown, headers: Record<string, string> = {}, method = 'POST'): VercelRequest {
  return { body, headers, method, query: {} } as unknown as VercelRequest;
}

function makeRes(): { res: VercelResponse; status: () => number; body: () => any } {
  let code = 0;
  let payload: unknown;
  const res = {
    status(c: number) {
      code = c;
      return res;
    },
    json(p: unknown) {
      payload = p;
      return res;
    },
  } as unknown as VercelResponse;
  return { res, status: () => code, body: () => payload as any };
}

const AUTH = { 'x-api-key': 'test-secret' };

describe('POST /credito/mock', () => {
  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('contrato de acceso', () => {
    it('rechaza metodos distintos de POST', async () => {
      const { res, status, body } = makeRes();
      await handler(makeReq({}, AUTH, 'GET'), res);
      expect(status()).toBe(405);
      expect(body()).toMatchObject({ error: 'method_not_allowed' });
    });

    it('rechaza sin x-api-key', async () => {
      const { res, status, body } = makeRes();
      await handler(makeReq({ rut: '111111111', total_clp: 1000 }), res);
      expect(status()).toBe(401);
      expect(body()).toMatchObject({ error: 'unauthorized' });
    });

    it('rechaza con x-api-key incorrecta', async () => {
      const { res, status } = makeRes();
      await handler(makeReq({ rut: '111111111', total_clp: 1000 }, { 'x-api-key': 'otra' }), res);
      expect(status()).toBe(401);
    });
  });

  describe('validacion del cuerpo', () => {
    it('acepta el cuerpo como texto crudo (servidor local)', async () => {
      const { res, status, body } = makeRes();
      await handler(makeReq(JSON.stringify({ rut: '111111111', total_clp: 123456 }), AUTH), res);
      expect(status()).toBe(200);
      expect(body().solicitado_clp).toBe(123456);
    });

    it('acepta el cuerpo ya parseado (Vercel)', async () => {
      const { res, status, body } = makeRes();
      await handler(makeReq({ rut: '111111111', total_clp: 123456 }, AUTH), res);
      expect(status()).toBe(200);
      expect(body().solicitado_clp).toBe(123456);
    });

    it('rechaza JSON malformado', async () => {
      const { res, status, body } = makeRes();
      await handler(makeReq('{"rut":', AUTH), res);
      expect(status()).toBe(400);
      expect(body()).toMatchObject({ error: 'bad_request' });
    });

    it('rechaza un cuerpo que no es objeto', async () => {
      for (const rawBody of ['[1,2]', '"texto"', '42']) {
        const { res, status } = makeRes();
        await handler(makeReq(rawBody, AUTH), res);
        expect(status(), `cuerpo: ${rawBody}`).toBe(400);
      }
    });

    it('rechaza sin rut', async () => {
      const { res, status, body } = makeRes();
      await handler(makeReq({ total_clp: 1000 }, AUTH), res);
      expect(status()).toBe(400);
      expect(body().detail).toContain('rut');
    });

    it('rechaza un rut vacio o solo con separadores', async () => {
      for (const rut of ['', '   ', '-', '..-']) {
        const { res, status } = makeRes();
        await handler(makeReq({ rut, total_clp: 1000 }, AUTH), res);
        expect(status(), `rut: '${rut}'`).toBe(400);
      }
    });

    it('rechaza total_clp faltante, cero o negativo', async () => {
      for (const total_clp of [undefined, 0, -1]) {
        const { res, status } = makeRes();
        await handler(makeReq({ rut: '111111111', total_clp }, AUTH), res);
        expect(status(), `total_clp: ${total_clp}`).toBe(400);
      }
    });

    it('rechaza total_clp como string, aunque parezca un numero', async () => {
      // Coercionar aqui es peligroso: el resto de la API cotiza en USD y un
      // "1500" mal tipado podria venir en dolares.
      const { res, status, body } = makeRes();
      await handler(makeReq({ rut: '111111111', total_clp: '1500' }, AUTH), res);
      expect(status()).toBe(400);
      expect(body().detail).toContain('total_clp');
    });

    it('rechaza total_clp con decimales: el peso chileno no tiene centavos', async () => {
      const { res, status } = makeRes();
      await handler(makeReq({ rut: '111111111', total_clp: 1500.5 }, AUTH), res);
      expect(status()).toBe(400);
    });
  });

  describe('normalizacion del rut', () => {
    it('acepta el rut con puntos y guion y lo devuelve normalizado', async () => {
      const { res, status, body } = makeRes();
      await handler(makeReq({ rut: '11.111.111-1', total_clp: 1000 }, AUTH), res);
      expect(status()).toBe(200);
      expect(body().rut).toBe('111111111');
    });

    it('normaliza la K del digito verificador a mayuscula', async () => {
      const { res, body } = makeRes();
      await handler(makeReq({ rut: '12.345.678-k', total_clp: 1000 }, AUTH), res);
      expect(body().rut).toBe('12345678K');
    });
  });

  describe('logica de la linea de credito (hardcodeada)', () => {
    async function checkCredit(total_clp: number) {
      const { res, status, body } = makeRes();
      await handler(makeReq({ rut: '111111111', total_clp }, AUTH), res);
      return { status: status(), body: body() };
    }

    it('siempre reporta la misma linea, sin importar el rut', async () => {
      const { res, body } = makeRes();
      await handler(makeReq({ rut: '99999999-9', total_clp: 1000 }, AUTH), res);
      expect(body()).toMatchObject({
        linea_credito_clp: CREDIT_LINE,
        utilizado_clp: USED,
        disponible_clp: AVAILABLE,
        habilitado: true,
        moneda: 'CLP',
      });
    });

    it('se marca como mock en la respuesta', async () => {
      const { body } = await checkCredit(1000);
      expect(body.mock).toBe(true);
    });

    it('aprueba un monto bajo el disponible', async () => {
      const { status, body } = await checkCredit(123_456);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        aprobado: true,
        motivo: 'dentro_de_linea',
        solicitado_clp: 123_456,
        faltante_clp: 0,
      });
    });

    it('aprueba un monto exactamente igual al disponible', async () => {
      const { body } = await checkCredit(AVAILABLE);
      expect(body).toMatchObject({ aprobado: true, faltante_clp: 0 });
    });

    it('rechaza un peso sobre el disponible', async () => {
      const { body } = await checkCredit(AVAILABLE + 1);
      expect(body).toMatchObject({ aprobado: false, motivo: 'excede_linea', faltante_clp: 1 });
    });

    it('rechaza 12 millones y dice cuanto falta', async () => {
      // El caso del encargo: linea 10M, gastado 4M, disponible 6M.
      const { status, body } = await checkCredit(12_000_000);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        aprobado: false,
        motivo: 'excede_linea',
        disponible_clp: 6_000_000,
        solicitado_clp: 12_000_000,
        faltante_clp: 6_000_000,
      });
    });

    it('un rechazo sigue siendo 200: la consulta funciono, la respuesta es "no"', async () => {
      const { status } = await checkCredit(50_000_000);
      expect(status).toBe(200);
    });
  });
});
