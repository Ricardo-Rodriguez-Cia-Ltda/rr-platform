import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarClientes, cargarFichaCliente } from '../src/lib/vista-clientes.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const CLIENTE = {
  telefono: '569', rut: '1-9', razon_social: 'Acme', giro: 'Ventas',
  direccion: 'Calle 1', comuna: 'Ñuñoa', ciudad: 'Santiago', email: 'a@a.cl',
};

function stub(clientes: unknown[], cots: unknown[] = [], pedidos: unknown[] = []) {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url);
    const datos = u.includes('/clientes') ? clientes : u.includes('/cotizaciones') ? cots : pedidos;
    return new Response(JSON.stringify(datos), { status: 200 });
  }));
}

describe('clientes', () => {
  it('la lista sale con telefono, razon social y rut', async () => {
    stub([CLIENTE]);
    expect(await cargarClientes()).toEqual([{ telefono: '569', razonSocial: 'Acme', rut: '1-9' }]);
  });
  it('la ficha junta datos + historial', async () => {
    stub([CLIENTE], [{ numero: 1600001, created_at: '2026-09-01T18:00:00Z', total_clp: 1190 }],
      [{ po_id: 'p', quote_id: 'q-1', quote_version: '1', proveedor: 'ingram', telefono: '569',
         rut: null, razon_social: 'Acme', estado: 'sent', estado_negocio: 'pagado',
         created_at: '2026-09-01T18:05:00Z', neto_grupo_clp: 1000, lineas: [] }]);
    const ficha = await cargarFichaCliente('569');
    expect(ficha).not.toBe('no_existe');
    if (ficha === null || ficha === 'no_existe') throw new Error('inesperado');
    expect(ficha.datos.giro).toBe('Ventas');
    expect(ficha.cotizaciones[0].totalFmt).toBe('$1.190');
    expect(ficha.pedidos[0].estadoNegocio).toBe('pagado');
  });
  it('telefono desconocido -> no_existe; supabase caido -> null', async () => {
    stub([]);
    expect(await cargarFichaCliente('000')).toBe('no_existe');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect(await cargarFichaCliente('569')).toBeNull();
  });
});
