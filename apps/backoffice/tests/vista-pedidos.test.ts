import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarVistaPedidos } from '../src/lib/vista-pedidos.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const FILA = {
  po_id: 'oc-q-1-1-ingram', quote_id: 'q-1', quote_version: '1', proveedor: 'ingram',
  telefono: '569', rut: null, razon_social: 'Acme', estado: 'sent', estado_negocio: 'pagado',
  created_at: '2026-09-01T18:00:00Z', neto_grupo_clp: 1000,
  lineas: [{ nombre: 'A', cantidad: 1, precio_unitario_clp: 1000, subtotal_neto_clp: 1000 }],
};
const COT = { quote_id: 'q-1', version: '1', numero: 1600001, total_clp: 1190 };

function stub() {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
  vi.stubGlobal('fetch', vi.fn(async (url: any) =>
    new Response(JSON.stringify(String(url).includes('/cotizaciones') ? [COT] : [FILA]), { status: 200 })));
}

describe('cargarVistaPedidos', () => {
  it('junta pedido + total y numero de su cotizacion', async () => {
    stub();
    const vista = await cargarVistaPedidos();
    expect(vista?.contadores.porEntregar).toBe(1);
    expect(vista?.pedidos[0].totalFmt).toBe('$1.190');
    expect(vista?.pedidos[0].numeroCotizacion).toBe(1600001);
  });
  it('cotizacion no encontrada: total "—" y numero null, sin reventar', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async (url: any) =>
      new Response(JSON.stringify(String(url).includes('/cotizaciones') ? [] : [FILA]), { status: 200 })));
    const vista = await cargarVistaPedidos();
    expect(vista?.pedidos[0].totalFmt).toBe('—');
    expect(vista?.pedidos[0].numeroCotizacion).toBeNull();
  });
  it('supabase caido -> null', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect(await cargarVistaPedidos()).toBeNull();
  });
});
