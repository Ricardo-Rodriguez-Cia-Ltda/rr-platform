import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../auth.js';
import {
  unavailableCatalogs,
  skuKey,
  compareByKey,
  hasAnyCatalog,
  resolveKeys,
  type MissingProvider,
} from '@rr/providers/comparator';
import { resolveOrRespond } from './guards.js';
import { firstString, type Handler } from './types.js';

/** La marca que sigue al separador de la clave de union. */
function brandFromKey(clave: string): string {
  return clave.split('|')[1] ?? clave;
}

// Clasificacion exhaustiva: cada causa de MissingProvider['error'] tiene
// que aparecer aca. Si se agrega una causa nueva sin clasificarla,
// TypeScript rompe la compilacion en vez de dejarla caer en "permanente"
// por defecto -el lado peligroso: una falla transitoria nueva quedaria
// marcada como definitiva y el agente dejaria de reintentar algo que si
// conviene.
const ES_TRANSITORIA: Record<MissingProvider['error'], boolean> = {
  catalogo_no_disponible: true,
  upstream: true,
  sin_precio: false,
  proveedor_no_configurado: false,
};

function esTransitoria(p: MissingProvider): boolean {
  return ES_TRANSITORIA[p.error];
}

export function createBestPriceHandler(): Handler {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method && req.method !== 'GET') {
      res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
      res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
      return;
    }

    const mpn = firstString(req.query.mpn)?.trim();
    const providerName = firstString(req.query.proveedor)?.trim();
    const sku = firstString(req.query.sku)?.trim();
    const marca = firstString(req.query.marca)?.trim();

    const byMpn = Boolean(mpn);
    const bySku = Boolean(providerName || sku);
    if (byMpn === bySku) {
      res.status(400).json({
        error: 'bad_request',
        detail: 'Indica mpn, o bien el par proveedor y sku. Uno de los dos, no ambos.',
      });
      return;
    }
    if (bySku && !(providerName && sku)) {
      res.status(400).json({
        error: 'bad_request',
        detail: 'Para buscar por sku hay que indicar tambien el proveedor',
      });
      return;
    }

    let clave: string;

    if (byMpn) {
      const keys = resolveKeys(mpn!, marca);

      // Elegir una marca por el consumidor es cotizarle un producto que no
      // pidio; se le pide que acote, igual que /search con demasiado_amplio.
      if (keys.length > 1) {
        res.status(409).json({
          error: 'ambiguo',
          detail: `El MPN ${mpn} existe bajo ${keys.length} marcas. Repite la consulta con &marca=`,
          marcas: keys.map(brandFromKey),
        });
        return;
      }
      if (keys.length === 0) {
        if (!hasAnyCatalog()) {
          res.status(503).json({
            error: 'catalogo_no_disponible',
            detail: 'Ningun catalogo esta disponible todavia. Reintenta mas tarde.',
          });
          return;
        }
        // resolveKeys salta en silencio los catalogos sin cargar: sin
        // esto, un proveedor caido haria que la respuesta afirme "nadie lo
        // vende" para un producto que ese proveedor si tiene.
        res.status(404).json({
          error: 'not_found',
          detail: `Ningun proveedor tiene el MPN ${mpn}`,
          incompleta: unavailableCatalogs(),
        });
        return;
      }
      clave = keys[0];
    } else {
      const provider = resolveOrRespond(providerName, res);
      if (!provider) return;

      const resolution = skuKey(provider.name, sku!);

      if (resolution.estado === 'catalogo_no_disponible') {
        res.status(503).json({
          error: 'catalogo_no_disponible',
          detail: `El catalogo de '${provider.name}' aun no esta disponible. Reintenta mas tarde.`,
        });
        return;
      }
      if (resolution.estado === 'sku_desconocido') {
        res.status(404).json({
          error: 'not_found',
          detail: `'${provider.name}' no tiene el SKU ${sku}`,
        });
        return;
      }
      if (resolution.estado === 'no_comparable') {
        res.status(409).json({
          error: 'no_comparable',
          detail:
            'El producto no tiene MPN y marca, asi que no se puede comparar con otros proveedores',
        });
        return;
      }
      clave = resolution.clave;
    }

    const comparison = await compareByKey(clave);

    if (!comparison.mejor) {
      // La clave se resolvio -algun proveedor tiene el producto en
      // catalogo-, pero eso no alcanza para responder 502: sin_precio (el
      // precio 0 de H1 cae aca) y proveedor_no_configurado son estados
      // permanentes, no fallas de un momento. Solo si hay al menos una causa
      // transitoria (cuota, un 500 puntual, catalogo aun sin cargar) vale la
      // pena reintentar.
      if (comparison.incompleta.some(esTransitoria)) {
        res.status(502).json({
          error: 'upstream',
          detail: 'No se pudo cotizar con ningun proveedor',
          incompleta: comparison.incompleta,
        });
        return;
      }
      // Sin ofertas y sin ninguna causa transitoria es definitivo: o se
      // revisaron todos los catalogos y ninguno lo vende, o los que lo
      // tienen no le asignan precio.
      res.status(404).json({
        error: 'not_found',
        detail: 'Ningun proveedor entrego precio para este producto',
        incompleta: comparison.incompleta,
      });
      return;
    }

    res.status(200).json({
      clave: comparison.clave,
      mpn: comparison.mpn,
      marca: comparison.marca,
      nombre: comparison.nombre,
      mejor: comparison.mejor,
      ofertas: comparison.ofertas,
      incompleta: comparison.incompleta,
    });
  };
}
