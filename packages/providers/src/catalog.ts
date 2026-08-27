import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedProduct } from '@rr/domain/product';
import { PROVIDERS } from './index.js';

const VIGENCIA_MS = 24 * 60 * 60 * 1000;

export class CatalogUnavailableError extends Error {
  constructor() {
    super('El catálogo todavía no está disponible');
    this.name = 'CatalogUnavailableError';
  }
}

interface CacheEnDisco {
  descargadoEn: string;
  productos: NormalizedProduct[];
}

const enMemoria = new Map<string, NormalizedProduct[]>();

function directorioCache(): string {
  return process.env.CATALOG_CACHE_DIR ?? 'cache';
}

function rutaCache(proveedor: string): string {
  return join(directorioCache(), `catalog-${proveedor}.json`);
}

function leerCache(proveedor: string): CacheEnDisco | null {
  try {
    return JSON.parse(readFileSync(rutaCache(proveedor), 'utf8')) as CacheEnDisco;
  } catch {
    return null;
  }
}

function escribirCache(proveedor: string, productos: NormalizedProduct[]): void {
  const ruta = rutaCache(proveedor);
  mkdirSync(directorioCache(), { recursive: true });
  writeFileSync(
    ruta,
    JSON.stringify({ descargadoEn: new Date().toISOString(), productos } satisfies CacheEnDisco),
  );
}

function estaVigente(cache: CacheEnDisco): boolean {
  const edad = Date.now() - new Date(cache.descargadoEn).getTime();
  return Number.isFinite(edad) && edad >= 0 && edad < VIGENCIA_MS;
}

export async function loadCatalog(proveedor: string): Promise<NormalizedProduct[]> {
  const registered = PROVIDERS[proveedor];
  if (!registered) throw new Error(`Proveedor desconocido: ${proveedor}`);

  const cache = leerCache(proveedor);
  if (cache && estaVigente(cache)) {
    enMemoria.set(proveedor, cache.productos);
    return cache.productos;
  }

  try {
    const productos = await registered.loadCatalog();
    escribirCache(proveedor, productos);
    enMemoria.set(proveedor, productos);
    return productos;
  } catch (error) {
    // Un catálogo viejo sirve mucho más que ninguno: el precio siempre se
    // consulta aparte, así que lo desactualizado aquí es a lo sumo el surtido.
    if (cache) {
      console.error(`[catalog] ${proveedor}: no se pudo refrescar, se usa el caché vencido`, error);
      enMemoria.set(proveedor, cache.productos);
      return cache.productos;
    }
    throw error;
  }
}

export function getCatalog(proveedor: string): NormalizedProduct[] {
  const productos = enMemoria.get(proveedor);
  if (!productos) throw new CatalogUnavailableError();
  return productos;
}

export function _resetCatalogForTests(): void {
  enMemoria.clear();
}
