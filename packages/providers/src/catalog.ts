import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedProduct } from '@rr/domain/product';
import { PROVIDERS } from './index.js';

const TTL_MS = 24 * 60 * 60 * 1000;

export class CatalogUnavailableError extends Error {
  constructor() {
    super('El catálogo todavía no está disponible');
    this.name = 'CatalogUnavailableError';
  }
}

interface DiskCache {
  descargadoEn: string;
  productos: NormalizedProduct[];
}

const inMemory = new Map<string, NormalizedProduct[]>();

function cacheDir(): string {
  return process.env.CATALOG_CACHE_DIR ?? 'cache';
}

function cachePath(proveedor: string): string {
  return join(cacheDir(), `catalog-${proveedor}.json`);
}

function readCache(proveedor: string): DiskCache | null {
  try {
    return JSON.parse(readFileSync(cachePath(proveedor), 'utf8')) as DiskCache;
  } catch {
    return null;
  }
}

function writeCache(proveedor: string, productos: NormalizedProduct[]): void {
  const path = cachePath(proveedor);
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ descargadoEn: new Date().toISOString(), productos } satisfies DiskCache),
  );
}

function isFresh(cache: DiskCache): boolean {
  const age = Date.now() - new Date(cache.descargadoEn).getTime();
  return Number.isFinite(age) && age >= 0 && age < TTL_MS;
}

export async function loadCatalog(proveedor: string): Promise<NormalizedProduct[]> {
  const registered = PROVIDERS[proveedor];
  if (!registered) throw new Error(`Proveedor desconocido: ${proveedor}`);

  const cache = readCache(proveedor);
  if (cache && isFresh(cache)) {
    inMemory.set(proveedor, cache.productos);
    return cache.productos;
  }

  try {
    const productos = await registered.loadCatalog();
    writeCache(proveedor, productos);
    inMemory.set(proveedor, productos);
    return productos;
  } catch (error) {
    // Un catálogo viejo sirve mucho más que ninguno: el precio siempre se
    // consulta aparte, así que lo desactualizado aquí es a lo sumo el surtido.
    if (cache) {
      console.error(`[catalog] ${proveedor}: no se pudo refrescar, se usa el caché vencido`, error);
      inMemory.set(proveedor, cache.productos);
      return cache.productos;
    }
    throw error;
  }
}

export function getCatalog(proveedor: string): NormalizedProduct[] {
  const productos = inMemory.get(proveedor);
  if (!productos) throw new CatalogUnavailableError();
  return productos;
}

export function _resetCatalogForTests(): void {
  inMemory.clear();
}
