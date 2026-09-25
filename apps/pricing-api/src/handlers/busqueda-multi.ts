import { unionKey, type NormalizedProduct } from '@rr/domain/product';
import type { ScoredProduct } from '@rr/domain/search';
import type { PriceInfo } from '@rr/domain/types';
import { cheapest, pickBest, type Offer, type WinningOffer } from '@rr/providers/comparator';

// Piezas puras de la busqueda en los tres mayoristas. Ver
// docs/superpowers/specs/2026-09-25-busqueda-multi-proveedor-design.md.

export interface GrupoBusqueda {
  clave: string;
  score: number;
  porProveedor: Record<string, NormalizedProduct[]>;
  /** Producto que representa al grupo en facetas: el de Intcomex si hay; si no, el de mayor puntaje. */
  representante: NormalizedProduct;
}

export function agruparCoincidencias(porProveedor: Array<{ proveedor: string; matches: ScoredProduct[] }>): GrupoBusqueda[] {
  const grupos = new Map<string, GrupoBusqueda & { mejorScoreRep: number; repDeIntcomex: boolean; orden: number }>();
  let orden = 0;
  for (const { proveedor, matches } of porProveedor) {
    for (const { product, score } of matches) {
      let clave = unionKey(product);
      if (!clave) {
        // Sin clave no se puede comparar; la cotizacion solo sabe resolverlo
        // por SKU de Intcomex, asi que los demas mayoristas no lo aportan.
        if (proveedor !== 'intcomex') continue;
        clave = `sku:intcomex:${product.sku}`;
      }
      let g = grupos.get(clave);
      if (!g) {
        g = { clave, score, porProveedor: {}, representante: product, mejorScoreRep: score, repDeIntcomex: proveedor === 'intcomex', orden: orden++ };
        grupos.set(clave, g);
      }
      (g.porProveedor[proveedor] ??= []).push(product);
      g.score = Math.max(g.score, score);
      const esIntcomex = proveedor === 'intcomex';
      if ((esIntcomex && !g.repDeIntcomex) || (!g.repDeIntcomex && score > g.mejorScoreRep)) {
        g.representante = product;
        g.mejorScoreRep = score;
        g.repDeIntcomex = esIntcomex;
      }
    }
  }
  return [...grupos.values()]
    .sort((a, b) => b.score - a.score || a.orden - b.orden)
    .map(({ clave, score, porProveedor, representante }) => ({ clave, score, porProveedor, representante }));
}

export type Ganador = WinningOffer & { producto: NormalizedProduct };

export function elegirGanador(grupo: GrupoBusqueda, precios: Record<string, Map<string, PriceInfo>>): Ganador | null {
  const ofertas: Offer[] = [];
  const productoDe = new Map<string, NormalizedProduct>();
  for (const [proveedor, productos] of Object.entries(grupo.porProveedor)) {
    // Misma regla que la cotizacion: por mayorista, su SKU mas barato con
    // precio valido (cheapest descarta precios no positivos).
    const delGrupo = new Map<string, PriceInfo>();
    for (const producto of productos) {
      const p = precios[proveedor]?.get(producto.sku);
      if (p) delGrupo.set(producto.sku, p);
      productoDe.set(`${proveedor}:${producto.sku}`, producto);
    }
    const oferta = cheapest(proveedor, delGrupo);
    if (oferta) ofertas.push(oferta);
  }
  const ganadora = pickBest(ofertas);
  if (!ganadora) return null;
  return { ...ganadora, producto: productoDe.get(`${ganadora.proveedor}:${ganadora.sku}`)! };
}
