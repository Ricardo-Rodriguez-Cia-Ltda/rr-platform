export interface CatalogProduct {
  Sku: string;
  Mpn: string | null;
  Description: string | null;
  Type?: string | null;
  Brand?: { Description?: string | null } | null;
  Category?: {
    Description?: string | null;
    Subcategories?: { Description?: string | null }[];
  } | null;
}

export interface SearchFilters {
  q: string;
  marca?: string;
  categoria?: string;
}

export interface ScoredProduct {
  product: CatalogProduct;
  score: number;
}

export interface Facetas {
  marca: { valor: string; n: number }[];
  categoria: { valor: string; n: number }[];
}

const PESO_MPN_EXACTO = 100;
const PESO_MARCA = 10;
const PESO_DESCRIPCION = 3;

export function normalizar(texto: string): string {
  // U+0300-U+036F = marcas diacríticas combinantes que NFD separa de la letra.
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function tokenizar(texto: string): string[] {
  return normalizar(texto)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function puntuar(product: CatalogProduct, terminos: string[], consultaNormalizada: string): number {
  const mpnNormalizado = normalizar(product.Mpn ?? '');
  const mpnCompacto = tokenizar(product.Mpn ?? '').join('');
  const tokensMarca = new Set(tokenizar(product.Brand?.Description ?? ''));
  const tokensDescripcion = new Set(tokenizar(product.Description ?? ''));

  // El MPN aporta a lo sumo PESO_MPN_EXACTO por producto, sin importar en
  // cuantos tokens se parta: un MPN de dos tokens no vale mas que uno de uno.
  // Solo se otorga cuando el MPN completo calza (con o sin su puntuacion
  // original), nunca por un fragmento suelto: un termino corto como "27" o
  // "16" no debe hacer calzar cualquier MPN que lo contenga en algun lado.
  let score = 0;
  const calzaMpnCompleto =
    Boolean(mpnNormalizado) &&
    (consultaNormalizada === mpnNormalizado ||
      (Boolean(mpnCompacto) && terminos.includes(mpnCompacto)));
  if (calzaMpnCompleto) score += PESO_MPN_EXACTO;

  for (const termino of terminos) {
    if (tokensMarca.has(termino)) score += PESO_MARCA;
    if (tokensDescripcion.has(termino)) score += PESO_DESCRIPCION;
  }
  return score;
}

export function buscar(catalogo: CatalogProduct[], filtros: SearchFilters): ScoredProduct[] {
  const marca = filtros.marca ? normalizar(filtros.marca) : undefined;
  const categoria = filtros.categoria ? normalizar(filtros.categoria) : undefined;
  // Lo que ya se filtro no debe volver a puntuar: si se pide marca=HP, la
  // palabra "HP" de la consulta sumaria en los 800 productos de la marca y
  // ahogaria al termino que de verdad discrimina ("notebook"), devolviendo
  // mochilas y mouses HP a quien pidio un notebook.
  const tokensDelFiltro = new Set([
    ...tokenizar(filtros.marca ?? ''),
    ...tokenizar(filtros.categoria ?? ''),
  ]);
  const terminos = [...new Set(tokenizar(filtros.q))].filter((t) => !tokensDelFiltro.has(t));
  const consultaNormalizada = normalizar(filtros.q).trim();

  const resultados: ScoredProduct[] = [];
  for (const product of catalogo) {
    if (marca && normalizar(product.Brand?.Description ?? '') !== marca) continue;
    if (categoria && normalizar(product.Category?.Description ?? '') !== categoria) continue;

    const score = terminos.length === 0 ? 1 : puntuar(product, terminos, consultaNormalizada);
    if (score > 0) resultados.push({ product, score });
  }

  return resultados.sort((a, b) => b.score - a.score);
}

function contar(valores: (string | null | undefined)[]): { valor: string; n: number }[] {
  const conteo = new Map<string, number>();
  for (const valor of valores) {
    if (!valor) continue;
    conteo.set(valor, (conteo.get(valor) ?? 0) + 1);
  }
  return [...conteo.entries()]
    .map(([valor, n]) => ({ valor, n }))
    .sort((a, b) => b.n - a.n || a.valor.localeCompare(b.valor));
}

export function calcularFacetas(productos: CatalogProduct[]): Facetas {
  return {
    marca: contar(productos.map((p) => p.Brand?.Description)),
    categoria: contar(productos.map((p) => p.Category?.Description)),
  };
}
