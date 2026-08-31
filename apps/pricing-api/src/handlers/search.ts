import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '@rr/http/auth';
import { CatalogUnavailableError, getCatalog } from '@rr/providers/catalog';
import { search, computeFacets, tokenize } from '@rr/domain/search';
import type { Provider } from '@rr/domain/types';
import { ProviderError } from '@rr/domain/types';
import { resolveOrRespond } from './guards.js';
import { firstString, type Handler } from './types.js';

const UMBRAL_AMBIGUEDAD = 25;
const LIMITE_POR_DEFECTO = 10;
// Sin filtros, el orden por relevancia ya deja arriba lo que sirve: un lote basta.
const MAX_CANDIDATOS_SIN_FILTROS = 50;
// Con filtros hay que buscar mas abajo: precio y stock solo se conocen al
// cotizar, y en el catalogo real apenas el 27% de los productos tiene stock.
const MAX_CANDIDATOS_CON_FILTROS = 300;
// Techo de reloj, ademas del techo de candidatos. Recorrer los 300 son ~6 viajes
// al mayorista: cuando ninguno pasa el filtro se recorren todos y la respuesta
// tarda ~18s. Quien llama es un agente dentro de una conversacion de WhatsApp,
// que se cae mucho antes de eso — el 2026-08-31 un cliente recibio "esta
// fallando el sistema" por esta espera. Vale mas responder a tiempo diciendo
// que la busqueda quedo a medias que responder tarde y perfecto.
const PRESUPUESTO_MS = 8000;

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

function cheapest(productos: Cotizado[]): Cotizado {
  return productos.reduce((a, b) => (b.precio < a.precio ? b : a));
}

// La alternativa tiene que ser del mismo tipo de producto que se busco. Entre
// los candidatos de "notebook" se cuelan accesorios que calzan por texto (una
// mochila "Notebook carrying backpack"), y como un accesorio es casi siempre lo
// mas barato, `cheapest` a secas ofrecia una mochila a quien pidio un notebook
// — paso en produccion el 2026-08-31, tres veces en una conversacion. Se toma
// la categoria dominante entre los candidatos y se elige el mas barato de ella.
function alternativeFrom(productos: Cotizado[]): Cotizado {
  const porCategoria = new Map<string | null, number>();
  for (const p of productos) porCategoria.set(p.categoria, (porCategoria.get(p.categoria) ?? 0) + 1);
  let dominante: string | null = null;
  let mayor = -1;
  for (const [cat, n] of porCategoria) {
    if (n > mayor) {
      mayor = n;
      dominante = cat;
    }
  }
  return cheapest(productos.filter((p) => p.categoria === dominante));
}

function explainEmpty(
  evaluados: Cotizado[],
  onlyWithStock: boolean,
  truncado: boolean,
): { motivo: string; alternativa: Cotizado } {
  const withStock = evaluados.filter((p) => (p.stock ?? 0) > 0);

  // Si la busqueda se corto por tiempo, no se recorrieron todos los candidatos:
  // decir "sin_stock" afirmaria algo que no se comprobo. El consumidor tiene
  // que poder distinguir "mire todo y no hay" de "no alcance a mirar todo".
  if (truncado) {
    return { motivo: 'busqueda_incompleta', alternativa: alternativeFrom(withStock.length > 0 ? withStock : evaluados) };
  }
  if (onlyWithStock && withStock.length === 0) {
    return { motivo: 'sin_stock', alternativa: alternativeFrom(evaluados) };
  }
  return {
    motivo: 'sobre_presupuesto',
    alternativa: alternativeFrom(withStock.length > 0 ? withStock : evaluados),
  };
}

