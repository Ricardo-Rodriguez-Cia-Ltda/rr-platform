import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _limpiarCacheKapso, enviarBotonPago, enviarTexto, invocarFunction } from '../src/pago/kapso.js';
import { MENSAJES, formatearClp } from '../src/pago/mensajes.js';

const FUNCTIONS = { data: [{ id: 'id-emitir', name: 'emitir-ordenes-compra' }] };

beforeEach(() => _limpiarCacheKapso());
afterEach(() => vi.unstubAllGlobals());

describe('invocarFunction', () => {
  it('resuelve el id por nombre, cachea el listado y postea el payload', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('/functions')) return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
      expect(String(url)).toContain('/functions/id-emitir/invoke');
      expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('kapso-key');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    const r1 = await invocarFunction('emitir-ordenes-compra', {}, 'kapso-key');
    const r2 = await invocarFunction('emitir-ordenes-compra', {}, 'kapso-key');
    expect(r1?.status).toBe(200);
    expect(r2?.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3); // 1 listado + 2 invokes
  });

  it('sin key, function inexistente o red caida devuelven null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FUNCTIONS), { status: 200 })));
    expect(await invocarFunction('emitir-ordenes-compra', {}, '')).toBeNull();
    expect(await invocarFunction('no-existe', {}, 'k')).toBeNull();
    _limpiarCacheKapso();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await invocarFunction('emitir-ordenes-compra', {}, 'k')).toBeNull();
  });

  it('un status no-2xx se devuelve para que el caller decida', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) =>
      String(url).endsWith('/functions')
        ? new Response(JSON.stringify(FUNCTIONS), { status: 200 })
        : new Response(JSON.stringify({ ok: false, error: 'La cotización expiró' }), { status: 409 })));
    const r = await invocarFunction('emitir-ordenes-compra', {}, 'k');
    expect(r?.status).toBe(409);
  });

  it('404 en invoke => borra cache, re-resuelve id, reintenta una sola vez y devuelve 200', async () => {
    let callCount = 0;
    const spy = vi.fn(async (url: any) => {
      callCount++;
      if (String(url).endsWith('/functions')) {
        // Primer listado devuelve id viejo, segundo devuelve id nuevo
        return new Response(JSON.stringify(callCount === 1
          ? { data: [{ id: 'id-emitir-viejo', name: 'emitir-ordenes-compra' }] }
          : { data: [{ id: 'id-emitir-nuevo', name: 'emitir-ordenes-compra' }] }
        ), { status: 200 });
      }
      // Primer invoke (con id viejo) => 404
      if (callCount === 2) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      // Segundo invoke (con id nuevo) => 200
      return new Response(JSON.stringify({ estado: 'ok' }), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    const r = await invocarFunction('emitir-ordenes-compra', { test: 'data' }, 'k');
    expect(r?.status).toBe(200);
    // 1 listado inicial + 1 invoke 404 + 1 listado re-resuelve + 1 invoke retry = 4 fetches
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

describe('mensajes de WhatsApp', () => {
  it('enviarTexto postea al proxy Meta con el phone_number_id', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/PNID/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.to).toBe('56941757584');
      expect(body.text.body).toBe('hola');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    expect(await enviarTexto({ telefono: '56941757584', phoneNumberId: 'PNID', key: 'k', texto: 'hola' })).toBe(true);
  });

  it('enviarBotonPago manda un interactivo cta_url con la URL del pago', async () => {
    const spy = vi.fn(async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.type).toBe('interactive');
      expect(body.interactive.type).toBe('cta_url');
      expect(body.interactive.action.parameters.url).toBe('https://mp/pagar');
      expect(body.interactive.action.parameters.display_text).toBe('Pagar');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    expect(await enviarBotonPago({
      telefono: '569', phoneNumberId: 'PNID', key: 'k',
      texto: 'Listo', url: 'https://mp/pagar', boton: 'Pagar',
    })).toBe(true);
  });

  it('sin telefono o sin phone_number_id no se llama a la red', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await enviarTexto({ telefono: '', phoneNumberId: 'PNID', key: 'k', texto: 'x' })).toBe(false);
    expect(await enviarTexto({ telefono: '569', phoneNumberId: '', key: 'k', texto: 'x' })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('un status de error devuelve false sin reventar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    expect(await enviarTexto({ telefono: '569', phoneNumberId: 'P', key: 'k', texto: 'x' })).toBe(false);
  });
});

describe('textos', () => {
  it('formatea pesos chilenos sin decimales', () => {
    expect(formatearClp(219725)).toBe('$219.725');
  });

  it('el texto del link lleva el monto y ninguno promete lo que no ocurrio', () => {
    expect(MENSAJES.linkCreado('$219.725')).toContain('$219.725');
    expect(MENSAJES.emitido).toContain('cursado');
    expect(MENSAJES.aprobadoSinEmitir).not.toContain('cursado');
  });
});
