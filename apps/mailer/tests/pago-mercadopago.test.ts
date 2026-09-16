import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARGEN_VIGENCIA_MS,
  construirPreferencia,
  consultarPago,
  crearPreferencia,
} from '../src/pago/mercadopago.js';

afterEach(() => vi.unstubAllGlobals());

const BASE = {
  quoteId: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  numero: 1600001,
  montoClp: 219725,
  nombre: 'Acme SpA',
  email: 'contacto@acme.cl',
  baseUrl: 'https://rr-mailing.vercel.app',
  validUntil: '2026-09-10T18:00:00.000Z',
};

describe('construirPreferencia', () => {
  it('cobra el total como un solo item en CLP', () => {
    const p: any = construirPreferencia(BASE);
    expect(p.items).toHaveLength(1);
    expect(p.items[0].unit_price).toBe(219725);
    expect(p.items[0].quantity).toBe(1);
    expect(p.items[0].currency_id).toBe('CLP');
    expect(p.items[0].title).toBe('Pedido N° 1600001');
  });

  it('external_reference es el quote_id: es como el webhook encuentra la fila', () => {
    expect((construirPreferencia(BASE) as any).external_reference).toBe(BASE.quoteId);
  });

  it('el link expira 15 minutos antes que la cotizacion', () => {
    const p: any = construirPreferencia(BASE);
    expect(p.expires).toBe(true);
    expect(Date.parse(p.expiration_date_to))
      .toBe(Date.parse(BASE.validUntil) - MARGEN_VIGENCIA_MS);
  });

  it('excluye los medios que no aprueban en el acto', () => {
    const p: any = construirPreferencia(BASE);
    const excluidos = p.payment_methods.excluded_payment_types.map((t: any) => t.id).sort();
    expect(excluidos).toEqual(['atm', 'ticket']);
  });

  it('apunta el webhook y el retorno a nuestra base', () => {
    const p: any = construirPreferencia(BASE);
    expect(p.notification_url).toBe('https://rr-mailing.vercel.app/api/pago/webhook');
    expect(p.back_urls.success).toBe('https://rr-mailing.vercel.app/api/pago/retorno');
  });

  it('con retornoUrl, las tres back_urls la usan y el webhook sigue siendo nuestro', () => {
    const retorno = `https://drcomputacion.cl/pedido/${BASE.quoteId}`;
    const p: any = construirPreferencia({ ...BASE, retornoUrl: retorno });
    expect(p.back_urls).toEqual({ success: retorno, failure: retorno, pending: retorno });
    expect(p.notification_url).toBe('https://rr-mailing.vercel.app/api/pago/webhook');
  });
});

describe('crearPreferencia', () => {
  it('postea con bearer e idempotencia y devuelve id e init_point', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.mercadopago.com/checkout/preferences');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer token-de-prueba');
      expect(headers['X-Idempotency-Key']).toBe(BASE.quoteId);
      return new Response(JSON.stringify({ id: 'pref-1', init_point: 'https://mp/pagar' }), { status: 201 });
    });
    vi.stubGlobal('fetch', spy);
    const r = await crearPreferencia({ hola: 1 }, 'token-de-prueba', BASE.quoteId);
    expect(r).toEqual({ id: 'pref-1', init_point: 'https://mp/pagar' });
  });

  it('un status de error o una respuesta sin init_point devuelven null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    expect(await crearPreferencia({}, 't', BASE.quoteId)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 201 })));
    expect(await crearPreferencia({}, 't', BASE.quoteId)).toBeNull();
  });

  it('la red caida devuelve null, no revienta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await crearPreferencia({}, 't', BASE.quoteId)).toBeNull();
  });
});

describe('consultarPago', () => {
  it('trae status, monto y referencia del pago', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.mercadopago.com/v1/payments/9999');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer t');
      return new Response(JSON.stringify({
        id: 9999, status: 'approved', status_detail: 'accredited',
        external_reference: BASE.quoteId, transaction_amount: 219725,
      }), { status: 200 });
    }));
    const pago = await consultarPago('9999', 't');
    expect(pago?.status).toBe('approved');
    expect(pago?.transaction_amount).toBe(219725);
    expect(pago?.external_reference).toBe(BASE.quoteId);
  });

  it('404 o red caida devuelven null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await consultarPago('1', 't')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    expect(await consultarPago('1', 't')).toBeNull();
  });
});
