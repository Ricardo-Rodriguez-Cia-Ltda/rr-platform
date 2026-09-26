import { CatalogUnavailableError, getCatalog } from '@rr/providers/catalog';
import { fotoDe } from '@rr/providers/fotos/indice';
import { computeFacets, search } from '@rr/domain/search';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo, Provider } from '@rr/domain/types';
import { agruparCoincidencias, completarGrupos, elegirGanador, type GrupoBusqueda } from './busqueda-multi.js';
import { cotizarLote } from './cotizar-lote.js';
import {
  MAX_CANDIDATOS_CON_FILTROS, MAX_CANDIDATOS_SIN_FILTROS, UMBRAL_AMBIGUEDAD,
  explainEmpty, leerParametrosBusqueda, type Cotizado,
} from './search.js';
import type { Handler } from './types.js';

// Presupuesto de reloj de /search, contado desde que llega el pedido (no desde
// que se termino de buscar en los catalogos). Es menor que los 20 s del
// handler de un mayorista porque la tienda aborta su fetch a los 21 s
// (apps/tienda/src/lib/catalogo.ts) y entre medio esta el salto del tunel:
// con 18 s la respuesta parcial alcanza a llegar en vez de un "sin resultados".
export const PRESUPUESTO_BUSQUEDA_MULTI_MS = 18000;

