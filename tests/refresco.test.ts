import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refrescarTodos } from '../lib/refresco.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('refrescarTodos', () => {
  // Que un proveedor este caido no puede dejar sin catalogo a los demas: hoy
  // server.ts carga uno solo y un throw ahi mata el refresco entero.
  it('carga los demas proveedores aunque uno falle', async () => {
    const cargar = vi.fn(async (p: string) => {
      if (p === 'ingram') throw new Error('ingram caido');
      return [];
    });

    await refrescarTodos(['ingram', 'intcomex'], cargar);

    expect(cargar).toHaveBeenCalledTimes(2);
    expect(cargar).toHaveBeenCalledWith('intcomex');
  });

  it('no rechaza aunque fallen todos', async () => {
    const cargar = vi.fn().mockRejectedValue(new Error('todo caido'));
    await expect(refrescarTodos(['a', 'b'], cargar)).resolves.toBeUndefined();
  });

  it('avisa solo por los proveedores que fallaron', async () => {
    const cargar = vi.fn(async (p: string) => {
      if (p === 'ingram') throw new Error('caido');
      return [];
    });
    const alFallar = vi.fn();

    await refrescarTodos(['ingram', 'intcomex'], cargar, alFallar);

    expect(alFallar).toHaveBeenCalledTimes(1);
    expect(alFallar).toHaveBeenCalledWith('ingram');
  });

  it('los carga en paralelo, no en cadena', async () => {
    let simultaneos = 0;
    let pico = 0;
    const cargar = vi.fn(async () => {
      simultaneos += 1;
      pico = Math.max(pico, simultaneos);
      await Promise.resolve();
      simultaneos -= 1;
      return [];
    });

    await refrescarTodos(['a', 'b', 'c'], cargar);

    expect(pico).toBeGreaterThan(1);
  });
});
