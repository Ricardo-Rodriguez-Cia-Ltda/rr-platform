import { CatalogUnavailableError, getCatalog } from '@rr/providers/catalog';
import { fotoDe } from '@rr/providers/fotos/indice';
import { computeFacets, search } from '@rr/domain/search';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo, Provider } from '@rr/domain/types';
import { agruparCoincidencias, elegirGanador } from './busqueda-multi.js';
import { cotizarLote } from './cotizar-lote.js';
import {
  MAX_CANDIDATOS_CON_FILTROS, MAX_CANDIDATOS_SIN_FILTROS, PRESUPUESTO_MS, UMBRAL_AMBIGUEDAD,
  explainEmpty, leerParametrosBusqueda, type Cotizado,
} from './search.js';
import type { Handler } from './types.js';

function catalogoDe(nombre: string): NormalizedProduct[] | null {
  try {
    return getCatalog(nombre);
  } catch (error) {
    if (error instanceof CatalogUnavailableError) return null;
    throw error;
  }
}

// GET /search: busca en los catalogos de todos los mayoristas cargados y, por
// producto, muestra el mismo ganador que elige la cotizacion (pickBest). Ver
// docs/superpowers/specs/2026-09-25-busqueda-multi-proveedor-design.md.
export function createMultiSearchHandler(providers: Record<string, Provider>): Handler {
  return async function handler(req, res): Promise<void> {
    const params = leerParametrosBusqueda(req, res);
    if (!params) return;
    const { q, marca, categoria, subcategoria, onlyWithStock, maxPrice, limit } = params;

    const cargados = Object.values(providers)
      .map((provider) => ({ provider, catalogo: catalogoDe(provider.name) }))
      .filter((c): c is { provider: Provider; catalogo: NormalizedProduct[] } => c.catalogo !== null);
    if (cargados.length === 0) {
      res.status(503).json({ error: 'catalogo_no_disponible', detail: 'El catalogo aun no esta disponible. Reintenta mas tarde.' });
      return;
    }

    const grupos = agruparCoincidencias(
      cargados.map(({ provider, catalogo }) => ({ proveedor: provider.name, matches: search(catalogo, { q, marca, categoria, subcategoria }) })),
    );
    const facetas = computeFacets(grupos.map((g) => g.representante));

    if (grupos.length > UMBRAL_AMBIGUEDAD && !marca && !categoria && !subcategoria) {
      res.status(409).json({
        error: 'demasiado_amplio',
        detail: `${grupos.length} coincidencias. Acota con marca o categoria.`,
        total: grupos.length,
        facetas,
      });
      return;
    }

    const hayFiltros = onlyWithStock || Number.isFinite(maxPrice);
    const candidatos = grupos.slice(0, hayFiltros ? MAX_CANDIDATOS_CON_FILTROS : MAX_CANDIDATOS_SIN_FILTROS);

    const skusDe: Record<string, string[]> = {};
    for (const g of candidatos) {
      for (const [proveedor, productos] of Object.entries(g.porProveedor)) {
        (skusDe[proveedor] ??= []).push(...productos.map((p) => p.sku));
      }
    }
    const deadline = Date.now() + PRESUPUESTO_MS;
    const lotes = await Promise.all(
      cargados.map(async ({ provider }) => ({ nombre: provider.name, ...(await cotizarLote(provider, skusDe[provider.name] ?? [], deadline)) })),
    );
    const precios: Record<string, Map<string, PriceInfo>> = Object.fromEntries(lotes.map((l) => [l.nombre, l.precios]));
    const parcial = lotes.some((l) => l.incompleto);
    const maxAgeMs = Math.max(0, ...lotes.map((l) => l.maxAgeMs));

    const evaluados: Cotizado[] = [];
    const productos: Cotizado[] = [];
    for (const g of candidatos) {
      const ganador = elegirGanador(g, precios);
      if (!ganador) continue;
      const cotizado: Cotizado = {
        sku: ganador.sku,
        mpn: ganador.producto.mpn,
        nombre: ganador.producto.nombre,
        marca: ganador.producto.marca,
        categoria: ganador.producto.categoria,
        precio: ganador.precio,
        moneda: ganador.moneda,
        stock: ganador.stock,
        foto: fotoDe(ganador.producto),
        proveedor: ganador.proveedor,
      };
      evaluados.push(cotizado);
      if (cotizado.precio > maxPrice) continue;
      if (onlyWithStock && (cotizado.stock ?? 0) <= 0) continue;
      if (productos.length < limit) productos.push(cotizado);
    }

    // Nada para mostrar y ningun mayorista respondio: el mismo 502 de hoy.
    if (evaluados.length === 0 && candidatos.length > 0 && lotes.filter((l) => (skusDe[l.nombre] ?? []).length > 0).every((l) => l.fallaTotal)) {
      res.status(502).json({ error: 'upstream', detail: 'Ningun mayorista respondio a tiempo' });
      return;
    }

    const devueltos = productos.map((p) => p.precio);
    res.status(200).json({
      total: grupos.length,
      evaluados: evaluados.length,
      ...(parcial ? { parcial: true } : {}),
      productos,
      facetas: devueltos.length > 0 ? { ...facetas, precio: { min: Math.min(...devueltos), max: Math.max(...devueltos) } } : facetas,
      ...(productos.length === 0 && evaluados.length > 0 ? { sin_resultados: explainEmpty(evaluados, onlyWithStock, parcial) } : {}),
      ...(maxAgeMs > 0 ? { precios_de_hace_min: Math.ceil(maxAgeMs / 60000) } : {}),
    });
  };
}
