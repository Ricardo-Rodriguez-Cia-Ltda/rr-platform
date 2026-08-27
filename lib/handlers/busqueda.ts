import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '@rr/providers/catalog';
import { buscar, calcularFacetas, tokenizar } from '@rr/domain/search';
import type { Proveedor } from '@rr/domain/types';
import { ProviderError } from '@rr/domain/types';
import { resolverOResponder } from './guardas.js';
import { firstString, type Handler } from './tipos.js';

const UMBRAL_AMBIGUEDAD = 25;
const LIMITE_POR_DEFECTO = 10;
// Sin filtros, el orden por relevancia ya deja arriba lo que sirve: un lote basta.
const MAX_CANDIDATOS_SIN_FILTROS = 50;
// Con filtros hay que buscar mas abajo: precio y stock solo se conocen al
// cotizar, y en el catalogo real apenas el 27% de los productos tiene stock.
const MAX_CANDIDATOS_CON_FILTROS = 300;

interface Cotizado {
  sku: string;
  mpn: string | null;
  nombre: string | null;
  marca: string | null;
  categoria: string | null;
  precio: number;
  moneda: string;
  stock: number | null;
}

function masBarato(productos: Cotizado[]): Cotizado {
  return productos.reduce((a, b) => (b.precio < a.precio ? b : a));
}

function explicarVacio(
  evaluados: Cotizado[],
  soloConStock: boolean,
): { motivo: string; alternativa: Cotizado } {
  const conStock = evaluados.filter((p) => (p.stock ?? 0) > 0);

  if (soloConStock && conStock.length === 0) {
    return { motivo: 'sin_stock', alternativa: masBarato(evaluados) };
  }
  return {
    motivo: 'sobre_presupuesto',
    alternativa: masBarato(conStock.length > 0 ? conStock : evaluados),
  };
}

export function crearHandlerBusqueda(proveedor: Proveedor): Handler {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
    if (tokenizar(q).length === 0) {
      res.status(400).json({ error: 'bad_request', detail: 'q no contiene terminos buscables' });
      return;
    }

    const marca = firstString(req.query.marca);
    const categoria = firstString(req.query.categoria);
    const soloConStock = firstString(req.query.solo_con_stock) === 'true';

    const precioMaxCrudo = firstString(req.query.precio_max);
    let precioMax = Number.POSITIVE_INFINITY;
    if (precioMaxCrudo !== undefined && precioMaxCrudo.trim() !== '') {
      const n = Number(precioMaxCrudo);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({
          error: 'bad_request',
          detail: 'precio_max debe ser un numero mayor a 0',
        });
        return;
      }
      precioMax = n;
    }

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

    const hayFiltros = soloConStock || Number.isFinite(precioMax);
    const maxCandidatos = hayFiltros ? MAX_CANDIDATOS_CON_FILTROS : MAX_CANDIDATOS_SIN_FILTROS;
    const candidatos = productosCoincidentes.slice(0, maxCandidatos);

    const productos: Cotizado[] = [];
    const evaluados: Cotizado[] = [];

    // Se cotiza por lotes y se corta apenas se junta el limite pedido: sin
    // filtros esto es un solo lote, igual que antes.
    for (let i = 0; i < candidatos.length && productos.length < limite; i += proveedor.maxSkusPorLote) {
      const lote = candidatos.slice(i, i + proveedor.maxSkusPorLote);

      let precios;
      try {
        precios = await proveedor.getPrecios(lote.map((p) => p.sku));
      } catch (error) {
        if (error instanceof ProviderError) {
          console.error('[search] fallo getPrices', { candidatos: lote.length, error });
          res.status(502).json({ error: 'upstream', detail: error.message, upstream: error.detail });
          return;
        }
        console.error('[search] fallo getPrices', { candidatos: lote.length, error });
        res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
        return;
      }

      for (const p of lote) {
        const precio = precios.get(p.sku);
        if (!precio) continue;

        const cotizado: Cotizado = {
          sku: p.sku,
          mpn: p.mpn,
          nombre: p.nombre,
          marca: p.marca,
          categoria: p.categoria,
          precio: precio.price,
          moneda: precio.currency,
          stock: precio.inStock,
        };
        evaluados.push(cotizado);

        if (cotizado.precio > precioMax) continue;
        if (soloConStock && (cotizado.stock ?? 0) <= 0) continue;
        if (productos.length < limite) productos.push(cotizado);
      }
    }

    const preciosDevueltos = productos.map((p) => p.precio);
    const facetasConPrecio =
      preciosDevueltos.length > 0
        ? { ...facetas, precio: { min: Math.min(...preciosDevueltos), max: Math.max(...preciosDevueltos) } }
        : facetas;

    res.status(200).json({
      total: coincidencias.length,
      evaluados: evaluados.length,
      productos,
      facetas: facetasConPrecio,
      // Vacio con candidatos cotizados no es lo mismo que "no existe": hay que
      // decir por que fallo y ofrecer lo mas cercano, o el consumidor reintenta
      // la misma busqueda con otras palabras creyendo que fue un error tecnico.
      ...(productos.length === 0 && evaluados.length > 0
        ? { sin_resultados: explicarVacio(evaluados, soloConStock) }
        : {}),
    });
  };
}

/**
 * Variante para las rutas /api/{proveedor}/busqueda: el proveedor no se conoce al
 * construir el handler, sale de la ruta en cada request.
 *
 * La api key se valida antes de resolver el proveedor: un cliente sin
 * autenticar no debe poder enumerar que proveedores existen probando nombres.
 */
export function crearHandlerBusquedaPorRuta(): Handler {
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

    await crearHandlerBusqueda(proveedor)(req, res);
  };
}
