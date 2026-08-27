import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredProviders, refreshAll } from '@rr/domain/refresh';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('refreshAll', () => {
  // Que un proveedor este caido no puede dejar sin catalogo a los demas: hoy
  // server.ts carga uno solo y un throw ahi mata el refresco entero.
  it('carga los demas proveedores aunque uno falle', async () => {
    const cargar = vi.fn(async (p: string) => {
      if (p === 'ingram') throw new Error('ingram caido');
      return [];
    });

    await refreshAll(['ingram', 'intcomex'], cargar);

    expect(cargar).toHaveBeenCalledTimes(2);
    expect(cargar).toHaveBeenCalledWith('intcomex');
  });

  it('no rechaza aunque fallen todos', async () => {
    const cargar = vi.fn().mockRejectedValue(new Error('todo caido'));
    await expect(refreshAll(['a', 'b'], cargar)).resolves.toBeUndefined();
  });

  it('avisa solo por los proveedores que fallaron', async () => {
    const cargar = vi.fn(async (p: string) => {
      if (p === 'ingram') throw new Error('caido');
      return [];
    });
    const alFallar = vi.fn();

    await refreshAll(['ingram', 'intcomex'], cargar, alFallar);

    expect(alFallar).toHaveBeenCalledTimes(1);
    expect(alFallar).toHaveBeenCalledWith('ingram', expect.any(Error));
  });

  // Quien agenda el reintento necesita el error para decidir cuanto esperar:
  // un rechazo por cuota no se reintenta al mismo ritmo que una caida.
  it('entrega el error que provoco la falla, no solo el nombre', async () => {
    const boom = new Error('exceso de llamadas');
    const alFallar = vi.fn();

    await refreshAll(['tecnoglobal'], vi.fn().mockRejectedValue(boom), alFallar);

    expect(alFallar).toHaveBeenCalledWith('tecnoglobal', boom);
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

    await refreshAll(['a', 'b', 'c'], cargar);

    expect(pico).toBeGreaterThan(1);
  });
});

describe('configuredProviders', () => {
  // Ingram y cualquier proveedor nuevo viven sin credenciales hasta que TI las
  // entrega. Intentar refrescarlos igual llena el log de fallas esperadas y
  // agenda un reintento cada 5 minutos que nunca va a funcionar.
  it('deja fuera a los proveedores sin credenciales', () => {
    const registro = {
      listo: { isConfigured: () => true },
      pendiente: { isConfigured: () => false },
    };

    expect(configuredProviders(registro)).toEqual(['listo']);
  });

  it('devuelve vacio si no hay ninguno configurado', () => {
    expect(configuredProviders({ a: { isConfigured: () => false } })).toEqual([]);
  });
});
