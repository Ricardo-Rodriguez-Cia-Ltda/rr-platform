import { normalizar, tokenizar } from './texto.js';

export interface ProductoNormalizado {
  /** Identificador del proveedor. NO es comparable entre proveedores. */
  sku: string;
  /** Part number del fabricante: la unica pista comun entre distribuidores. */
  mpn: string | null;
  nombre: string | null;
  marca: string | null;
  categoria: string | null;
  subcategorias: string[];
  tipo: string | null;
}

/**
 * Un mismo MPN viaja escrito distinto segun el distribuidor (2N6G5LT#ABM,
 * 2N6G5LT-ABM, "2N6G5LT ABM"). Se compacta a solo letras y numeros para que
 * las variantes colapsen en la misma clave.
 */
export function compactarMpn(mpn: string | null): string {
  return tokenizar(mpn ?? '').join('');
}

/**
 * Clave para emparejar el mismo producto entre proveedores.
 *
 * Devuelve null cuando el producto no se puede comparar con confianza: sin MPN
 * o sin marca queda fuera del "mejor precio" en vez de arriesgar un falso
 * positivo, porque emparejar mal significa cotizarle al cliente otro producto.
 */
export function claveUnion(producto: ProductoNormalizado): string | null {
  const mpn = compactarMpn(producto.mpn);
  const marca = normalizar(producto.marca ?? '').trim();
  if (!mpn || !marca) return null;
  return `${mpn}|${marca}`;
}
