import { cfgPrecios, costoMaxUsd, formatCLP, precioTiendaClp } from './precios.js';

// Cliente server-side de la pricing-api. La API entrega COSTOS en USD: este
// modulo es la frontera donde se convierten a precio tienda y donde el costo
// MUERE — ProductoTienda no tiene campo para el, y el test de invariante
// vigila que ni claves ni valores crudos sobrevivan.
const TIMEOUT_MS = 21000; // presupuesto de la API (20s) + margen

export interface ProductoTienda {
  sku: string; mpn: string | null; marca: string | null; nombre: string;
  categoria: string | null; precioClp: number; precioFmt: string; disponible: boolean;
}
export interface ResultadoBusqueda {
  productos: ProductoTienda[]; total: number; parcial: boolean;
  categorias: string[]; marcas: string[];
}

function base(): { url: string; key: string } | null {
  const url = process.env.PRICING_API_URL;
  const key = process.env.PRICING_API_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

async function apiGet(path: string): Promise<Record<string, unknown> | null> {
  const cfg = base();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}${path}`, {
      headers: { 'x-api-key': cfg.key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function buscarCatalogo(params: {
  q: string; categoria?: string; marca?: string; precioMaxClp?: number; limite?: number;
}): Promise<ResultadoBusqueda | null> {
  const precios = cfgPrecios();
  if (!precios) return null;
  const query = new URLSearchParams({ q: params.q, limite: String(params.limite ?? 24) });
  if (params.categoria) query.set('categoria', params.categoria);
  if (params.marca) query.set('marca', params.marca);
  if (params.precioMaxClp) query.set('precio_max', costoMaxUsd(params.precioMaxClp, precios).toFixed(4));

  const data = await apiGet(`/search?${query.toString()}`);
  if (!data || !Array.isArray(data.productos)) return null;

  const facetas = (data.facetas ?? {}) as { categorias?: string[]; marcas?: string[] };
  return {
    total: Number(data.total ?? 0),
    parcial: data.parcial === true,
    categorias: facetas.categorias ?? [],
    marcas: facetas.marcas ?? [],
    productos: (data.productos as Array<Record<string, unknown>>)
      .filter((p) => {
        const costo = Number(p.precio);
        return Number.isFinite(costo);
      })
      .map((p) => {
        const costo = Number(p.precio);
        const precioClp = precioTiendaClp(costo, precios);
        return {
          sku: String(p.sku ?? ''),
          mpn: p.mpn == null ? null : String(p.mpn),
          marca: p.marca == null ? null : String(p.marca),
          nombre: String(p.nombre ?? ''),
          categoria: p.categoria == null ? null : String(p.categoria),
          precioClp,
          precioFmt: formatCLP(precioClp),
          disponible: Number(p.stock ?? 0) > 0,
        };
      }),
  };
}

export async function cargarPortada(): Promise<{ categorias: string[] } | null> {
  const data = await apiGet('/facets');
  if (!data) return null;
  return { categorias: Array.isArray(data.categorias) ? (data.categorias as string[]) : [] };
}
