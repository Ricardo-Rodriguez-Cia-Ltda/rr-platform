import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVEEDORES } from '@rr/providers';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registro de proveedores', () => {
  it('expone intcomex', () => {
    expect(Object.keys(PROVEEDORES)).toContain('intcomex');
  });

  // Todo proveedor tiene que cumplir el contrato completo, o los handlers
  // genericos se rompen recien en runtime contra ese proveedor.
  it.each(Object.entries(PROVEEDORES))('%s cumple la interfaz Proveedor', (nombre, proveedor) => {
    expect(proveedor.nombre).toBe(nombre);
    expect(typeof proveedor.cargarCatalogo).toBe('function');
    expect(typeof proveedor.getPrecios).toBe('function');
    expect(typeof proveedor.getPrecio).toBe('function');
    expect(typeof proveedor.estaConfigurado).toBe('function');
    expect(proveedor.maxSkusPorLote).toBeGreaterThan(0);
  });
});

describe('estaConfigurado', () => {
  it('es false si falta alguna credencial de Intcomex', () => {
    vi.stubEnv('INTCOMEX_API_KEY', '');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
    expect(PROVEEDORES.intcomex.estaConfigurado()).toBe(false);
  });

  it('es true con las tres credenciales puestas', () => {
    vi.stubEnv('INTCOMEX_API_KEY', 'pub');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
    expect(PROVEEDORES.intcomex.estaConfigurado()).toBe(true);
  });
});
