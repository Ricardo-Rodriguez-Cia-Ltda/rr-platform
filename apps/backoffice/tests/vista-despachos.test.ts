import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarVistaDespachos } from '../src/lib/vista-despachos.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const PEDIDOS = [
  { po_id: 'oc-1', quote_id: 'q1', quote_version: '1', proveedor: 'intcomex', razon_social: 'Acme', telefono: '569', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'A', nombre: 'Toner A', cantidad: 2 }] },
  { po_id: 'oc-2', quote_id: 'q2', quote_version: '1', proveedor: 'ingram', razon_social: 'Beta', telefono: '570', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', created_at: '2026-09-24T10:00:00Z', lineas: [{ mpn: 'B', cantidad: 1 }] },
];
const DESPACHOS = [
  { id: 1, quote_id: 'q2', quote_version: '1', modalidad: 'courier', courier: 'starken', estado: 'en_ruta', cobrado_clp: 4000, cobro_pagado: false, created_at: 'x', despacho_lineas: [{ po_id: 'oc-2', mpn: 'B', cantidad: 1 }] },
  { id: 2, quote_id: 'q1', quote_version: '1', modalidad: 'propio', courier: null, estado: 'entregado', cobrado_clp: null, cobro_pagado: false, created_at: 'x', despacho_lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }] },
];

describe('cargarVistaDespachos', () => {
  it('pedidos con lineas por asignar, despachos activos, cobros pendientes y entregados', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/pedidos?')) return new Response(JSON.stringify(PEDIDOS));
      if (u.includes('/despachos?')) return new Response(JSON.stringify(DESPACHOS));
      if (u.includes('/recepciones?')) return new Response(JSON.stringify([]));
      if (u.includes('/clientes?')) return new Response(JSON.stringify([{ telefono: '569', direccion: 'Calle 1', comuna: 'Ñuñoa', ciudad: 'Santiago' }]));
      return new Response(JSON.stringify([{ quote_id: 'q1', version: '1', numero: 1600030 }]));
    }));
    const v = await cargarVistaDespachos();
    expect(v?.porAsignar.map((p) => p.quoteId)).toEqual(['q1']);
    expect(v?.porAsignar[0].resumen[0].pendiente).toBe(1);
    expect(v?.porAsignar[0].facturacion).toEqual({ direccion: 'Calle 1', comuna: 'Ñuñoa', ciudad: 'Santiago' });
    expect(v?.porAsignar[0].numeroCotizacion).toBe(1600030);
    expect(v?.activos.map((a) => a.despacho.id)).toEqual([1]);
    expect(v?.cobrosPendientes.map((a) => a.despacho.id)).toEqual([1]);
    expect(v?.entregadosRecientes.map((a) => a.despacho.id)).toEqual([2]);
  });
});
