import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skusConStock, soltarCandado, tomarCandado } from '../src/fotos/correr.js';

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

describe('candado entre procesos', () => {
  afterEach(() => vi.restoreAllMocks());
  const candado = (dir: string) => join(dir, 'fotos.lock');
  // Un pid que no existe: muy por encima del maximo de cualquier sistema.
  const PID_MUERTO = 2 ** 31 - 2;

  it('se toma en un directorio vacio y guarda el pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candado-'));
    expect(tomarCandado(dir)).toBe(true);
    const datos = JSON.parse(readFileSync(candado(dir), 'utf8')) as { pid: number; inicio: string };
    expect(datos.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(datos.inicio))).toBe(false);
  });

  it('no se toma dos veces mientras el duenio sigue vivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candado-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(tomarCandado(dir)).toBe(true);
    expect(tomarCandado(dir)).toBe(false);
    expect(log).toHaveBeenCalledWith(`[fotos] otra corrida en curso (pid ${process.pid}); se omite`);
  });

  it('un candado de un pid muerto esta vencido y se retoma', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candado-'));
    writeFileSync(candado(dir), JSON.stringify({ pid: PID_MUERTO, inicio: new Date().toISOString() }));
    expect(tomarCandado(dir)).toBe(true);
    expect(JSON.parse(readFileSync(candado(dir), 'utf8')).pid).toBe(process.pid);
  });

  it('un candado de mas de 12 horas esta vencido aunque el pid viva', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candado-'));
    const viejo = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
    writeFileSync(candado(dir), JSON.stringify({ pid: process.ppid, inicio: viejo }));
    expect(tomarCandado(dir)).toBe(true);
    expect(JSON.parse(readFileSync(candado(dir), 'utf8')).pid).toBe(process.pid);
  });

  it('soltar borra el archivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candado-'));
    expect(tomarCandado(dir)).toBe(true);
    soltarCandado(dir);
    expect(existsSync(candado(dir))).toBe(false);
  });

  it('soltar no borra un candado ajeno', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candado-'));
    writeFileSync(candado(dir), JSON.stringify({ pid: process.ppid, inicio: new Date().toISOString() }));
    soltarCandado(dir);
    expect(existsSync(candado(dir))).toBe(true);
  });
});
