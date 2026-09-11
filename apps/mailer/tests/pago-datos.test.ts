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

  // Misma convencion tri-estado que `leerCotizacion` en este mismo archivo.
  // Confundir los dos casos hacia que un 5xx de Supabase en este PATCH se
  // leyera como "otra entrega ya la tomo": el webhook respondia 200, Mercado
  // Pago dejaba de reintentar y el pago quedaba cobrado sin emitir nada.
  it('cero filas (false) significa que otra entrega del webhook ya la tomo', async () => {
    stub(() => new Response('[]', { status: 200 }));
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBe(false);
  });

  it('un fallo de Supabase (undefined) no es "ya la tomo otro"', async () => {
    stub(() => new Response('{}', { status: 500 }));
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBeUndefined();
  });

  it('una excepcion de red tambien devuelve undefined', async () => {
    stub(() => { throw new Error('ECONNRESET'); });
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBeUndefined();
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

  // I4: el PATCH iba solo por quote_id, sin condicionar por estado. La rama de
  // monto que no calza podia entonces degradar a `aprobado_sin_emitir` una
  // fila que ya estaba `emitido` por un pago anterior legitimo, borrando el
  // registro de que las ordenes si salieron.
  it('marcarEstado sin `desde` no condiciona por estado (retrocompatible)', async () => {
    const spy = stub(() => new Response('[]', { status: 200 }));
    await marcarEstado(ENV, QUOTE, 'emitido');
    expect(String(spy.mock.calls[0][0])).not.toContain('estado=eq.');
  });

  it('marcarEstado con `desde` condiciona el PATCH a ese estado de origen', async () => {
    const spy = stub(() => new Response(JSON.stringify([{ quote_id: QUOTE }]), { status: 200 }));
    await marcarEstado(ENV, QUOTE, 'emitido', {}, 'aprobado');
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('quote_id=eq.' + QUOTE);
    expect(url).toContain('estado=eq.aprobado');
  });

  // La distincion que el chequeo de retorno de webhook.ts necesita: cero filas
  // afectadas NO es un fallo de escritura, es "no correspondia escribir".
  // Confundirlas convertiria cada transicion legitimamente vacia en una alerta
  // interna de fila colgada.
  it('marcarEstado devuelve true cuando el estado de origen no calza: no se pudo pisar, pero tampoco fallo', async () => {
    stub(() => new Response('[]', { status: 200 }));
    expect(await marcarEstado(ENV, QUOTE, 'aprobado_sin_emitir', {}, 'pendiente')).toBe(true);
  });

  it('marcarEstado devuelve false solo cuando la escritura falla de verdad', async () => {
    stub(() => new Response('{}', { status: 500 }));
    expect(await marcarEstado(ENV, QUOTE, 'emitido', {}, 'aprobado')).toBe(false);
  });
});
