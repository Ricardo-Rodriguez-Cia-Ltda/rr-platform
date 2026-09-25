import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarVistaCompras } from '../src/lib/vista-compras.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const PEDIDOS = [
  { po_id: 'oc-1', quote_id: 'q1', quote_version: '1', proveedor: 'intcomex', razon_social: 'Acme', telefono: '569', estado_negocio: 'pagado', estado_compra: 'por_comprar', modalidad_compra: null, llegada_estimada: null, created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'A', nombre: 'Toner A', cantidad: 2 }] },
  { po_id: 'oc-2', quote_id: 'q1', quote_version: '1', proveedor: 'tecnoglobal', razon_social: 'Acme', telefono: '569', estado_negocio: 'pagado', estado_compra: 'en_camino', modalidad_compra: 'despacho_mayorista', llegada_estimada: '2026-09-20', created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'B', nombre: 'Toner B', cantidad: 1 }] },
  { po_id: 'oc-3', quote_id: 'q2', quote_version: '1', proveedor: 'ingram', razon_social: null, telefono: '570', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', llegada_estimada: null, created_at: '2026-09-24T10:00:00Z', lineas: [{ mpn: 'C', cantidad: 1 }] },
];

describe('cargarVistaCompras', () => {
  it('agrupa por estado, suma lo recibido por linea y cuenta las atrasadas', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/pedidos?')) return new Response(JSON.stringify(PEDIDOS));
      if (u.includes('/recepciones?')) return new Response(JSON.stringify([{ po_id: 'oc-3', mpn: 'C', cantidad: 1 }]));
      return new Response(JSON.stringify([{ quote_id: 'q1', version: '1', numero: 1600020 }]));
    }));
    const v = await cargarVistaCompras('2026-09-25');
    expect(v?.porComprar.map((c) => c.fila.po_id)).toEqual(['oc-1']);
    expect(v?.enCurso.map((c) => c.fila.po_id)).toEqual(['oc-2']);
    expect(v?.recibidas.map((c) => c.fila.po_id)).toEqual(['oc-3']);
    expect(v?.atrasadas).toBe(1);
    expect(v?.enCurso[0].atrasada).toBe(true);
    expect(v?.porComprar[0].numeroCotizacion).toBe(1600020);
    expect(v?.porComprar[0].cliente).toBe('Acme');
    expect(v?.recibidas[0].lineas[0]).toMatchObject({ clave: 'C', recibida: 1 });
  });
  it('null si falla la base', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect(await cargarVistaCompras('2026-09-25')).toBeNull();
  });
  it('recibidas, por despachar: sale la OC cuyas lineas ya estan todas asignadas a despachos no anulados', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    const recibidas = [
      { po_id: 'oc-a', quote_id: 'qa', quote_version: '1', proveedor: 'intcomex', razon_social: 'Acme', telefono: '569', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', llegada_estimada: null, created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'A', cantidad: 2 }] },
      { po_id: 'oc-b', quote_id: 'qb', quote_version: '1', proveedor: 'intcomex', razon_social: 'Beta', telefono: '570', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', llegada_estimada: null, created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'B', cantidad: 2 }] },
    ];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/pedidos?')) return new Response(JSON.stringify(recibidas));
      if (u.includes('/recepciones?')) return new Response(JSON.stringify([{ po_id: 'oc-a', mpn: 'A', cantidad: 2 }, { po_id: 'oc-b', mpn: 'B', cantidad: 2 }]));
      // oc-a: 2 de 2 asignadas (en dos despachos); oc-b: solo 1 de 2.
      if (u.includes('/despacho_lineas?')) return new Response(JSON.stringify([
        { po_id: 'oc-a', mpn: 'A', cantidad: 1 }, { po_id: 'oc-a', mpn: 'A', cantidad: 1 }, { po_id: 'oc-b', mpn: 'B', cantidad: 1 },
      ]));
      return new Response(JSON.stringify([]));
    }));
    const v = await cargarVistaCompras('2026-09-25');
    expect(v?.recibidas.map((c) => c.fila.po_id)).toEqual(['oc-b']);
    const consulta = urls.find((u) => u.includes('/despacho_lineas?')) ?? '';
    expect(consulta).toContain('despachos!inner(estado)');
    expect(consulta).toContain('despachos.estado=neq.anulado');
  });
  it('combina lineas repetidas del mismo mpn en una OC antes de calcular lo recibido', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    const pedidoRepetido = [
      { po_id: 'oc-9', quote_id: 'q9', quote_version: '1', proveedor: 'intcomex', razon_social: 'Acme', telefono: '569', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', llegada_estimada: null, created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'A', nombre: 'Toner A', cantidad: 1 }, { mpn: 'A', nombre: 'Toner A', cantidad: 1 }] },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/pedidos?')) return new Response(JSON.stringify(pedidoRepetido));
      if (u.includes('/recepciones?')) return new Response(JSON.stringify([{ po_id: 'oc-9', mpn: 'A', cantidad: 2 }]));
      return new Response(JSON.stringify([]));
    }));
    const v = await cargarVistaCompras('2026-09-25');
    expect(v?.recibidas[0].lineas).toEqual([{ clave: 'A', nombre: 'Toner A', cantidad: 2, recibida: 2 }]);
  });
});
