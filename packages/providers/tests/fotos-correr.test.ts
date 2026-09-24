import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skusConStock } from '../src/fotos/correr.js';

describe('skusConStock', () => {
  it('lee el cache de precios y devuelve los SKU con stock > 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-'));
    writeFileSync(join(dir, 'prices-intcomex.json'), JSON.stringify({ entries: {
      I1: { info: { price: 1, currency: 'USD', inStock: 3 }, quotedAt: 1 },
      I2: { info: { price: 1, currency: 'USD', inStock: 0 }, quotedAt: 1 },
      I3: { info: null, quotedAt: 1 },
    } }));
    writeFileSync(join(dir, 'prices-ingram.json'), '{corrupto');
    const s = skusConStock(dir, ['intcomex', 'ingram', 'tecnoglobal']);
    expect([...s]).toEqual(['intcomex:I1']);
  });

  it('agrega el stock del volcado de precios de Tecnoglobal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-tg-'));
    writeFileSync(join(dir, 'tecnoglobal-precios.json'), JSON.stringify({
      productos: [
        { codigoTg: 'TG1', stockDisp: 5, precio: 10 },
        { codigoTg: 'TG2', stockDisp: 0, precio: 10 },
      ],
      obtenidaEn: '2026-09-24T00:00:00.000Z',
    }));
    expect([...skusConStock(dir, ['tecnoglobal'])]).toEqual(['tecnoglobal:TG1']);
  });

  it('un volcado de Tecnoglobal corrupto se ignora', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-tg-'));
    writeFileSync(join(dir, 'tecnoglobal-precios.json'), '{corrupto');
    expect(skusConStock(dir, ['tecnoglobal']).size).toBe(0);
  });
});
