import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarDatosPedido, cargarDespacho, normalizarDespacho } from '../src/lib/datos-pedido.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function conEnv() { vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave'); }

const DESPACHO_RAW = {
  id: 3, quote_id: 'q', quote_version: '1', modalidad: 'courier', courier: 'starken', estado: 'listo',
  costo_clp: 3500, cobro_pagado: false, created_at: 'x', despacho_lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }],
};

describe('normalizarDespacho', () => {
  it('pasa despacho_lineas a lineas y completa lo ausente con null', () => {
    const d = normalizarDespacho(DESPACHO_RAW);
    expect(d.lineas).toEqual([{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }]);
    expect(d.numero_seguimiento).toBeNull();
    expect(d.costo_clp).toBe(3500);
  });
});

describe('cargarDatosPedido', () => {
  it('lee pedidos, recepciones de sus ordenes y despachos con lineas', async () => {
    conEnv();
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/pedidos?')) return new Response(JSON.stringify([{ po_id: 'oc-1', quote_id: 'q', quote_version: '1', lineas: [] }]));
      if (String(url).includes('/recepciones?')) return new Response(JSON.stringify([{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }]));
      return new Response(JSON.stringify([DESPACHO_RAW]));
    }));
    const datos = await cargarDatosPedido('q', '1');
    expect(datos?.filas).toHaveLength(1);
    expect(datos?.recepciones).toEqual([{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }]);
    expect(datos?.despachos[0].lineas).toHaveLength(1);
    expect(urls.some((u) => u.includes('quote_id=eq.q') && u.includes('quote_version=eq.1'))).toBe(true);
    expect(urls.some((u) => u.includes('/recepciones?') && u.includes('oc-1'))).toBe(true);
    expect(urls.some((u) => u.includes('/despachos?') && u.includes('despacho_lineas'))).toBe(true);
  });
  it('una falla de cualquier lectura devuelve null', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('/despachos?') ? new Response('{}', { status: 500 }) : new Response('[]')));
    expect(await cargarDatosPedido('q', '1')).toBeNull();
  });
});

describe('cargarDespacho', () => {
  it('undefined si no existe, null si falla la lectura', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    expect(await cargarDespacho(9)).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect(await cargarDespacho(9)).toBeNull();
  });
});
