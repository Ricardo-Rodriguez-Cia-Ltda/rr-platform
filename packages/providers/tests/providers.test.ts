import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '@rr/providers';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registro de proveedores', () => {
  it('expone intcomex', () => {
    expect(Object.keys(PROVIDERS)).toContain('intcomex');
  });

  // Todo proveedor tiene que cumplir el contrato completo, o los handlers
  // genericos se rompen recien en runtime contra ese proveedor.
  it.each(Object.entries(PROVIDERS))('%s cumple la interfaz Provider', (nombre, proveedor) => {
    expect(proveedor.name).toBe(nombre);
    expect(typeof proveedor.loadCatalog).toBe('function');
    expect(typeof proveedor.getPrices).toBe('function');
    expect(typeof proveedor.getPrice).toBe('function');
    expect(typeof proveedor.isConfigured).toBe('function');
    expect(proveedor.maxSkusPerBatch).toBeGreaterThan(0);
  });
});

describe('isConfigured', () => {
  it('es false si falta alguna credencial de Intcomex', () => {
    vi.stubEnv('INTCOMEX_API_KEY', '');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
    expect(PROVIDERS.intcomex.isConfigured()).toBe(false);
  });

  it('es true con las tres credenciales puestas', () => {
    vi.stubEnv('INTCOMEX_API_KEY', 'pub');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
    expect(PROVIDERS.intcomex.isConfigured()).toBe(true);
  });
});
