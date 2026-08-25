import { tokenizar } from './texto.js';

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
 * Marcas que el mismo fabricante usa con nombres sin ninguna palabra en comun,
 * asi que la primera palabra no alcanza para juntarlas.
 *
 * Se comparan contra el nombre completo normalizado, del mas especifico al mas
 * general: "HP - POLY VIDEO" es Poly, pero su primera palabra es "hp", y tratar
 * "hp" como Poly convertiria todo el catalogo de HP en Poly.
 *
 * "hewlett packard enterprise" lleva las tres palabras a proposito: HP Inc. y
 * Hewlett Packard Enterprise son empresas distintas.
 */
const ALIAS_MARCA: [prefijo: string, canonica: string][] = [
  ['hewlett packard enterprise', 'hpe'],
  ['american power', 'apc'],
  // Adquisiciones: un distribuidor lista la marca comprada y otro la dueña, y
  // hay que resolver hacia la dueña. Ingram etiqueta como "Hp" tanto un teclado
  // HyperX como un headset Poly, asi que mapear al reves no juntaria nada.
  ['hyperx', 'hp'],
  ['poly', 'hp'],
  ['hp poly', 'hp'],
  ['aruba', 'hpe'],
  ['meraki', 'cisco'],
];

/**
 * Reduce la marca a una forma comparable entre distribuidores.
 *
 * Cada uno le pega su unidad de negocio al nombre del fabricante
 * ("BROTHER - SUMINISTROS", "SAMSUNG MONITORES Y TV", "HPE SERVER STOCK SCSB"),
 * asi que comparar la cadena completa separa productos identicos. Medido sobre
 * los catalogos reales, hacerlo descartaba 13 de cada 14 cruces entre
 * proveedores: 36 productos presentes en los tres, contra 479 reales.
 *
 * Se toma la primera palabra, que es donde vive el fabricante, y los alias de
 * arriba cubren los pocos casos que ni asi coinciden.
 */
export function marcaCanonica(marca: string | null): string {
  const normalizada = tokenizar(marca ?? '').join(' ');
  if (!normalizada) return '';

  for (const [prefijo, canonica] of ALIAS_MARCA) {
    if (normalizada === prefijo || normalizada.startsWith(`${prefijo} `)) return canonica;
  }
  return normalizada.split(' ')[0];
}

/**
 * Clave para emparejar el mismo producto entre proveedores.
 *
 * Devuelve null cuando el producto no se puede comparar con confianza: sin MPN
 * o sin marca queda fuera del "mejor precio" en vez de arriesgar un falso
 * positivo, porque emparejar mal significa cotizarle al cliente otro producto.
 *
 * La marca sigue formando parte de la clave aunque el MPN sea practicamente
 * unico -una sola colision en los 10.411 productos de Intcomex-, porque esa
 * colision es real: tres adaptadores de Trendnet, Eufy y MSI comparten el
 * part number 98PT0G1299, y sin la marca se cotizaria uno por otro.
 */
export function claveUnion(producto: ProductoNormalizado): string | null {
  const mpn = compactarMpn(producto.mpn);
  const marca = marcaCanonica(producto.marca);
  if (!mpn || !marca) return null;
  return `${mpn}|${marca}`;
}
