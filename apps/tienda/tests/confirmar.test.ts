import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/confirmar/route.js';
import { _limpiarCacheKapso } from '../src/lib/kapso.js';
import { _limpiarRateLimit, permitir } from '../src/lib/rate-limit.js';

beforeEach(() => {
  _limpiarCacheKapso(); _limpiarRateLimit();
  vi.stubEnv('KAPSO_API_KEY', 'k');
  vi.stubEnv('MAILER_URL', 'https://relay.test');
  vi.stubEnv('MAILER_API_KEY', 'clave-relay');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const FUNCTIONS = { data: [{ id: 'id-g', name: 'generar-cotizacion-v2' }, { id: 'id-e', name: 'emitir-ordenes-compra' }] };
const QUOTE = {
  quote_id: 'q-1',
  lineas: [{ sku_proveedor: 'A', abastecimiento: 'stock_inmediato' }],
  neto_clp: 1000, iva_clp: 190, total_clp: 1190, valid_until: '2027-01-01T00:00:00Z',
};

function req(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('http://localhost/api/confirmar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}
const BODY = {
  items: [{ sku: 'A', mpn: 'M', marca: 'HP', nombre: 'P', cantidad: 1, precioNetoClp: 1000, precioTiendaClp: 1190 }],
  comprador: { nombre: 'Vicente', telefono: '56941757584', email: 'v@a.cl' },
  sitio_web: '',
  totalConfirmadoClp: 1190,
};

// Enruta: listado de functions, generar (cotiza) y el rele (crear pago).
function stubRed(opciones: {
  totalVivo?: number; generarStatus?: number; abastecimiento?: string;
  relayStatus?: number; relayBody?: unknown; relayCaido?: boolean;
} = {}) {
  const llamadas: string[] = [];
  const cuerposRelay: Array<{ headers: Record<string, string>; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/functions')) return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
    if (u.includes('/id-g/invoke')) {
      llamadas.push('generar');
      if (opciones.generarStatus) return new Response(JSON.stringify({ estado: 'error', mensaje: 'sin precio' }), { status: opciones.generarStatus });
      const quote = {
        ...QUOTE,
        total_clp: opciones.totalVivo ?? QUOTE.total_clp,
        lineas: [{ sku_proveedor: 'A', abastecimiento: opciones.abastecimiento ?? 'stock_inmediato' }],
      };
      return new Response(JSON.stringify({ estado: 'ok', quote }), { status: 200 });
    }
    if (u.includes('/id-e/invoke')) {
      llamadas.push('emitir');
      throw new Error('la tienda ya no emite: esta llamada no debe existir');
    }
    if (u.startsWith('https://relay.test/api/pago/crear')) {
      llamadas.push('crear');
      cuerposRelay.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      if (opciones.relayCaido) throw new Error('caida');
      const body = opciones.relayBody ?? { ok: true, estado: 'pendiente', init_point: 'https://mp/pagar' };
      return new Response(JSON.stringify(body), { status: opciones.relayStatus ?? 200 });
    }
    throw new Error(`llamada inesperada: ${u}`);
  }));
  return { llamadas, cuerposRelay };
}

describe('POST /api/confirmar', () => {
  it('flujo feliz: cotiza, crea el pago y responde con el link', async () => {
    const { llamadas } = stubRed();
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, quoteId: 'q-1', totalClp: 1190, initPoint: 'https://mp/pagar' });
    expect(llamadas).toEqual(['generar', 'crear']);
  });
  it('el cuerpo al rele lleva la confirmacion, el origen tienda, los datos del comprador y la api key', async () => {
    const { cuerposRelay } = stubRed();
    await POST(req({ ...BODY, facturacion: { rut: '1-9', razonSocial: 'Acme', giro: 'G', direccion: 'D', comuna: 'C', ciudad: 'S', emailFactura: 'f@a.cl' } }));
    expect(cuerposRelay).toHaveLength(1);
    expect(cuerposRelay[0].headers['x-api-key']).toBe('clave-relay');
    expect(cuerposRelay[0].body).toEqual({
      quote_id: 'q-1', quote_version: '1', quote_confirmed: true, origen: 'tienda',
      phone_number: '56941757584', customer_name: 'Vicente',
      billing_email: 'f@a.cl', billing_rut: '1-9', billing_razon_social: 'Acme', billing_giro: 'G',
      billing_direccion: 'D', billing_comuna: 'C', billing_ciudad: 'S',
    });
  });
  it('total distinto al confirmado: 409 recotizado y NO crea pago', async () => {
    const { llamadas } = stubRed({ totalVivo: 1500 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.recotizado).toBe(true);
    expect(data.totalClp).toBe(1500);
    expect(llamadas).toEqual(['generar']);
  });
  it('error de negocio de generar (409/400 de la function) => 422 con el mensaje', async () => {
    stubRed({ generarStatus: 409 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('sin precio');
  });
  it('validacion mala => 400; red caida => 503', async () => {
    stubRed();
    expect((await POST(req({ ...BODY, comprador: { nombre: 'V', telefono: '1', email: 'x' } }))).status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    _limpiarCacheKapso();
    expect((await POST(req(BODY))).status).toBe(503);
  });
  it('sexta confirmacion de la misma IP en la ventana => 429', async () => {
    stubRed();
    for (let i = 0; i < 5; i++) expect((await POST(req(BODY, '9.9.9.9'))).status).toBe(200);
    expect((await POST(req(BODY, '9.9.9.9'))).status).toBe(429);
    expect((await POST(req(BODY, '8.8.8.8'))).status).toBe(200); // otra IP sigue pasando
  });
  it('un body invalido no gasta cupo: tras 5 intentos invalidos, el sexto (valido) responde 200', async () => {
    stubRed();
    const bodyInvalido = { ...BODY, comprador: { nombre: 'V', telefono: '1', email: 'x' } };
    for (let i = 0; i < 5; i++) expect((await POST(req(bodyInvalido, '7.7.7.7'))).status).toBe(400);
    expect((await POST(req(BODY, '7.7.7.7'))).status).toBe(200);
  });
  it('generar-cotizacion-v2 responde 500 => 503 y no llama al rele', async () => {
    const { llamadas } = stubRed({ generarStatus: 500 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(503);
    expect(String((await res.json()).error)).toMatch(/intenta de nuevo/i);
    expect(llamadas).toEqual(['generar']);
  });
  it('total no cotizable (0 o no numerico) => 422, y NO se compara contra el confirmado', async () => {
    const { llamadas } = stubRed({ totalVivo: 0 });
    const res = await POST(req({ ...BODY, totalConfirmadoClp: 0 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('No pudimos cotizar tu pedido');
    expect(llamadas).toEqual(['generar']);
  });
  it('una linea por encargo => avisoAbastecimiento en el 200', async () => {
    stubRed({ abastecimiento: 'por_comprar_importar' });
    const data = await (await POST(req(BODY))).json();
    expect(data.ok).toBe(true);
    expect(data.avisoAbastecimiento).toBe(true);
  });
  it('todo con stock inmediato => sin avisoAbastecimiento', async () => {
    stubRed();
    const data = await (await POST(req(BODY))).json();
    expect(data.avisoAbastecimiento).toBeUndefined();
  });
  it('rele caido o 5xx => 503 que SI invita a reintentar (nada se emitio)', async () => {
    for (const opciones of [{ relayCaido: true }, { relayStatus: 502, relayBody: { ok: false, error: 'mercadopago_no_responde' } }]) {
      _limpiarRateLimit();
      stubRed(opciones);
      const res = await POST(req(BODY));
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe('No pudimos generar el link de pago. Intenta de nuevo.');
      expect(data.noReintentar).toBeUndefined();
    }
  });
  it('rele 409 sin_vigencia => 422 pidiendo confirmar de nuevo', async () => {
    stubRed({ relayStatus: 409, relayBody: { ok: false, error: 'sin_vigencia' } });
    const res = await POST(req(BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Los precios de tu cotización cambiaron. Vuelve a confirmar el pedido.');
  });
  it('rele 200 sin init_point => 503 (no hay a donde mandar al cliente)', async () => {
    stubRed({ relayBody: { ok: true, estado: 'pendiente' } });
    const res = await POST(req(BODY));
    expect(res.status).toBe(503);
  });
  it('rele 401/400 (nuestra configuracion) => 503 generico, no el codigo interno', async () => {
    stubRed({ relayStatus: 401, relayBody: { ok: false, error: 'no_autorizado' } });
    const res = await POST(req(BODY));
    expect(res.status).toBe(503);
    expect(String((await res.json()).error)).not.toContain('no_autorizado');
  });
});

describe('permitir (rate limit)', () => {
  it('expira la ventana a los 10 minutos', () => {
    _limpiarRateLimit();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(permitir('ip', t0)).toBe(true);
    expect(permitir('ip', t0)).toBe(false);
    expect(permitir('ip', t0 + 10 * 60_000 + 1)).toBe(true);
  });
});
