import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { construirManifiesto, firmaValida, parseSignature } from '../src/pago/firma.js';

const SECRET = 'secreto-de-prueba';
const DATA_ID = '123456789';
const REQUEST_ID = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';
const TS = '1742505638683';

function firmar(manifiesto: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifiesto).digest('hex');
}

describe('parseSignature', () => {
  it('extrae ts y v1 del header', () => {
    expect(parseSignature(`ts=${TS},v1=abc123`)).toEqual({ ts: TS, v1: 'abc123' });
  });

  it('tolera espacios y orden invertido', () => {
    expect(parseSignature(` v1=abc123 , ts=${TS} `)).toEqual({ ts: TS, v1: 'abc123' });
  });

  it('sin header, sin ts o sin v1 devuelve null', () => {
    expect(parseSignature(undefined)).toBeNull();
    expect(parseSignature('ts=1')).toBeNull();
    expect(parseSignature('v1=abc')).toBeNull();
    expect(parseSignature('basura')).toBeNull();
  });
});

describe('construirManifiesto', () => {
  it('arma el template completo con el id en minusculas', () => {
    expect(construirManifiesto('ABC123', REQUEST_ID, TS))
      .toBe(`id:abc123;request-id:${REQUEST_ID};ts:${TS};`);
  });

  it('omite request-id cuando no llego en la notificacion', () => {
    expect(construirManifiesto(DATA_ID, undefined, TS)).toBe(`id:${DATA_ID};ts:${TS};`);
  });
});

describe('firmaValida', () => {
  it('acepta una firma legitima', () => {
    const header = `ts=${TS},v1=${firmar(construirManifiesto(DATA_ID, REQUEST_ID, TS))}`;
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header, secret: SECRET })).toBe(true);
  });

  it('rechaza una firma de otro secreto', () => {
    const header = `ts=${TS},v1=${firmar(construirManifiesto(DATA_ID, REQUEST_ID, TS), 'otro')}`;
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header, secret: SECRET })).toBe(false);
  });

  it('rechaza cuando el dataId no es el firmado (replay contra otro pago)', () => {
    const header = `ts=${TS},v1=${firmar(construirManifiesto(DATA_ID, REQUEST_ID, TS))}`;
    expect(firmaValida({ dataId: '999', requestId: REQUEST_ID, header, secret: SECRET })).toBe(false);
  });

  it('rechaza header ausente, malformado o secreto vacio', () => {
    const header = `ts=${TS},v1=${firmar(construirManifiesto(DATA_ID, REQUEST_ID, TS))}`;
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header: undefined, secret: SECRET })).toBe(false);
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header: 'basura', secret: SECRET })).toBe(false);
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header, secret: '' })).toBe(false);
  });

  it('una v1 de largo distinto no revienta, devuelve false', () => {
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header: `ts=${TS},v1=ab`, secret: SECRET })).toBe(false);
  });
});
