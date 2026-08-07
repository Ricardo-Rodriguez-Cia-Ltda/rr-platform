import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../lib/auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '../lib/catalog.js';
import { getPrices } from '../lib/providers/intcomex.js';
import { buscar, calcularFacetas } from '../lib/search.js';
import { ProviderError } from '../lib/types.js';

const UMBRAL_AMBIGUEDAD = 25;
const MAX_CANDIDATOS_A_COTIZAR = 50;
const LIMITE_POR_DEFECTO = 10;

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
    return;
  }
  if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
    res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
    return;
  }

  const q = firstString(req.query.q)?.trim();
  if (!q) {
    res.status(400).json({ error: 'bad_request', detail: 'El parametro q es obligatorio' });
    return;
  }

  const marca = firstString(req.query.marca);
  const categoria = firstString(req.query.categoria);
  const precioMax = Number(firstString(req.query.precio_max) ?? NaN);
  const soloConStock = firstString(req.query.solo_con_stock) === 'true';

  const limiteCrudo = firstString(req.query.limite);
  let limite = LIMITE_POR_DEFECTO;
  if (limiteCrudo !== undefined) {
    const n = Number(limiteCrudo);
    if (!Number.isInteger(n) || n < 0) {
      res.status(400).json({
        error: 'bad_request',
        detail: 'limite debe ser un entero mayor o igual a 0',
      });
      return;
    }
    limite = n;
  }

  let catalogo;
  try {
    catalogo = obtenerCatalogo();
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      res.status(503).json({
        error: 'catalogo_no_disponible',
        detail: 'El catalogo aun no se ha descargado. Reintenta en unos segundos.',
      });
      return;
    }
    throw error;
  }

  const coincidencias = buscar(catalogo, { q, marca, categoria });
  const productosCoincidentes = coincidencias.map((r) => r.product);
  const facetas = calcularFacetas(productosCoincidentes);

  if (coincidencias.length > UMBRAL_AMBIGUEDAD && !marca && !categoria) {
    res.status(409).json({
      error: 'demasiado_amplio',
      detail: `${coincidencias.length} coincidencias. Acota con marca o categoria.`,
      total: coincidencias.length,
      facetas,
    });
    return;
  }

  const candidatos = productosCoincidentes.slice(0, MAX_CANDIDATOS_A_COTIZAR);

  let precios;
  try {
    precios = await getPrices(candidatos.map((p) => p.Sku));
  } catch (error) {
    if (error instanceof ProviderError) {
      res.status(502).json({ error: 'upstream', detail: error.detail ?? error.message });
      return;
    }
    res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
    return;
  }

  const productos = candidatos
    .map((p) => {
      const precio = precios.get(p.Sku);
      if (!precio) return null;
      return {
        sku: p.Sku,
        mpn: p.Mpn ?? null,
        nombre: p.Description ?? null,
        marca: p.Brand?.Description ?? null,
        categoria: p.Category?.Description ?? null,
        precio: precio.price,
        moneda: precio.currency,
        stock: precio.inStock,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .filter((p) => (Number.isFinite(precioMax) ? p.precio <= precioMax : true))
    .filter((p) => (soloConStock ? (p.stock ?? 0) > 0 : true))
    .slice(0, limite);

  res.status(200).json({ total: coincidencias.length, productos, facetas });
}
