import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../lib/auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '../lib/catalog.js';
import { getPrices } from '../lib/providers/intcomex.js';
import { ProviderError } from '../lib/types.js';

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

  const sku = firstString(req.query.sku)?.trim();
  if (!sku) {
    res.status(400).json({ error: 'bad_request', detail: 'El parametro sku es obligatorio' });
    return;
  }

  let catalogo;
  try {
    catalogo = obtenerCatalogo();
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      res.status(503).json({
        error: 'catalogo_no_disponible',
        detail: 'El catalogo aun no esta disponible. Reintenta mas tarde.',
      });
      return;
    }
    throw error;
  }

  const producto = catalogo.find((p) => p.Sku === sku);
  if (!producto) {
    res.status(404).json({ error: 'not_found', detail: 'SKU no encontrado en el catalogo' });
    return;
  }

  let precios;
  try {
    precios = await getPrices([sku]);
  } catch (error) {
    if (error instanceof ProviderError) {
      console.error('[product] fallo getPrices', { sku, error });
      res.status(502).json({ error: 'upstream', detail: error.message, upstream: error.detail });
      return;
    }
    console.error('[product] fallo getPrices', { sku, error });
    res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
    return;
  }

  const precio = precios.get(sku);
  if (!precio) {
    res.status(404).json({ error: 'not_found', detail: 'Intcomex no entrego precio para este SKU' });
    return;
  }

  res.status(200).json({
    sku: producto.Sku,
    mpn: producto.Mpn ?? null,
    nombre: producto.Description ?? null,
    marca: producto.Brand?.Description ?? null,
    categoria: producto.Category?.Description ?? null,
    subcategorias: (producto.Category?.Subcategories ?? [])
      .map((s) => s.Description)
      .filter((d): d is string => Boolean(d)),
    tipo: producto.Type ?? null,
    precio: precio.price,
    moneda: precio.currency,
    stock: precio.inStock,
  });
}
