import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  crearPago, leerCotizacion, leerPago, marcarEstado,
  marcarPedidosPagados, reclamarAprobado, sumarRechazo,
} from '../src/pago/datos.js';

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave' };
const QUOTE = 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4';

afterEach(() => vi.unstubAllGlobals());

function stub(responder: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (url: any, init?: RequestInit) => responder(String(url), init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('leerCotizacion', () => {
  it('devuelve la fila', async () => {
    stub(() => new Response(JSON.stringify([{ quote_id: QUOTE, total_clp: 1190 }]), { status: 200 }));
    expect((await leerCotizacion(ENV, QUOTE))?.total_clp).toBe(1190);
  });

  it('distingue "no existe" (null) de "no se pudo preguntar" (undefined)', async () => {
    stub(() => new Response('[]', { status: 200 }));
    expect(await leerCotizacion(ENV, QUOTE)).toBeNull();
    stub(() => new Response('{}', { status: 500 }));
    expect(await leerCotizacion(ENV, QUOTE)).toBeUndefined();
  });
});

describe('reclamarAprobado', () => {
  it('condiciona el PATCH a estado=pendiente y devuelve true si tomo la fila', async () => {
    const spy = stub((url) => {
      expect(url).toContain('quote_id=eq.' + QUOTE);
      expect(url).toContain('estado=eq.pendiente');
      return new Response(JSON.stringify([{ quote_id: QUOTE }]), { status: 200 });
    });
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBe(true);
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.estado).toBe('aprobado');
    expect(body.mp_payment_id).toBe('999');
    expect(body.aprobado_at).toBeTruthy();
  });

  it('cero filas significa que otra entrega del webhook ya la tomo', async () => {
    stub(() => new Response('[]', { status: 200 }));
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBe(false);
  });

  it('un fallo de Supabase devuelve false: no se emite a ciegas', async () => {
    stub(() => new Response('{}', { status: 500 }));
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBe(false);
  });
});

describe('marcarPedidosPagados', () => {
  it('solo toca los pedidos que siguen en nuevo', async () => {
    const spy = stub((url) => {
      expect(url).toContain('estado_negocio=eq.nuevo');
      return new Response('[]', { status: 200 });
    });
    expect(await marcarPedidosPagados(ENV, QUOTE)).toBe(true);
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.estado_negocio).toBe('pagado');
    expect(body.pagado_at).toBeTruthy();
  });
});

describe('sumarRechazo', () => {
  it('no cambia el estado, solo el contador y el ultimo payment id', async () => {
    const spy = stub(() => new Response(JSON.stringify([{ intentos_rechazados: 1 }]), { status: 200 }));
    await sumarRechazo(ENV, QUOTE, '999');
    const body = JSON.parse(String((spy.mock.calls.at(-1)![1] as RequestInit).body));
    expect(body).not.toHaveProperty('estado');
    expect(body.mp_payment_id).toBe('999');
  });
});

describe('crearPago, leerPago y marcarEstado', () => {
  it('crearPago postea la fila y devuelve true', async () => {
    const spy = stub(() => new Response('[]', { status: 201 }));
    expect(await crearPago(ENV, { quote_id: QUOTE } as any)).toBe(true);
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('leerPago devuelve null cuando no hay fila', async () => {
    stub(() => new Response('[]', { status: 200 }));
    expect(await leerPago(ENV, QUOTE)).toBeNull();
  });

  it('marcarEstado escribe el estado y los extras', async () => {
    const spy = stub(() => new Response('[]', { status: 200 }));
    expect(await marcarEstado(ENV, QUOTE, 'emitido', { emitido_at: '2026-09-10T00:00:00.000Z' })).toBe(true);
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.estado).toBe('emitido');
    expect(body.emitido_at).toBe('2026-09-10T00:00:00.000Z');
  });
});