// Grupos que se cotizan en la sonda. Si con ellos ya se junta `limite`, el
// resto de los candidatos no se cotiza: Ingram comparte su cuota con la
// cotizacion (/mejor-precio) y no conviene gastarla de mas.
export const GRUPOS_SONDA = MAX_CANDIDATOS_SIN_FILTROS;

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
    const deadline = Date.now() + PRESUPUESTO_BUSQUEDA_MULTI_MS;
    const params = leerParametrosBusqueda(req, res);
    if (!params) return;
    const { q, marca, categoria, subcategoria, onlyWithStock, maxPrice, limit } = params;

    const cargados = Object.values(providers)
      .filter((provider) => provider.isConfigured())
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
    const candidatos = completarGrupos(
      grupos.slice(0, hayFiltros ? MAX_CANDIDATOS_CON_FILTROS : MAX_CANDIDATOS_SIN_FILTROS),
      cargados.map(({ provider, catalogo }) => ({ proveedor: provider.name, catalogo })),
    );

    const precios: Record<string, Map<string, PriceInfo>> = Object.fromEntries(cargados.map(({ provider }) => [provider.name, new Map()]));
    // SKU que ni se cotizaron en vivo ni se rescataron del cache, por mayorista.
    const sinResolverPorProveedor: Record<string, Set<string>> = Object.fromEntries(cargados.map(({ provider }) => [provider.name, new Set()]));
    let parcial = false;
    let maxAgeMs = 0;
    const conSkus = new Set<string>();
    const respondieron = new Set<string>();

    // Una ronda cotiza los SKU de sus grupos en los tres mayoristas a la vez,
    // con el mismo limite de reloj para todas las rondas.
    const cotizarRonda = async (ronda: GrupoBusqueda[]): Promise<void> => {
      const skusDe: Record<string, string[]> = {};
      for (const g of ronda) {
        for (const [proveedor, productos] of Object.entries(g.porProveedor)) {
          (skusDe[proveedor] ??= []).push(...productos.map((p) => p.sku));
        }
      }
      const lotes = await Promise.all(
        cargados.map(async ({ provider }) => ({ nombre: provider.name, ...(await cotizarLote(provider, skusDe[provider.name] ?? [], deadline)) })),
      );
      for (const l of lotes) {
        for (const [sku, p] of l.precios) precios[l.nombre].set(sku, p);
        for (const sku of l.sinResolver) sinResolverPorProveedor[l.nombre].add(sku);
        maxAgeMs = Math.max(maxAgeMs, l.maxAgeMs);
        if ((skusDe[l.nombre] ?? []).length > 0) {
          conSkus.add(l.nombre);
          if (!l.fallaTotal) respondieron.add(l.nombre);
        }
      }
    };

    const evaluados: Cotizado[] = [];
    const productos: Cotizado[] = [];
    const procesar = (ronda: GrupoBusqueda[]): void => {
      for (const g of ronda) {
        const ganador = elegirGanador(g, precios);
        // Un grupo con un SKU sin resolver es "incompleto" solo si ademas no
        // hay ganador o el ganador no tiene stock: un mayorista caido puede
        // ganarle en precio a un ganador con stock, y eso es aceptable — no
        // vale la pena marcar `parcial` por eso.
        const sinResolver = Object.entries(g.porProveedor).some(
          ([proveedor, lista]) => lista.some((p) => sinResolverPorProveedor[proveedor]?.has(p.sku)),
        );
        if (sinResolver && (!ganador || (ganador.stock ?? 0) <= 0)) parcial = true;
        if (!ganador) continue;
        // Lo descriptivo sale del representante (Intcomex si esta): sus nombres
        // y categorias son los que entienden la tienda y explainEmpty. Lo que
        // se cobra sale del ganador.
        const rep = g.representante;
        const cotizado: Cotizado = {
          sku: ganador.sku,
          mpn: rep.mpn,
          nombre: rep.nombre,
          marca: rep.marca,
          categoria: rep.categoria,
          precio: ganador.precio,
          moneda: ganador.moneda,
          stock: ganador.stock,
          foto: fotoDe(rep),
          proveedor: ganador.proveedor,
        };
        evaluados.push(cotizado);
        if (cotizado.precio > maxPrice) continue;
        if (onlyWithStock && (cotizado.stock ?? 0) <= 0) continue;
        if (productos.length < limit) productos.push(cotizado);
      }
    };

    // Sonda: los primeros grupos van solos. Solo si no juntan `limite`, queda
    // tiempo y hay mas candidatos, se cotiza el resto en una segunda ronda.
    const sonda = candidatos.slice(0, GRUPOS_SONDA);
    const resto = candidatos.slice(GRUPOS_SONDA);
    await cotizarRonda(sonda);
    procesar(sonda);
    if (productos.length < limit && resto.length > 0) {
      if (Date.now() < deadline) {
        await cotizarRonda(resto);
        procesar(resto);
      } else {
        // Quedaron candidatos sin mirar: no se puede afirmar que no haya.
        parcial = true;
      }
    }

    // Nada para mostrar y ningun mayorista respondio: el mismo 502 de hoy.
    if (evaluados.length === 0 && candidatos.length > 0 && [...conSkus].every((p) => !respondieron.has(p))) {
      res.status(502).json({ error: 'upstream', detail: 'Ningun mayorista respondio a tiempo' });
      return;
    }

    // Mayoristas que dejaron al menos un SKU sin resolver, aunque no hayan
    // llegado a marcar `parcial` (un ganador con stock los tapa).
    const proveedoresIncompletos = Object.entries(sinResolverPorProveedor)
      .filter(([, skus]) => skus.size > 0)
      .map(([nombre]) => nombre)
      .sort();

    const devueltos = productos.map((p) => p.precio);
    res.status(200).json({
      total: grupos.length,
      evaluados: evaluados.length,
      ...(parcial ? { parcial: true } : {}),
      ...(proveedoresIncompletos.length > 0 ? { proveedores_incompletos: proveedoresIncompletos } : {}),
      productos,
      facetas: devueltos.length > 0 ? { ...facetas, precio: { min: Math.min(...devueltos), max: Math.max(...devueltos) } } : facetas,
      ...(productos.length === 0 && evaluados.length > 0 ? { sin_resultados: explainEmpty(evaluados, onlyWithStock, parcial) } : {}),
      ...(maxAgeMs > 0 ? { precios_de_hace_min: Math.ceil(maxAgeMs / 60000) } : {}),
    });
  };
}
