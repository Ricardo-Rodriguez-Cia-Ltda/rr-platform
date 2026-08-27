import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '@rr/domain/catalog';
import type { Proveedor } from '@rr/domain/types';
import { ProviderError } from '@rr/domain/types';
import { resolverOResponder } from './guardas.js';
import { firstString, type Handler } from './tipos.js';

export function crearHandlerProducto(proveedor: Proveedor): Handler {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
      catalogo = obtenerCatalogo(proveedor.nombre);
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

    const producto = catalogo.find((p) => p.sku === sku);
    if (!producto) {
      res.status(404).json({ error: 'not_found', detail: 'SKU no encontrado en el catalogo' });
      return;
    }

    let precios;
    try {
      precios = await proveedor.getPrecios([sku]);
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
      res
        .status(404)
        .json({ error: 'not_found', detail: 'El proveedor no entrego precio para este SKU' });
      return;
    }

    res.status(200).json({
      sku: producto.sku,
      mpn: producto.mpn,
      nombre: producto.nombre,
      marca: producto.marca,
      categoria: producto.categoria,
      subcategorias: producto.subcategorias,
      tipo: producto.tipo,
      precio: precio.price,
      moneda: precio.currency,
      stock: precio.inStock,
    });
  };
}

/**
 * Variante para las rutas /api/{proveedor}/producto: el proveedor no se conoce al
 * construir el handler, sale de la ruta en cada request.
 *
 * La api key se valida antes de resolver el proveedor: un cliente sin
 * autenticar no debe poder enumerar que proveedores existen probando nombres.
 */
export function crearHandlerProductoPorRuta(): Handler {
  return async function handler(req, res) {
    if (req.method && req.method !== 'GET') {
      res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
      res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
      return;
    }

    const proveedor = resolverOResponder(firstString(req.query.proveedor), res);
    if (!proveedor) return;

    await crearHandlerProducto(proveedor)(req, res);
  };
}
