import { afterEach, describe, expect, it, vi } from 'vitest';
import { chequearSalud } from '../src/lib/salud.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const AHORA = Date.parse('2026-09-01T20:00:00Z');

// Enruta por URL: oficina responde su 404 de contrato, rele su 404 de
// contrato, supabase devuelve filas.
function stub(opciones: { oficinaStatus?: number; releBody?: string; supabaseCaido?: boolean; oficinaCaida?: boolean } = {}) {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('pyxis-latam')) {
      if (opciones.oficinaCaida) throw new Error('tunel abajo');
      return new Response('{"error":"not_found"}', { status: opciones.oficinaStatus ?? 404 });
    }
    if (u.includes('rr-mailing')) {
      return new Response(opciones.releBody ?? '{"error":"cotizacion_no_encontrada"}', { status: 404 });
    }
    if (opciones.supabaseCaido) throw new Error('caida');
    return new Response(JSON.stringify([{ quote_id: 'q' }]), { status: 200 });
  }));
}

describe('chequearSalud', () => {
  it('todo verde con la oficina respondiendo su 404 de contrato', async () => {
    stub();
    const salud = await chequearSalud(AHORA);
    expect(salud).toEqual({ supabase: true, oficina: true, rele: true, cotizaciones24h: 1, ocFallidas: 1 });
  });
  it('un 502 del tunel o una caida de red marcan la oficina en rojo', async () => {
    stub({ oficinaStatus: 502 });
    expect((await chequearSalud(AHORA)).oficina).toBe(false);
    stub({ oficinaCaida: true });
    expect((await chequearSalud(AHORA)).oficina).toBe(false);
  });
  it('el rele solo esta vivo si responde SU contrato, no cualquier 404', async () => {
    stub({ releBody: '<html>Not Found</html>' });
    expect((await chequearSalud(AHORA)).rele).toBe(false);
  });
  it('supabase caido: rojo y contadores null, sin reventar', async () => {
    stub({ supabaseCaido: true });
    const salud = await chequearSalud(AHORA);
    expect(salud.supabase).toBe(false);
    expect(salud.cotizaciones24h).toBeNull();
  });
});
