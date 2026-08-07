import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchIws } from './providers/intcomex.js';
import type { CatalogProduct } from './search.js';

const VIGENCIA_MS = 24 * 60 * 60 * 1000;

export class CatalogUnavailableError extends Error {
  constructor() {
    super('El catálogo todavía no está disponible');
    this.name = 'CatalogUnavailableError';
  }
}

interface CacheEnDisco {
  descargadoEn: string;
  productos: CatalogProduct[];
}

let enMemoria: CatalogProduct[] | null = null;

function rutaCache(): string {
  return process.env.CATALOG_CACHE_PATH ?? 'cache/catalog.json';
}

function leerCache(): CacheEnDisco | null {
  try {
    return JSON.parse(readFileSync(rutaCache(), 'utf8')) as CacheEnDisco;
  } catch {
    return null;
  }
}

function escribirCache(productos: CatalogProduct[]): void {
  const ruta = rutaCache();
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(
    ruta,
    JSON.stringify({ descargadoEn: new Date().toISOString(), productos } satisfies CacheEnDisco),
  );
}

function estaVigente(cache: CacheEnDisco): boolean {
  const edad = Date.now() - new Date(cache.descargadoEn).getTime();
  return Number.isFinite(edad) && edad >= 0 && edad < VIGENCIA_MS;
}

async function descargar(): Promise<CatalogProduct[]> {
  const response = await fetchIws('getcatalog');
  if (!response.ok) {
    throw new Error(`Intcomex respondió HTTP ${response.status} al pedir el catálogo`);
  }
  return (await response.json()) as CatalogProduct[];
}

export async function cargarCatalogo(): Promise<CatalogProduct[]> {
  const cache = leerCache();
  if (cache && estaVigente(cache)) {
    enMemoria = cache.productos;
    return enMemoria;
  }

  try {
    const productos = await descargar();
    escribirCache(productos);
    enMemoria = productos;
    return enMemoria;
  } catch (error) {
    // Un catálogo viejo sirve mucho más que ninguno: el precio siempre se
    // consulta aparte, así que lo desactualizado aquí es a lo sumo el surtido.
    if (cache) {
      console.error('[catalog] no se pudo refrescar, se usa el caché vencido', error);
      enMemoria = cache.productos;
      return enMemoria;
    }
    throw error;
  }
}

export function obtenerCatalogo(): CatalogProduct[] {
  if (!enMemoria) throw new CatalogUnavailableError();
  return enMemoria;
}

export function _resetCatalogoParaTests(): void {
  enMemoria = null;
}
