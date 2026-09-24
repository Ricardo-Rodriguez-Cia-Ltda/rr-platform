import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedProduct } from '@rr/domain/product';
import {
  actualizarBancoFotos, csvFaltantes, productosDesdeCatalogos, type Descarga, type ResumenBanco,
} from './banco.js';
import { crearIcecat } from './icecat.js';
import { guardarIndice, leerIndice } from './indice.js';
import { fotosIntcomex } from './intcomex.js';
import { crearStorage } from './storage.js';

function cacheDir(): string {
  return process.env.CATALOG_CACHE_DIR ?? 'cache';
}

export function skusConStock(dir: string, proveedores: string[]): Set<string> {
  const out = new Set<string>();
  for (const prov of proveedores) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, `prices-${prov}.json`), 'utf8')) as {
        entries?: Record<string, { info?: { inStock?: number | null } | null }>;
      };
      for (const [sku, e] of Object.entries(raw.entries ?? {})) {
        if ((e?.info?.inStock ?? 0) > 0) out.add(`${prov}:${sku}`);
      }
    } catch {
      // Sin cache de precios para ese proveedor: sin datos de stock, no es error.
    }
  }
  // El cache de precios solo tiene lo cotizado en las ultimas 24h; el volcado
  // de Tecnoglobal trae el stock de todo su catalogo.
  if (proveedores.includes('tecnoglobal')) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'tecnoglobal-precios.json'), 'utf8')) as {
        productos?: Array<{ codigoTg?: unknown; stockDisp?: unknown }>;
      };
      for (const p of raw.productos ?? []) {
        if (typeof p?.codigoTg === 'string' && typeof p.stockDisp === 'number' && p.stockDisp > 0) {
          out.add(`tecnoglobal:${p.codigoTg}`);
        }
      }
    } catch {
      // Sin volcado de Tecnoglobal: sin datos de stock, no es error.
    }
  }
  return out;
}

async function descargar(url: string): Promise<Descarga | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  } catch {
    return null;
  }
}

// Candado de proceso: el servidor dispara el banco tras cada refresco y la
// primera corrida dura horas; dos a la vez duplicarian llamadas a Icecat.
let enCurso = false;

export async function correrBancoFotos(
  catalogos: Record<string, NormalizedProduct[]>,
  opciones: { limite?: number } = {},
): Promise<ResumenBanco | null> {
  if (enCurso) {
    console.log('[fotos] ya hay una corrida en curso; se omite');
    return null;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY para el banco de fotos');

  enCurso = true;
  try {
    const storage = crearStorage({ url, key });
    // Si el storage no responde se corta aca, antes de tocar el indice.
    await storage.asegurarBucket();

    const dir = cacheDir();
    const stock = skusConStock(dir, Object.keys(catalogos));
    const productos = productosDesdeCatalogos(catalogos, (prov, sku) => stock.has(`${prov}:${sku}`));
    const indice = leerIndice();
    const usuario = process.env.ICECAT_USER?.trim();
    if (!usuario) console.log('[fotos] sin ICECAT_USER: solo se usan fotos de Intcomex');

    const resumen = await actualizarBancoFotos({
      productos,
      indice,
      guardar: (i) => guardarIndice(i),
      fotosIntcomex,
      icecat: usuario ? crearIcecat(usuario) : null,
      descargar,
      subir: (ruta, bytes, tipo) => storage.subir(ruta, bytes, tipo),
      limite: opciones.limite,
    });

    writeFileSync(join(dir, 'fotos-faltantes.csv'), csvFaltantes(productos, indice));
    const conFoto = Object.keys(indice.fotos).length;
    console.log(
      `[fotos] ${resumen.procesados} procesados · nuevas intcomex ${resumen.nuevas.intcomex}, icecat ${resumen.nuevas.icecat}` +
        ` · sin foto ${JSON.stringify(resumen.sinFoto)} · pendientes ${resumen.pendientes}` +
        (resumen.intcomexCaido ? ' · INTCOMEX CAIDO' : '') +
        ` · total con foto ${conFoto}/${productos.length}`,
    );
    return resumen;
  } finally {
    enCurso = false;
  }
}
