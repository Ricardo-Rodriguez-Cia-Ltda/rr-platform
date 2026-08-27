import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../auth.js';
import {
  catalogosNoDisponibles,
  claveDeSku,
  compararPorClave,
  hayAlgunCatalogo,
  resolverClaves,
  type ProveedorAusente,
} from '@rr/providers/comparator';
import { resolverOResponder } from './guards.js';
import { firstString, type Handler } from './types.js';

/** La marca que sigue al separador de la clave de union. */
function marcaDeClave(clave: string): string {
  return clave.split('|')[1] ?? clave;
}

// Clasificacion exhaustiva: cada causa de ProveedorAusente['error'] tiene
// que aparecer aca. Si se agrega una causa nueva sin clasificarla,
// TypeScript rompe la compilacion en vez de dejarla caer en "permanente"
// por defecto -el lado peligroso: una falla transitoria nueva quedaria
// marcada como definitiva y el agente dejaria de reintentar algo que si
// conviene.
const ES_TRANSITORIA: Record<ProveedorAusente['error'], boolean> = {
  catalogo_no_disponible: true,
  upstream: true,
  sin_precio: false,
  proveedor_no_configurado: false,
};

function esTransitoria(p: ProveedorAusente): boolean {
  return ES_TRANSITORIA[p.error];
}

export function crearHandlerMejorPrecio(): Handler {
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
    const nombreProveedor = firstString(req.query.proveedor)?.trim();
    const sku = firstString(req.query.sku)?.trim();
    const marca = firstString(req.query.marca)?.trim();

    const porMpn = Boolean(mpn);
    const porSku = Boolean(nombreProveedor || sku);
    if (porMpn === porSku) {
      res.status(400).json({
        error: 'bad_request',
        detail: 'Indica mpn, o bien el par proveedor y sku. Uno de los dos, no ambos.',
      });
      return;
    }
    if (porSku && !(nombreProveedor && sku)) {
      res.status(400).json({
        error: 'bad_request',
        detail: 'Para buscar por sku hay que indicar tambien el proveedor',
      });
      return;
    }

    let clave: string;

    if (porMpn) {
      const claves = resolverClaves(mpn!, marca);

      // Elegir una marca por el consumidor es cotizarle un producto que no
      // pidio; se le pide que acote, igual que /search con demasiado_amplio.
      if (claves.length > 1) {
        res.status(409).json({
          error: 'ambiguo',
          detail: `El MPN ${mpn} existe bajo ${claves.length} marcas. Repite la consulta con &marca=`,
          marcas: claves.map(marcaDeClave),
        });
        return;
      }
      if (claves.length === 0) {
        if (!hayAlgunCatalogo()) {
          res.status(503).json({
            error: 'catalogo_no_disponible',
            detail: 'Ningun catalogo esta disponible todavia. Reintenta mas tarde.',
          });
          return;
        }
        // resolverClaves salta en silencio los catalogos sin cargar: sin
        // esto, un proveedor caido haria que la respuesta afirme "nadie lo
        // vende" para un producto que ese proveedor si tiene.
        res.status(404).json({
          error: 'not_found',
          detail: `Ningun proveedor tiene el MPN ${mpn}`,
          incompleta: catalogosNoDisponibles(),
        });
        return;
      }
      clave = claves[0];
    } else {
      const proveedor = resolverOResponder(nombreProveedor, res);
      if (!proveedor) return;

      const resolucion = claveDeSku(proveedor.nombre, sku!);

      if (resolucion.estado === 'catalogo_no_disponible') {
        res.status(503).json({
          error: 'catalogo_no_disponible',
          detail: `El catalogo de '${proveedor.nombre}' aun no esta disponible. Reintenta mas tarde.`,
        });
        return;
      }
      if (resolucion.estado === 'sku_desconocido') {
        res.status(404).json({
          error: 'not_found',
          detail: `'${proveedor.nombre}' no tiene el SKU ${sku}`,
        });
        return;
      }
      if (resolucion.estado === 'no_comparable') {
        res.status(409).json({
          error: 'no_comparable',
          detail:
            'El producto no tiene MPN y marca, asi que no se puede comparar con otros proveedores',
        });
        return;
      }
      clave = resolucion.clave;
    }

    const comparacion = await compararPorClave(clave);

    if (!comparacion.mejor) {
      // La clave se resolvio -algun proveedor tiene el producto en
      // catalogo-, pero eso no alcanza para responder 502: sin_precio (el
      // precio 0 de H1 cae aca) y proveedor_no_configurado son estados
      // permanentes, no fallas de un momento. Solo si hay al menos una causa
      // transitoria (cuota, un 500 puntual, catalogo aun sin cargar) vale la
      // pena reintentar.
      if (comparacion.incompleta.some(esTransitoria)) {
        res.status(502).json({
          error: 'upstream',
          detail: 'No se pudo cotizar con ningun proveedor',
          incompleta: comparacion.incompleta,
        });
        return;
      }
      // Sin ofertas y sin ninguna causa transitoria es definitivo: o se
      // revisaron todos los catalogos y ninguno lo vende, o los que lo
      // tienen no le asignan precio.
      res.status(404).json({
        error: 'not_found',
        detail: 'Ningun proveedor entrego precio para este producto',
        incompleta: comparacion.incompleta,
      });
      return;
    }

    res.status(200).json({
      clave: comparacion.clave,
      mpn: comparacion.mpn,
      marca: comparacion.marca,
      nombre: comparacion.nombre,
      mejor: comparacion.mejor,
      ofertas: comparacion.ofertas,
      incompleta: comparacion.incompleta,
    });
  };
}
