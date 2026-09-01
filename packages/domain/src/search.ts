import type { NormalizedProduct } from './product.js';
import { normalize, tokenize } from './text.js';

export { normalize, tokenize };

export interface SearchFilters {
  q: string;
  marca?: string;
  categoria?: string;
  subcategoria?: string;
}

export interface ScoredProduct {
  product: NormalizedProduct;
  score: number;
}

export interface Facets {
  marca: { valor: string; n: number }[];
  categoria: { valor: string; n: number }[];
  subcategoria: { valor: string; n: number }[];
}

const PESO_MPN_EXACTO = 100;
const PESO_MARCA = 10;
const PESO_DESCRIPCION = 3;

// Un termino de consulta como "32gb" o "1tb" tokeniza a una sola palabra
// (digitos y letras pegados, sin separador), pero el catalogo suele traer la
// spec separada en el nombre ("32 GB"). Sin esto, "no hay notebooks con
// 32GB" era falso: habia 157, pero el termino pegado del cliente nunca
// calzaba contra los dos tokens sueltos del catalogo (medido en vivo,
// 2026-09-01).
const SPEC_TERM = /^(\d+(?:\.\d+)?)([a-z]+)$/;

/**
 * Subpartes de un token partiendo en la frontera digito<->letra (ssd1tb ->
 * ssd, 1, tb). Solo las de largo >= 2 o puramente numericas: una letra suelta
 * como la "i" de "i5" es ruido, no una spec.
 */
function specSubparts(token: string): string[] {
  const segmentos = token.match(/\p{L}+|\p{N}+/gu) ?? [];
  if (segmentos.length <= 1) return [];
  return segmentos.filter((s) => s.length >= 2 || /^\d+$/.test(s));
}

function scoreProduct(
  product: NormalizedProduct,
  terms: string[],
  normalizedQuery: string,
): number {
  const normalizedMpn = normalize(product.mpn ?? '');
  const compactedMpn = tokenize(product.mpn ?? '').join('');
  const brandTokens = new Set(tokenize(product.marca ?? ''));
  const nameTokens = tokenize(product.nombre ?? '');
  const descriptionTokens = new Set(nameTokens);
  for (const token of nameTokens) {
    for (const sub of specSubparts(token)) descriptionTokens.add(sub);
  }

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
    if (descriptionTokens.has(term)) {
      score += PESO_DESCRIPCION;
    } else {
      // Lado consulta: "32gb" tambien puntua como descripcion si sus DOS
      // partes ("32" y "gb") estan en los tokens del nombre. Una sola vez,
      // nunca ademas del match directo de arriba.
      const specMatch = SPEC_TERM.exec(term);
      if (specMatch && descriptionTokens.has(specMatch[1]) && descriptionTokens.has(specMatch[2])) {
        score += PESO_DESCRIPCION;
      }
    }
  }
  return score;
}

export function search(catalog: NormalizedProduct[], filters: SearchFilters): ScoredProduct[] {
  const marca = filters.marca ? normalize(filters.marca) : undefined;
  const categoria = filters.categoria ? normalize(filters.categoria) : undefined;
  const subcategoria = filters.subcategoria ? normalize(filters.subcategoria) : undefined;
  // Lo que ya se filtro no debe volver a puntuar: si se pide marca=HP, la
  // palabra "HP" de la consulta sumaria en los 800 productos de la marca y
  // ahogaria al termino que de verdad discrimina ("notebook"), devolviendo
  // mochilas y mouses HP a quien pidio un notebook.
  const filterTokens = new Set([
    ...tokenize(filters.marca ?? ''),
    ...tokenize(filters.categoria ?? ''),
    ...tokenize(filters.subcategoria ?? ''),
  ]);
  const terms = [...new Set(tokenize(filters.q))].filter((t) => !filterTokens.has(t));
  const normalizedQuery = normalize(filters.q).trim();

  const results: ScoredProduct[] = [];
  for (const product of catalog) {
    if (marca && normalize(product.marca ?? '') !== marca) continue;
    if (categoria && normalize(product.categoria ?? '') !== categoria) continue;
    if (subcategoria && !product.subcategorias.some((s) => normalize(s) === subcategoria)) continue;

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
    subcategoria: count(productos.flatMap((p) => p.subcategorias)),
  };
}
