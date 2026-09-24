import { unionKey } from '@rr/domain/product';
import { fetchIws } from '../intcomex.js';

// El catalogo extendido de Intcomex trae fichas y un arreglo `Imagenes` que
// el catalogo normal (getcatalog) no tiene. Cubre ~21% de la union de los
// tres catalogos (medido el 2026-09-22).

export interface ItemExtendido { mpn?: unknown; DescripcionMarca?: unknown; Imagenes?: unknown }
interface ImagenCruda { url?: unknown; isMainImage?: unknown }

function urlPrincipal(imagenes: unknown): string | null {
  if (!Array.isArray(imagenes) || imagenes.length === 0) return null;
  const lista = imagenes as ImagenCruda[];
  const elegida = lista.find((i) => i?.isMainImage === true) ?? lista[0];
  const url = typeof elegida?.url === 'string' ? elegida.url : '';
  return url.startsWith('https://') ? url : null;
}

export function mapaFotosIntcomex(items: ItemExtendido[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const url = urlPrincipal(item.Imagenes);
    if (!url) continue;
    const clave = unionKey({
      sku: '', nombre: null, categoria: null, subcategorias: [], tipo: null,
      mpn: typeof item.mpn === 'string' ? item.mpn : null,
      marca: typeof item.DescripcionMarca === 'string' ? item.DescripcionMarca : null,
    });
    if (clave && !mapa.has(clave)) mapa.set(clave, url);
  }
  return mapa;
}

export async function fotosIntcomex(): Promise<Map<string, string>> {
  const res = await fetchIws('downloadextendedcatalog', { format: 'json', locale: 'es' });
  if (!res.ok) throw new Error(`Intcomex respondio HTTP ${res.status} al bajar el catalogo extendido`);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('El catalogo extendido de Intcomex no es JSON valido');
  }
  if (!Array.isArray(data)) throw new Error('El catalogo extendido de Intcomex no es un arreglo');
  // Vacio o sin ninguna imagen usable es Intcomex caido, no "sin fotos": si
  // no, el orquestador descartaria miles de productos por 30 dias.
  if (data.length === 0) throw new Error('El catalogo extendido de Intcomex vino vacio');
  const mapa = mapaFotosIntcomex(data as ItemExtendido[]);
  if (mapa.size === 0) throw new Error('El catalogo extendido de Intcomex no trajo ninguna imagen usable');
  return mapa;
}
