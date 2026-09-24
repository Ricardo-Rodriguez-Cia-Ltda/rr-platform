import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedProduct } from '@rr/domain/product';

const asegurarBucket = vi.fn(async () => {});
vi.mock('../src/fotos/storage.js', () => ({
  crearStorage: () => ({ asegurarBucket, subir: vi.fn() }),
}));
vi.mock('../src/fotos/banco.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/fotos/banco.js')>()),
  actualizarBancoFotos: vi.fn(),
}));

import { actualizarBancoFotos } from '../src/fotos/banco.js';
import { correrBancoFotos } from '../src/fotos/correr.js';

const producto = (sku: string, mpn: string): NormalizedProduct => ({
  sku, mpn, marca: 'HP', nombre: `Producto ${mpn}`, categoria: null, subcategorias: [], tipo: null,
});
const CATALOGOS = { intcomex: [producto('I1', 'CE310A'), producto('I2', 'CE311A')] };

describe('correrBancoFotos', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'correr-'));
    vi.stubEnv('CATALOG_CACHE_DIR', dir);
    vi.stubEnv('SUPABASE_URL', 'https://proyecto.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key');
    vi.stubEnv('ICECAT_USER', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    asegurarBucket.mockReset().mockResolvedValue(undefined);
    vi.mocked(actualizarBancoFotos).mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sin catalogos no toca el indice ni la lista de faltantes', async () => {
    expect(await correrBancoFotos({})).toBeNull();
    expect(console.log).toHaveBeenCalledWith('[fotos] sin catalogos cargados; nada que hacer');
    expect(actualizarBancoFotos).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'fotos.json'))).toBe(false);
    expect(existsSync(join(dir, 'fotos-faltantes.csv'))).toBe(false);
    expect(existsSync(join(dir, 'fotos.lock'))).toBe(false);
  });

  it('una corrida cortada igual escribe la lista con el avance y suelta el candado', async () => {
    vi.mocked(actualizarBancoFotos).mockImplementation(async (deps) => {
      deps.indice.fotos['ce310a|hp'] = { url: 'https://x/hp/ce310a.jpg', fuente: 'intcomex', obtenidaEn: 'x' };
      throw new Error('Supabase Storage no respondio al subir hp/ce311a.jpg: timeout');
    });
    await expect(correrBancoFotos(CATALOGOS)).rejects.toThrow(/no respondio/);
    const csv = readFileSync(join(dir, 'fotos-faltantes.csv'), 'utf8');
    expect(csv).toContain('CE311A');
    expect(csv).not.toContain('CE310A');
    expect(existsSync(join(dir, 'fotos.lock'))).toBe(false);
  });

  it('si el storage no responde no escribe la lista', async () => {
    asegurarBucket.mockRejectedValue(new Error('Supabase Storage respondio HTTP 403'));
    await expect(correrBancoFotos(CATALOGOS)).rejects.toThrow(/403/);
    expect(existsSync(join(dir, 'fotos-faltantes.csv'))).toBe(false);
    expect(existsSync(join(dir, 'fotos.lock'))).toBe(false);
  });
});
