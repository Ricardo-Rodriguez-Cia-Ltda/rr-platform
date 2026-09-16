import { invocarFunction } from '../../../src/lib/kapso.js';
import { armarCuerpoCrearPago, armarPayloadCotizacion, validarPedido } from '../../../src/lib/pedido.js';
import { crearPago } from '../../../src/lib/relay.js';
import { permitir } from '../../../src/lib/rate-limit.js';

// Esta ruta cotiza en vivo en Kapso (30s de timeout propio) y despues le pide
// el link de pago al rele (15s), en serie: el techo tiene que dar para los dos
// en el peor caso. Va como segment config de Next y no en vercel.json — en
// App Router las functions las emite el framework, y un glob que no calza
// rompe el build.
export const maxDuration = 60;

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// Desde que la tienda cobra, un fallo despues de cotizar SI se puede
// reintentar: nada se emite hasta que Mercado Pago aprueba, y una cotizacion
// huerfana con su fila `pendiente` en `pagos` vence sola.
const MENSAJE_SIN_LINK = 'No pudimos generar el link de pago. Intenta de nuevo.';
const MENSAJE_SIN_VIGENCIA = 'Los precios de tu cotización cambiaron. Vuelve a confirmar el pedido.';

interface LineaQuote { abastecimiento?: string }
interface Quote { quote_id?: string; quote_version?: string | number; total_clp?: number; lineas?: LineaQuote[] }

export async function POST(req: Request): Promise<Response> {
  const ip = (req.headers.get('x-forwarded-for') ?? 'sin-ip').split(',')[0].trim();

  const body = await req.json().catch(() => null);
  const pedido = validarPedido(body);
  if ('error' in pedido) return json({ error: pedido.error }, 400);

  // El cupo se gasta solo cuando el pedido ya paso validacion y va a
  // disparar trabajo real contra Kapso: un 400 de validacion no cuesta cupo.
  if (!permitir(ip, Date.now())) {
    return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429);
  }

  // 1) Recotizar en vivo: el precio del carro es indicativo; la verdad la
  // pone generar-cotizacion-v2 (mismo motor que el bot). NUNCA se acepta una
  // quote del navegador — seria adulterable.
  const cotizacion = await invocarFunction(
    'generar-cotizacion-v2',
    armarPayloadCotizacion(pedido.items, pedido.comprador.telefono),
  );
  if (cotizacion === null) return json({ error: 'No pudimos procesar tu pedido. Intenta de nuevo.' }, 503);
  if (cotizacion.status >= 500) {
    return json({ error: 'No pudimos procesar tu pedido. Intenta de nuevo.' }, 503);
  }
  const quote = (cotizacion.data as { quote?: Quote }).quote;
  if (cotizacion.status !== 200 || !quote?.quote_id) {
    const mensaje = String((cotizacion.data as { mensaje?: string }).mensaje ?? 'Un producto ya no está disponible.');
    return json({ error: mensaje }, 422);
  }

  // 2) El cliente confirmo un total: si el vivo difiere, se le muestra ANTES
  // de cobrar nada. La cotizacion recien creada queda huerfana en Supabase —
  // inocua: las cotizaciones son inmutables y sin pedido asociado.
  const totalClp = Number(quote.total_clp ?? 0);
  // Un total no numerico o en 0 no se compara: si el cliente mandara
  // totalConfirmadoClp 0, la igualdad pasaria y cobrariamos un pedido que no
  // vale nada.
  if (!Number.isFinite(totalClp) || totalClp <= 0) {
    return json({ error: 'No pudimos cotizar tu pedido. Escríbenos por WhatsApp y lo vemos.' }, 422);
  }
  if (totalClp !== pedido.totalConfirmadoClp) {
    return json({ recotizado: true, totalClp, totalAnteriorClp: pedido.totalConfirmadoClp }, 409);
  }

  // 3) Crear el pago en el rele. La emision de las ordenes de compra ya no
  // ocurre aca: la hace el webhook del rele cuando Mercado Pago aprueba, por
  // el mismo camino que el bot. Lo que vuelve es el link al que hay que
  // mandar al cliente.
  const pago = await crearPago(armarCuerpoCrearPago(
    { quote_id: quote.quote_id, quote_version: quote.quote_version },
    pedido.comprador,
    pedido.facturacion,
  ));
  if (pago === null) return json({ error: MENSAJE_SIN_LINK }, 503);
  // 409 = sin_vigencia: la cotizacion nacio con menos de 15 minutos. No
  // deberia pasar (tiene segundos de vida), pero si pasa, recotizar es la
  // salida correcta y el cliente la conoce.
  if (pago.status === 409) return json({ error: MENSAJE_SIN_VIGENCIA }, 422);
  // Cualquier otro fallo (401 por nuestra configuracion, 5xx del rele o de
  // Mercado Pago) es nuestro, no del cliente: mensaje generico, sin filtrar
  // el codigo interno.
  if (pago.status !== 200) return json({ error: MENSAJE_SIN_LINK }, 503);
  const initPoint = String(pago.data.init_point ?? '');
  if (!initPoint) return json({ error: MENSAJE_SIN_LINK }, 503);

  // Honestidad del abastecimiento: si alguna linea no sale de stock inmediato,
  // el plazo de entrega no es el de siempre y el cliente tiene que saberlo
  // antes de pagar.
  const lineas = quote.lineas ?? [];
  const porEncargo = lineas.some((l) => l?.abastecimiento !== 'stock_inmediato');
  return json({
    ok: true,
    quoteId: quote.quote_id,
    totalClp,
    initPoint,
    ...(porEncargo ? { avisoAbastecimiento: true } : {}),
  });
}
