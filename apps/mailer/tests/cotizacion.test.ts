import { describe, expect, it, vi, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PDFDocument } from 'pdf-lib';
import { createCotizacionHandler, drawCotizacion } from '../src/cotizacion.js';
import { buildCotizacionView } from '../src/cotizacion-view.js';

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave-de-prueba' };

const ROW = {
  quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  numero: 1600001,
  telefono: '56941757584',
  neto_clp: 1000,
  iva_clp: 190,
  total_clp: 1190,
  valida_hasta: '2026-09-01T21:45:00.000Z',
  created_at: '2026-09-01T18:00:00.000Z',
  lineas: [{ mpn: 'X', nombre: 'Producto', cantidad: 1, precio_unitario_clp: 1000, subtotal_neto_clp: 1000 }],
};

// Calca el patron de send.test.ts (status/json), extendido para capturar
// headers via setHeader y el cuerpo binario via send(Buffer).
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    jsonBody: undefined as any,
    status(code: number) { res.statusCode = code; return res; },
    setHeader(name: string, value: string) { res.headers[name.toLowerCase()] = value; return res; },
    json(payload: unknown) { res.jsonBody = payload; res.body = payload; return res; },
    send(payload: unknown) { res.body = payload; return res; },
    end() { return res; },
  };
  return res as unknown as VercelResponse & typeof res;
}

function makeReq(query: Record<string, string> = {}): VercelRequest {
  return { method: 'GET', query, headers: {} } as unknown as VercelRequest;
}

function stubSupabase(rows: unknown[], clientes: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) => new Response(JSON.stringify(String(url).includes('/clientes') ? clientes : rows), { status: 200 })),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('GET /api/cotizacion/[id]', () => {
  it('devuelve un PDF valido de una pagina con los headers correctos', async () => {
    stubSupabase([ROW]);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('cotizacion-1600001.pdf');
    const bytes: Buffer = res.body as Buffer;
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  }, 15000);

  it('un id que no es UUID responde 404 sin tocar Supabase', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: '../etc/passwd' }), res, ENV);
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('cotizacion inexistente responde 404 con el codigo del contrato', async () => {
    stubSupabase([]);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res, ENV);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody?.error).toBe('cotizacion_no_encontrada');
  });

  it('sin variables de entorno responde 503 nombrando las que faltan, nunca valores', async () => {
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res, {});
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody?.faltan).toContain('SUPABASE_URL');
    expect(JSON.stringify(res.jsonBody)).not.toContain('clave-de-prueba');
  });

  it('fila sin numero sale como S/N en el filename', async () => {
    stubSupabase([{ ...ROW, numero: null }]);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res, ENV);
    expect(res.headers['content-disposition']).toContain('cotizacion-SN.pdf');
  });

  it('un fetch que falla responde 503 upstream (el link es reintentable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody?.error).toBe('upstream');
  });

  it('sin telefono no consulta clientes y arma el bloque cliente como Presente', async () => {
    const fetchSpy = vi.fn(async (url: any) =>
      new Response(JSON.stringify(String(url).includes('/clientes') ? [] : [{ ...ROW, telefono: null }]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // solo /cotizaciones, nunca /clientes
  });
});

describe('drawCotizacion', () => {
  it('con mas de 18 lineas pasa a una segunda pagina', async () => {
    const rowMuchasLineas = {
      ...ROW,
      lineas: Array.from({ length: 25 }, (_, i) => ({
        mpn: `SKU-${i}`,
        nombre: `Producto ${i}`,
        cantidad: 1,
        precio_unitario_clp: 1000,
        subtotal_neto_clp: 1000,
      })),
    };
    const view = buildCotizacionView(rowMuchasLineas, null);
    const bytes = await drawCotizacion(view);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  it('no revienta con una linea con cantidad y precios en cero (undefined normalizado por buildCotizacionView)', async () => {
    const rowConLineaVacia = { ...ROW, lineas: [{ mpn: undefined, nombre: undefined, cantidad: undefined, precio_unitario_clp: undefined, subtotal_neto_clp: undefined }] };
    const view = buildCotizacionView(rowConLineaVacia as any, null);
    const bytes = await drawCotizacion(view);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});
