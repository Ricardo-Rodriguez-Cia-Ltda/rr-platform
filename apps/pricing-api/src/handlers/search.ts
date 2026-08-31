import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '@rr/http/auth';
import { CatalogUnavailableError, getCatalog } from '@rr/providers/catalog';
import { getPriceCache, type CachedPrice } from '@rr/providers/price-cache';
import { search, computeFacets, tokenize } from '@rr/domain/search';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo, Provider } from '@rr/domain/types';
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
// Techo de reloj, ademas del techo de candidatos. Quien llama es un agente en
// una conversacion de WhatsApp: el usuario acepto explicitamente ~10-15s si la
// respuesta trae productos, pero no una espera abierta. Como el resto de los
// lotes va en una ronda paralela que dura ~lo que un lote, el presupuesto se
// gasta como maximo en sonda + ronda (~2 lotes). Si solo la sonda ya proyecta
// pasarse (lote > mitad del presupuesto), no se lanza la ronda y la respuesta
// sale `parcial` — eso paso el 2026-08-31 con el mayorista a ~7s por lote.
const PRESUPUESTO_MS = 20000;

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

    const procesar = (batch: NormalizedProduct[], prices: Map<string, PriceInfo>): void => {
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
    };

    // La busqueda conversa sobre el cache de precios antes de cotizar en vivo:
    // lo fresco se usa siempre, sin tocar al proveedor. La cotizacion (mejor
    // precio) jamas pasa por aca.
    const cache = getPriceCache(provider.name);
    const lookup = cache.get(candidates.map((p) => p.sku));
    let maxAgeMs = 0;

    const desdeCache = (p: NormalizedProduct, entry: CachedPrice): void => {
      maxAgeMs = Math.max(maxAgeMs, Date.now() - entry.quotedAt);
      if (entry.info) procesar([p], new Map([[p.sku, entry.info]]));
      // info null = negativo cacheado: ni evaluado ni cotizable, igual que un
      // SKU que la API viva no devuelve.
    };

    // Los frescos se resuelven ya, en el orden del ranking; los pendientes
    // pasan a sonda + ronda. Recorrer `candidates` en orden (en vez de
    // separar fresco/vivo y concatenar) es lo que mantiene `productos`
    // ordenado por relevancia dentro de la misma respuesta.
    const pendientes: NormalizedProduct[] = [];
    for (const p of candidates) {
      const entry = lookup.fresh.get(p.sku);
      if (entry) desdeCache(p, entry);
      else pendientes.push(p);
    }

    // Fallback compartido por sonda y ronda: un lote vivo caido se rescata del
    // cache utilizable (mas viejo que fresco, pero todavia servible). Lo que
    // ni ahi tiene entrada queda sin cotizar.
    const rescatar = (batch: NormalizedProduct[]): void => {
      let sinResolver = 0;
      for (const p of batch) {
        const entry = lookup.usable.get(p.sku);
        if (entry) desdeCache(p, entry);
        else sinResolver++;
      }
      if (sinResolver > 0) truncadoPorTiempo = true;
    };

    // El primer lote va solo, como sonda: en el caso comun (sin filtros, o con
    // stock arriba del ranking) basta y no se cotiza de mas. Si no basta, el
    // resto de los candidatos se cotiza EN PARALELO en una sola ronda: con el
    // mayorista lento (~7s por lote), tres lotes en fila son ~20s y la
    // conversacion de WhatsApp no aguanta; en paralelo el total es ~2 lotes de
    // reloj. Se pidio explicito: mejor demorar ~10s y responder con productos,
    // que responder rapido diciendo que no se alcanzo a revisar.
    const inicio = Date.now();
    let truncadoPorTiempo = false;

    // Si el cache fresco ya junto el limite pedido, no hay nada que cotizar en
    // vivo: ni la sonda se lanza. Esto es lo que hace que una busqueda
    // identica repetida no vuelva a llamar al proveedor. Excepcion: con
    // limite=0, `productos.length < limit` nunca es cierto (0 < 0 es falso),
    // asi que sin este OR la sonda jamas correria y `evaluados`/`sin_resultados`
    // perderian los datos que el comportamiento pre-cache siempre entregaba
    // (la sonda ahi era incondicional). limit === 0 restaura ese caso puntual;
    // la ronda no se toca, sigue gateada solo por `productos.length < limit`
    // (con limite=0 nunca corria y sigue sin correr).
    if (pendientes.length > 0 && (productos.length < limit || limit === 0)) {
      const first = pendientes.slice(0, provider.maxSkusPerBatch);
      let firstPrices: Map<string, PriceInfo>;
      try {
        firstPrices = await provider.getPrices(first.map((p) => p.sku));
        cache.put(firstPrices, first.map((p) => p.sku));
      } catch (error) {
        console.error('[search] fallo getPrices', { candidatos: first.length, error });
        // El cache no resolvio esto antes de la sonda (era pendiente), pero
        // puede haber algo utilizable (mas viejo que fresco). Solo si el
        // cache no aporta absolutamente nada — ni fresco ni utilizable — el
        // 502 de siempre sigue siendo la respuesta honesta.
        rescatar(first);
        if (evaluados.length === 0 && productos.length === 0) {
          if (error instanceof ProviderError) {
            res.status(502).json({ error: 'upstream', detail: error.message, upstream: error.detail });
          } else {
            res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
          }
          return;
        }
        firstPrices = new Map<string, PriceInfo>();
      }
      const primerLoteMs = Date.now() - inicio;
      procesar(first, firstPrices);

      if (productos.length < limit && pendientes.length > first.length) {
        // La ronda paralela dura ~lo que un lote. Si con lo que costo el primero
        // ni siquiera eso cabe en el presupuesto, no se lanza: cotizar a medias
        // ya esta cubierto por `parcial` y el cliente no espera indefinidamente.
        if (primerLoteMs * 2 > PRESUPUESTO_MS) {
          truncadoPorTiempo = true;
        } else {
          const restantes: NormalizedProduct[][] = [];
          for (let i = first.length; i < pendientes.length; i += provider.maxSkusPerBatch) {
            restantes.push(pendientes.slice(i, i + provider.maxSkusPerBatch));
          }

          const resultados = await Promise.allSettled(
            restantes.map((batch) => provider.getPrices(batch.map((p) => p.sku))),
          );

          // Los lotes se procesan en el orden del ranking aunque hayan vuelto en
          // otro orden, para que `productos` conserve la relevancia. Un lote que
          // fallo se rescata del cache utilizable en vez de tumbar la respuesta;
          // lo que ni ahi tiene entrada queda sin cotizar y eso se declara como
          // parcial, igual que un corte por tiempo.
          for (let i = 0; i < restantes.length; i++) {
            const r = resultados[i];
            if (r.status === 'fulfilled') {
              cache.put(r.value, restantes[i].map((p) => p.sku));
              procesar(restantes[i], r.value);
            } else {
              console.error('[search] fallo getPrices en ronda paralela', { candidatos: restantes[i].length, error: r.reason });
              rescatar(restantes[i]);
            }
          }
        }
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
      // Se declara la edad del dato mas viejo usado, fresco o utilizable, para
      // que quien consume la respuesta sepa que no todo salio en vivo. Ausente
      // cuando la busqueda fue 100% en vivo (nada de cache de por medio).
      ...(maxAgeMs > 0 ? { precios_de_hace_min: Math.ceil(maxAgeMs / 60000) } : {}),
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
