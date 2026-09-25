import { getPriceCache, type CachedPrice } from '@rr/providers/price-cache';
import type { PriceInfo, Provider } from '@rr/domain/types';

export interface ResultadoLote {
  /** Solo los SKU con precio. */
  precios: Map<string, PriceInfo>;
  /** Edad del dato de cache mas viejo que se uso con precio; 0 si todo fue en vivo. */
  maxAgeMs: number;
  /** Algun SKU quedo sin resolver: ni en vivo ni en cache. */
  incompleto: boolean;
  /** Habia SKU por cotizar en vivo y ningun lote respondio. */
  fallaTotal: boolean;
}

function conLimite<T>(promesa: Promise<T>, deadline: number): Promise<T> {
  const restante = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const corte = new Promise<never>((_, rechazar) => {
    timer = setTimeout(() => rechazar(new Error('limite de tiempo')), restante);
  });
  return Promise.race([promesa, corte]).finally(() => clearTimeout(timer));
}

// Cotiza los SKU de UN mayorista para la busqueda: cache fresco primero, lo
// pendiente en vivo en lotes paralelos cortados por un mismo limite de reloj,
// y lo que falle se rescata del cache utilizable. Misma politica que el
// handler de un mayorista (ver search.ts). La sonda vive en search-multi.ts:
// cada ronda llama a esta funcion una vez por mayorista.
export async function cotizarLote(provider: Provider, skus: string[], deadline: number): Promise<ResultadoLote> {
  const unicos = [...new Set(skus)];
  const precios = new Map<string, PriceInfo>();
  if (unicos.length === 0) return { precios, maxAgeMs: 0, incompleto: false, fallaTotal: false };

  const cache = getPriceCache(provider.name);
  const lookup = cache.get(unicos);
  let maxAgeMs = 0;
  const usar = (sku: string, entrada: CachedPrice) => {
    // info null = negativo cacheado: el mayorista no tiene precio para ese SKU.
    if (!entrada.info) return;
    precios.set(sku, entrada.info);
    maxAgeMs = Math.max(maxAgeMs, Date.now() - entrada.quotedAt);
  };

  const pendientes: string[] = [];
  for (const sku of unicos) {
    const fresca = lookup.fresh.get(sku);
    if (fresca) usar(sku, fresca);
    else pendientes.push(sku);
  }
  if (pendientes.length === 0) return { precios, maxAgeMs, incompleto: false, fallaTotal: false };

  const lotes: string[][] = [];
  for (let i = 0; i < pendientes.length; i += provider.maxSkusPerBatch) lotes.push(pendientes.slice(i, i + provider.maxSkusPerBatch));
  const resultados = await Promise.allSettled(lotes.map((lote) => conLimite(provider.getPrices(lote), deadline)));

  let algunoOk = false;
  let incompleto = false;
  resultados.forEach((r, i) => {
    const lote = lotes[i];
    if (r.status === 'fulfilled') {
      algunoOk = true;
      cache.put(r.value, lote);
      for (const sku of lote) {
        const p = r.value.get(sku);
        if (p) precios.set(sku, p);
      }
      return;
    }
    console.error(`[search] ${provider.name}: lote sin respuesta`, { skus: lote.length, error: r.reason instanceof Error ? r.reason.message : r.reason });
    for (const sku of lote) {
      const utilizable = lookup.usable.get(sku);
      if (utilizable) usar(sku, utilizable);
      else incompleto = true;
    }
  });
  return { precios, maxAgeMs, incompleto, fallaTotal: !algunoOk };
}
