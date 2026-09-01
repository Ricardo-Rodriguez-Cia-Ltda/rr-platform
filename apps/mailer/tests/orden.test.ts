import { describe, expect, it, vi, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PDFDocument } from 'pdf-lib';
import { createOrdenHandler, drawOrden } from '../src/orden.js';
import { buildOrdenView } from '../src/orden-view.js';

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave-de-prueba' };

const PO_ID = 'oc-f9b6c8ad-5b51-408d-8de2-acd10ff35ec4-1-intcomex';

const ROW = {
  po_id: PO_ID,
  quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  quote_version: '1',
  proveedor: 'intcomex',
  telefono: '56941757584',
  rut: '21099234-0',
  razon_social: 'Acme SpA',
  estado: 'sent',
  created_at: '2026-09-01T18:00:00.000Z',
  lineas: [
    { sku_proveedor: 'INT-1', mpn: 'X-100', nombre: 'Notebook', cantidad: 2, abastecimiento: 'stock_inmediato', costo_unitario_usd: 100.5, costo_total_usd: 201 },
  ],
};

// Mismo patron que cotizacion.test.ts: res casera que captura status, headers
// y el cuerpo binario.
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

function stubSupabase(pedidos: unknown[], cotizaciones: unknown[] = [{ numero: 1600001 }]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) =>
      new Response(JSON.stringify(String(url).includes('/cotizaciones') ? cotizaciones : pedidos), { status: 200 }),
    ),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('GET /api/orden/[id]', () => {
  it('devuelve un PDF valido de una pagina con los headers correctos', async () => {
    stubSupabase([ROW]);
    const res = makeRes();
    await createOrdenHandler()(makeReq({ id: PO_ID }), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`${PO_ID}.pdf`);
    const bytes: Buffer = res.body as Buffer;
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  }, 15000);

  it('un id sin la forma de po_id responde 404 sin tocar Supabase', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createOrdenHandler()(makeReq({ id: 'oc-cualquier-cosa' }), res, ENV);
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('orden inexistente responde 404 con el codigo del contrato', async () => {
    stubSupabase([]);
    const res = makeRes();
    await createOrdenHandler()(makeReq({ id: PO_ID }), res, ENV);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody?.error).toBe('orden_no_encontrada');
  });

  it('sin variables de entorno responde 503 nombrando las que faltan, nunca valores', async () => {
    const res = makeRes();
    await createOrdenHandler()(makeReq({ id: PO_ID }), res, {});
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody?.faltan).toContain('SUPABASE_URL');
    expect(JSON.stringify(res.jsonBody)).not.toContain('clave-de-prueba');
  });

  it('un fetch que falla responde 503 upstream (el link es reintentable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const res = makeRes();
    await createOrdenHandler()(makeReq({ id: PO_ID }), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody?.error).toBe('upstream');
  });

  it('si drawOrden revienta, responde 503 upstream en vez de 500 pelado', async () => {
    stubSupabase([ROW]);
    const res = makeRes();
    const drawRoto = vi.fn(async () => { throw new Error('WinAnsi cannot encode'); });
    await createOrdenHandler(drawRoto)(makeReq({ id: PO_ID }), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody?.error).toBe('upstream');
  });

  it('cotizacion purgada: el PDF sale igual, con la referencia por quote_id', async () => {
    stubSupabase([ROW], []); // pedidos existe, cotizaciones vacio
    const res = makeRes();
    let capturada: any;
    const draw = vi.fn(async (view: any) => { capturada = view; return drawOrden(view); });
    await createOrdenHandler(draw)(makeReq({ id: PO_ID }), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(capturada.referencia).toContain(ROW.quote_id);
  }, 15000);
});

describe('drawOrden', () => {
  it('una orden failed con lineas viejas sin costos igual dibuja (avisos y em-dash)', async () => {
    const view = buildOrdenView(
      { ...ROW, estado: 'failed', lineas: [{ sku_proveedor: 'INT-1', mpn: 'X', nombre: 'A', cantidad: 1 }] },
      null,
    );
    const bytes = await drawOrden(view);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  }, 15000);

  it('muchas lineas saltan de pagina sin reventar', async () => {
    const lineas = Array.from({ length: 25 }, (_, i) => ({
      sku_proveedor: `S-${i}`, mpn: `M-${i}`, nombre: `Producto ${i}`, cantidad: 1,
      abastecimiento: 'stock_inmediato', costo_unitario_usd: 1, costo_total_usd: 1,
    }));
    const bytes = await drawOrden(buildOrdenView({ ...ROW, lineas }, 1600001));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  }, 15000);
});