export function createSearchHandler(provider: Provider): Handler {
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
    if (tokenize(q).length === 0) {
      res.status(400).json({ error: 'bad_request', detail: 'q no contiene terminos buscables' });
      return;
    }

    const marca = firstString(req.query.marca);
    const categoria = firstString(req.query.categoria);
    const onlyWithStock = firstString(req.query.solo_con_stock) === 'true';

    const rawMaxPrice = firstString(req.query.precio_max);
    let maxPrice = Number.POSITIVE_INFINITY;
    if (rawMaxPrice !== undefined && rawMaxPrice.trim() !== '') {
      const n = Number(rawMaxPrice);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({
          error: 'bad_request',
          detail: 'precio_max debe ser un numero mayor a 0',
        });
        return;
      }
      maxPrice = n;
    }

    const rawLimit = firstString(req.query.limite);
    let limit = LIMITE_POR_DEFECTO;
    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 0) {
        res.status(400).json({
          error: 'bad_request',
          detail: 'limite debe ser un entero mayor o igual a 0',
        });
        return;
      }
      limit = n;
    }

    let catalog;
    try {
      catalog = getCatalog(provider.name);
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

    const matches = search(catalog, { q, marca, categoria });
    const matchedProducts = matches.map((r) => r.product);
    const facetas = computeFacets(matchedProducts);

    if (matches.length > UMBRAL_AMBIGUEDAD && !marca && !categoria) {
      res.status(409).json({
        error: 'demasiado_amplio',
        detail: `${matches.length} coincidencias. Acota con marca o categoria.`,
        total: matches.length,
        facetas,
      });
      return;
    }

    const hasFilters = onlyWithStock || Number.isFinite(maxPrice);
    const maxCandidates = hasFilters ? MAX_CANDIDATOS_CON_FILTROS : MAX_CANDIDATOS_SIN_FILTROS;
    const candidates = matchedProducts.slice(0, maxCandidates);

    const productos: Cotizado[] = [];
    const evaluados: Cotizado[] = [];

    // Se cotiza por lotes y se corta apenas se junta el limite pedido: sin
    // filtros esto es un solo lote, igual que antes.
    const inicio = Date.now();
    let truncadoPorTiempo = false;
    let ultimoLoteMs = 0;

    for (let i = 0; i < candidates.length && productos.length < limit; i += provider.maxSkusPerBatch) {
      // No basta con mirar el tiempo ya gastado: un lote solo puede costar varios
      // segundos, asi que preguntar "¿me pase?" despues de empezarlo llega tarde.
      // Se proyecta con lo que costo el anterior y no se empieza un lote que no
      // se alcanza a pagar. El primero siempre corre: cortar antes devolveria
      // cero evaluados y no habria nada que explicarle a nadie.
      if (i > 0 && Date.now() - inicio + ultimoLoteMs > PRESUPUESTO_MS) {
        truncadoPorTiempo = true;
        break;
      }
      const inicioLote = Date.now();
      const batch = candidates.slice(i, i + provider.maxSkusPerBatch);

      let prices;
      try {
        prices = await provider.getPrices(batch.map((p) => p.sku));
      } catch (error) {
        if (error instanceof ProviderError) {
          console.error('[search] fallo getPrices', { candidatos: batch.length, error });
          res.status(502).json({ error: 'upstream', detail: error.message, upstream: error.detail });
          return;
        }
        console.error('[search] fallo getPrices', { candidatos: batch.length, error });
        res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
        return;
      }

      ultimoLoteMs = Date.now() - inicioLote;

      for (const p of batch) {
        const price = prices.get(p.sku);
        if (!price) continue;

        const quote: Cotizado = {
          sku: p.sku,
          mpn: p.mpn,
          nombre: p.nombre,
          marca: p.marca,
          categoria: p.categoria,
          precio: price.price,
          moneda: price.currency,
          stock: price.inStock,
        };
        evaluados.push(quote);

        if (quote.precio > maxPrice) continue;
        if (onlyWithStock && (quote.stock ?? 0) <= 0) continue;
        if (productos.length < limit) productos.push(quote);
      }
    }

    const returnedPrices = productos.map((p) => p.precio);
    const facetsWithPrice =
      returnedPrices.length > 0
        ? { ...facetas, precio: { min: Math.min(...returnedPrices), max: Math.max(...returnedPrices) } }
        : facetas;

    res.status(200).json({
      total: matches.length,
      evaluados: evaluados.length,
      // La busqueda se corto por tiempo y quedaron candidatos sin cotizar. No es
      // un error: es una respuesta parcial, y quien la recibe tiene que saberlo
      // para no afirmar que reviso todo.
      ...(truncadoPorTiempo ? { parcial: true } : {}),
      productos,
      facetas: facetsWithPrice,
      // Vacio con candidatos cotizados no es lo mismo que "no existe": hay que
      // decir por que fallo y ofrecer lo mas cercano, o el consumidor reintenta
      // la misma busqueda con otras palabras creyendo que fue un error tecnico.
      ...(productos.length === 0 && evaluados.length > 0
        ? { sin_resultados: explainEmpty(evaluados, onlyWithStock, truncadoPorTiempo) }
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
export function createSearchByRouteHandler(): Handler {
  return async function handler(req, res) {
    if (req.method && req.method !== 'GET') {
      res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
      res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
      return;
    }

    const provider = resolveOrRespond(firstString(req.query.proveedor), res);
    if (!provider) return;

    await createSearchHandler(provider)(req, res);
  };
}
