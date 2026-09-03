import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/confirmar/route.js';
import { _limpiarCacheKapso } from '../src/lib/kapso.js';
import { _limpiarRateLimit, permitir } from '../src/lib/rate-limit.js';

beforeEach(() => { _limpiarCacheKapso(); _limpiarRateLimit(); vi.stubEnv('KAPSO_API_KEY', 'k'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const FUNCTIONS = { data: [{ id: 'id-g', name: 'generar-cotizacion-v2' }, { id: 'id-e', name: 'emitir-ordenes-compra' }] };
const QUOTE = { quote_id: 'q-1', lineas: [{ sku_proveedor: 'A' }], neto_clp: 1000, iva_clp: 190, total_clp: 1190, valid_until: '2027-01-01T00:00:00Z' };

function req(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('http://localhost/api/confirmar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}
const BODY = {
  items: [{ sku: 'A', mpn: 'M', marca: 'HP', nombre: 'P', cantidad: 1, precioTiendaClp: 1190 }],
  comprador: { nombre: 'Vicente', telefono: '56941757584', email: 'v@a.cl' },
  sitio_web: '',
  totalConfirmadoClp: 1190,
};

// Enruta: listado de functions, generar (cotiza), emitir.
function stubKapso(opciones: { totalVivo?: number; emitirOk?: boolean; generarStatus?: number } = {}) {
  const llamadas: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/functions')) return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
    if (u.includes('/id-g/invoke')) {
      llamadas.push('generar');
      if (opciones.generarStatus) return new Response(JSON.stringify({ estado: 'error', mensaje: 'sin precio' }), { status: opciones.generarStatus });
      const quote = { ...QUOTE, total_clp: opciones.totalVivo ?? QUOTE.total_clp };
      return new Response(JSON.stringify({ estado: 'ok', quote }), { status: 200 });
    }
    llamadas.push('emitir');
    return new Response(JSON.stringify({ ok: true, vars: { purchase_orders_ok: opciones.emitirOk !== false } }), { status: 200 });
  }));
  return llamadas;
}

describe('POST /api/confirmar', () => {
  it('flujo feliz: cotiza, emite y responde ok con el quote_id', async () => {
    const llamadas = stubKapso();
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.quoteId).toBe('q-1');
    expect(llamadas).toEqual(['generar', 'emitir']);
  });
  it('total distinto al confirmado: 409 recotizado y NO emite', async () => {
    const llamadas = stubKapso({ totalVivo: 1500 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.recotizado).toBe(true);
    expect(data.totalClp).toBe(1500);
    expect(llamadas).toEqual(['generar']);
  });
  it('emitir con purchase_orders_ok false: 200 igual, con avisoOc', async () => {
    stubKapso({ emitirOk: false });
    const data = await (await POST(req(BODY))).json();
    expect(data.ok).toBe(true);
    expect(data.avisoOc).toBe(true);
  });
  it('error de negocio de generar (409/400 de la function) => 422 con el mensaje', async () => {
    stubKapso({ generarStatus: 409 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('sin precio');
  });
  it('validacion mala => 400; red caida => 503', async () => {
    stubKapso();
    expect((await POST(req({ ...BODY, comprador: { nombre: 'V', telefono: '1', email: 'x' } }))).status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    _limpiarCacheKapso();
    expect((await POST(req(BODY))).status).toBe(503);
  });
  it('sexta confirmacion de la misma IP en la ventana => 429', async () => {
    stubKapso();
    for (let i = 0; i < 5; i++) expect((await POST(req(BODY, '9.9.9.9'))).status).toBe(200);
    expect((await POST(req(BODY, '9.9.9.9'))).status).toBe(429);
    expect((await POST(req(BODY, '8.8.8.8'))).status).toBe(200); // otra IP sigue pasando
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
