import { cfgPrecios, costoMaxUsd, formatCLP, precioTiendaClp, ventaNetaClp } from './precios.js';

// Cliente server-side de la pricing-api. La API entrega COSTOS en USD: este
// modulo es la frontera donde se convierten a precio tienda y donde el costo
// MUERE — ProductoTienda no tiene campo para el, y el test de invariante
// vigila que ni claves ni valores crudos sobrevivan.
const TIMEOUT_MS = 21000; // presupuesto de la API (20s) + margen

export interface ProductoTienda {
  sku: string; mpn: string | null; marca: string | null; nombre: string;
  categoria: string | null;
  /** Neto unitario en CLP (sin IVA): es lo que el carro suma. */
  precioNetoClp: number;
  /** Neto unitario + IVA: es lo que se muestra. */
  precioClp: number;
  precioFmt: string;
  disponible: boolean;
}
export interface ResultadoBusqueda {
  productos: ProductoTienda[]; total: number; parcial: boolean;
  categorias: string[]; marcas: string[];
  /**
   * La API respondio 409 `demasiado_amplio`: hay mas de 25 coincidencias y no
   * vino ningun filtro. NO es una caida — es el camino normal de una busqueda
   * amplia, y el cuerpo trae las facetas con las que acotar.
   */
  demasiadoAmplio: boolean;
}

/** computeFacets (packages/domain/src/search.ts) devuelve las claves en SINGULAR. */
interface FacetaCruda { valor?: unknown; n?: unknown }
interface FacetasCrudas { marca?: FacetaCruda[]; categoria?: FacetaCruda[]; subcategoria?: FacetaCruda[] }

function valores(faceta: FacetaCruda[] | undefined): string[] {
  if (!Array.isArray(faceta)) return [];
  return faceta.map((f) => String(f?.valor ?? '')).filter((v) => v !== '');
}

function base(): { url: string; key: string } | null {
  const url = process.env.PRICING_API_URL;
  const key = process.env.PRICING_API_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

/**
 * Devuelve status + cuerpo. El status importa: el 409 `demasiado_amplio` trae
 * datos utiles y no puede colapsarse a null como el resto de los fallos.
 * null = ni siquiera hubo respuesta parseable (sin config, red caida, timeout).
 */
async function apiGet(path: string): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const cfg = base();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}${path}`, {
      headers: { 'x-api-key': cfg.key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, data };
  } catch {
    return null;
  }
}

export async function buscarCatalogo(params: {
  q: string; categoria?: string; marca?: string; precioMaxClp?: number; limite?: number;
  soloConStock?: boolean;
}): Promise<ResultadoBusqueda | null> {
  const precios = cfgPrecios();
  if (!precios) return null;
  const query = new URLSearchParams({ q: params.q, limite: String(params.limite ?? 24) });
  if (params.categoria) query.set('categoria', params.categoria);
  if (params.marca) query.set('marca', params.marca);
  // El filtro lo aplica la API, que busca mas abajo en el ranking cuando hay
  // filtros: en el catalogo real apenas ~27% de los productos tiene stock, asi
  // que pedir los primeros por relevancia y filtrar aca devuelve casi siempre
  // cero disponibles.
  if (params.soloConStock) query.set('solo_con_stock', 'true');
  if (params.precioMaxClp) query.set('precio_max', costoMaxUsd(params.precioMaxClp, precios).toFixed(4));

  const res = await apiGet(`/search?${query.toString()}`);
  if (!res) return null;

  // apps/pricing-api/src/handlers/search.ts:157-163
  if (res.status === 409 && res.data.error === 'demasiado_amplio') {
    const facetas = (res.data.facetas ?? {}) as FacetasCrudas;
    return {
      demasiadoAmplio: true,
      productos: [],
      total: Number(res.data.total ?? 0),
      parcial: false,
      marcas: valores(facetas.marca),
      categorias: valores(facetas.categoria),
    };
  }
  if (res.status !== 200) return null;

  const data = res.data;
  if (!Array.isArray(data.productos)) return null;
  const facetas = (data.facetas ?? {}) as FacetasCrudas;
  return {
    demasiadoAmplio: false,
    total: Number(data.total ?? 0),
    parcial: data.parcial === true,
    categorias: valores(facetas.categoria),
    marcas: valores(facetas.marca),
    productos: (data.productos as Array<Record<string, unknown>>)
      .filter((p) => {
        const costo = Number(p.precio);
        // Falla cerrado ante moneda distinta de USD: el costo se multiplica
        // por TIPO_CAMBIO_CLP_USD, asi que un precio en pesos se cobraria
        // ~950 veces de mas. Mismo criterio que el bot.
        if (String(p.moneda ?? '').toUpperCase() !== 'USD') return false;
        // Un costo 0 o negativo no se cotiza: regalaria el producto y ademas
        // generar-cotizacion-v2 nunca devolveria ese total.
        return Number.isFinite(costo) && costo > 0;
      })
      .map((p) => {
        const costo = Number(p.precio);
        const precioNetoClp = ventaNetaClp(costo, precios);
        const precioClp = precioTiendaClp(costo, precios);
        return {
          sku: String(p.sku ?? ''),
          mpn: p.mpn == null ? null : String(p.mpn),
          marca: p.marca == null ? null : String(p.marca),
          nombre: String(p.nombre ?? ''),
          categoria: p.categoria == null ? null : String(p.categoria),
          precioNetoClp,
          precioClp,
          precioFmt: formatCLP(precioClp),
          disponible: Number(p.stock ?? 0) > 0,
        };
      }),
  };
}

export interface GrupoDestacado {
  categoria: string;
  productos: ProductoTienda[];
}

/**
 * Productos para la portada, tomados de las categorias mas pobladas del
 * catalogo (`/facetas` ya las devuelve ordenadas por cantidad).
 *
 * Tres reglas que vienen del diseno, no del azar:
 * - Cada busqueda va ACOTADA por categoria. Sin filtro, la API responde 409
 *   `demasiado_amplio` y no habria nada que mostrar.
 * - Solo productos con stock: destacar en la portada algo que no se puede
 *   despachar es peor que no destacar nada.
 * - Una categoria que falla se omite y las demas siguen. La portada tiene que
 *   salir igual: el buscador es lo esencial, esto es vitrina.
 */
export async function cargarDestacados(categorias: string[], porCategoria = 2): Promise<GrupoDestacado[]> {
  if (categorias.length === 0) return [];

  const grupos = await Promise.all(
    categorias.map(async (categoria): Promise<GrupoDestacado> => {
      // `q` es obligatorio en la API; el propio nombre de la categoria sirve
      // de termino y ademas ordena por relevancia dentro de ella.
      const r = await buscarCatalogo({ q: categoria, categoria, soloConStock: true, limite: porCategoria * 2 })
        .catch(() => null);
      const productos = (r?.productos ?? []).filter((p) => p.disponible).slice(0, porCategoria);
      return { categoria, productos };
    }),
  );

  return grupos.filter((g) => g.productos.length > 0);
}

export async function cargarPortada(): Promise<{ categorias: string[] } | null> {
  // La ruta es /facetas (app.ts registra `facetas`, no `facets`) y el cuerpo
  // trae `categoria` en singular como {valor, n}[].
  const res = await apiGet('/facetas');
  if (!res || res.status !== 200) return null;
  return { categorias: valores((res.data as FacetasCrudas).categoria) };
}
