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
});
