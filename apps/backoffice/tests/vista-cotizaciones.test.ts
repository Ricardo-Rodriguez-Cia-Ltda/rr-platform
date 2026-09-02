import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarVistaCotizaciones } from '../src/lib/vista-cotizaciones.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const AHORA = Date.parse('2026-09-01T20:00:00Z');
const COT = {
  quote_id: 'q-1', version: '1', numero: 1600001, telefono: '569', total_clp: 1190,
  valida_hasta: '2026-09-01T21:00:00Z', created_at: '2026-09-01T18:00:00Z',
};

function stub(cots: unknown[], pedidos: unknown[] = [], clientes: unknown[] = []) {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url);
    const datos = u.includes('/pedidos') ? pedidos : u.includes('/clientes') ? clientes : cots;
    return new Response(JSON.stringify(datos), { status: 200 });
  }));
}

describe('cargarVistaCotizaciones', () => {
  it('vigencia contra ahora, badge de pedido, razon social si el telefono calza', async () => {
    stub([COT], [{ quote_id: 'q-1', quote_version: '1' }], [{ telefono: '569', razon_social: 'Acme' }]);
    const vista = await cargarVistaCotizaciones(AHORA);
    const fila = vista!.filas[0];
    expect(fila.version).toBe('1');
    expect(fila.vigente).toBe(true);
    expect(fila.tienePedido).toBe(true);
    expect(fila.clienteLabel).toBe('Acme');
    expect(fila.totalFmt).toBe('$1.190');
    expect(fila.pdfUrl).toBe('https://rr-mailing.vercel.app/api/cotizacion/q-1');
  });
  it('expirada cuando valida_hasta ya paso; telefono pelado si no hay cliente', async () => {
    stub([{ ...COT, valida_hasta: '2026-09-01T19:00:00Z' }]);
    const fila = (await cargarVistaCotizaciones(AHORA))!.filas[0];
    expect(fila.vigente).toBe(false);
    expect(fila.clienteLabel).toBe('569');
  });
  it('supabase caido -> null', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect(await cargarVistaCotizaciones(AHORA)).toBeNull();
  });
});
