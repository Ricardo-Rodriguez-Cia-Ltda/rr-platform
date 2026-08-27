import type { NormalizedProduct } from './product.js';
import { normalize, tokenize } from './text.js';

export { normalize, tokenize };

export interface SearchFilters {
  q: string;
  marca?: string;
  categoria?: string;
}

export interface ScoredProduct {
  product: NormalizedProduct;
  score: number;
}

export interface Facets {
  marca: { valor: string; n: number }[];
  categoria: { valor: string; n: number }[];
}

const PESO_MPN_EXACTO = 100;
const PESO_MARCA = 10;
const PESO_DESCRIPCION = 3;


function scoreProduct(
  product: NormalizedProduct,
  terms: string[],
  normalizedQuery: string,
): number {
  const normalizedMpn = normalize(product.mpn ?? '');
  const compactedMpn = tokenize(product.mpn ?? '').join('');
  const brandTokens = new Set(tokenize(product.marca ?? ''));
  const descriptionTokens = new Set(tokenize(product.nombre ?? ''));

  // El MPN aporta a lo sumo PESO_MPN_EXACTO por producto, sin importar en
  // cuantos tokens se parta: un MPN de dos tokens no vale mas que uno de uno.
  // Solo se otorga cuando el MPN completo calza (con o sin su puntuacion
  // original), nunca por un fragmento suelto: un termino corto como "27" o
  // "16" no debe hacer calzar cualquier MPN que lo contenga en algun lado.
  let score = 0;
  const fullMpnMatch =
    Boolean(normalizedMpn) &&
    (normalizedQuery === normalizedMpn ||
      (Boolean(compactedMpn) && terms.includes(compactedMpn)));
  if (fullMpnMatch) score += PESO_MPN_EXACTO;

  for (const term of terms) {
    if (brandTokens.has(term)) score += PESO_MARCA;
    if (descriptionTokens.has(term)) score += PESO_DESCRIPCION;
  }
  return score;
}

export function search(catalog: NormalizedProduct[], filters: SearchFilters): ScoredProduct[] {
  const marca = filters.marca ? normalize(filters.marca) : undefined;
  const categoria = filters.categoria ? normalize(filters.categoria) : undefined;
  // Lo que ya se filtro no debe volver a puntuar: si se pide marca=HP, la
  // palabra "HP" de la consulta sumaria en los 800 productos de la marca y
  // ahogaria al termino que de verdad discrimina ("notebook"), devolviendo
  // mochilas y mouses HP a quien pidio un notebook.
  const filterTokens = new Set([
    ...tokenize(filters.marca ?? ''),
    ...tokenize(filters.categoria ?? ''),
  ]);
  const terms = [...new Set(tokenize(filters.q))].filter((t) => !filterTokens.has(t));
  const normalizedQuery = normalize(filters.q).trim();

  const results: ScoredProduct[] = [];
  for (const product of catalog) {
    if (marca && normalize(product.marca ?? '') !== marca) continue;
    if (categoria && normalize(product.categoria ?? '') !== categoria) continue;

    const score = terms.length === 0 ? 1 : scoreProduct(product, terms, normalizedQuery);
    if (score > 0) results.push({ product, score });
  }

  return results.sort((a, b) => b.score - a.score);
}

function count(values: (string | null | undefined)[]): { valor: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const valor of values) {
    if (!valor) continue;
    counts.set(valor, (counts.get(valor) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([valor, n]) => ({ valor, n }))
    .sort((a, b) => b.n - a.n || a.valor.localeCompare(b.valor));
}

export function computeFacets(productos: NormalizedProduct[]): Facets {
  return {
    marca: count(productos.map((p) => p.marca)),
    categoria: count(productos.map((p) => p.categoria)),
  };
}
