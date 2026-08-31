import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PriceInfo } from '@rr/domain/types';

// La busqueda conversa sobre estos precios; la cotizacion jamas los toca (ver
// docs/superpowers/specs/2026-08-31-cache-de-precios-design.md). Fresco se usa
// siempre; utilizable solo cuando el lote en vivo fallo.
export const FRESH_MS = 15 * 60 * 1000;
export const USABLE_MS = 24 * 60 * 60 * 1000;

export interface CachedPrice {
  info: PriceInfo | null; // null = el proveedor no devolvio precio para este SKU
  quotedAt: number;
}

export interface CacheLookup {
  fresh: Map<string, CachedPrice>;
  usable: Map<string, CachedPrice>;
}

interface DiskShape {
  entries: Record<string, CachedPrice>;
}

function cacheDir(): string {
  return process.env.CATALOG_CACHE_DIR ?? 'cache';
}

export class PriceCache {
  private entries = new Map<string, CachedPrice>();
  private readonly path: string;

  constructor(private readonly proveedor: string) {
    this.path = join(cacheDir(), `prices-${proveedor}.json`);
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as DiskShape;
      for (const [sku, entry] of Object.entries(raw.entries ?? {})) {
        if (typeof entry?.quotedAt === 'number') this.entries.set(sku, entry);
      }
    } catch {
      // Corrupto, ilegible o inexistente: se parte vacio. Jamas es fatal.
    }
  }

  private age(entry: CachedPrice): number {
    const age = Date.now() - entry.quotedAt;
    // Una fecha futura no es "muy fresca": es un reloj mentiroso. Vencida.
    return age >= 0 ? age : Number.POSITIVE_INFINITY;
  }

  get(skus: string[]): CacheLookup {
    const fresh = new Map<string, CachedPrice>();
    const usable = new Map<string, CachedPrice>();
    for (const sku of skus) {
      const entry = this.entries.get(sku);
      if (!entry) continue;
      const age = this.age(entry);
      if (age <= FRESH_MS) fresh.set(sku, entry);
      else if (age <= USABLE_MS) usable.set(sku, entry);
    }
    return { fresh, usable };
  }

  put(results: Map<string, PriceInfo>, requested: string[]): void {
    // Un lote 200 vacio (le pasa a Intcomex en sus dias malos) es indistinguible
    // de "estos SKUs no tienen precio": es mas probable un bache del proveedor
    // que 100 SKUs muertos a la vez. Si no vino nada, no se escribe ningun
    // negativo — los aciertos tampoco existen, asi que no hay nada que
    // persistir. Un lote donde ALGUNOS vinieron si cachea el negativo de los
    // ausentes: ese es el negativo legitimo.
    if (results.size === 0 && requested.length > 0) return;
    const quotedAt = Date.now();
    for (const sku of requested) {
      this.entries.set(sku, { info: results.get(sku) ?? null, quotedAt });
    }
    // Poda al escribir: lo vencido no merece disco.
    for (const [sku, entry] of this.entries) {
      if (this.age(entry) > USABLE_MS) this.entries.delete(sku);
    }
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(cacheDir(), { recursive: true });
      const shape: DiskShape = { entries: Object.fromEntries(this.entries) };
      // Temporal por pid + rename: dos procesos escribiendo a la vez (produccion
      // y un serve de pruebas, por ejemplo) nunca mezclan su temporal ni dejan
      // un archivo a medias. Gana el rename del ultimo en terminar; el otro
      // proceso pierde su delta desde su ultima escritura, pero el archivo
      // jamas se corrompe. Ojo: el cache de catalogo escribe directo; ese
      // patron NO se copia aca.
      const tmpPath = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(shape));
      renameSync(tmpPath, this.path);
    } catch (error) {
      // Un disco que falla degrada a cache solo-memoria; no tumba la busqueda.
      console.error(`[price-cache] ${this.proveedor}: no se pudo persistir`, error);
    }
  }
}

const singletons = new Map<string, PriceCache>();

export function getPriceCache(proveedor: string): PriceCache {
  let cache = singletons.get(proveedor);
  if (!cache) {
    cache = new PriceCache(proveedor);
    singletons.set(proveedor, cache);
  }
  return cache;
}

export function resetPriceCachesForTests(): void {
  singletons.clear();
}
