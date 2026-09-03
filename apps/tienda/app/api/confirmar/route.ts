import { invocarFunction } from '../../../src/lib/kapso.js';
import { armarPayloadCotizacion, armarPayloadEmision, validarPedido } from '../../../src/lib/pedido.js';
import { permitir } from '../../../src/lib/rate-limit.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// Mensaje del 503 POSTERIOR a la emision: el pedido pudo haber quedado
// registrado y un reintento emitiria una segunda orden de compra.
const MENSAJE_INCIERTO =
  'Tu pedido pudo haber quedado registrado. No lo reintentes: te contactaremos por WhatsApp para confirmarlo.';

interface LineaQuote { abastecimiento?: string }
interface Quote { quote_id?: string; total_clp?: number; lineas?: LineaQuote[] }

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
  // de emitir nada. La cotizacion recien creada queda huerfana en Supabase —
  // inocua: las cotizaciones son inmutables y sin pedido asociado.
  const totalClp = Number(quote.total_clp ?? 0);
  // Un total no numerico o en 0 no se compara: si el cliente mandara
  // totalConfirmadoClp 0, la igualdad pasaria y emitiriamos un pedido que no
  // vale nada.
  if (!Number.isFinite(totalClp) || totalClp <= 0) {
    return json({ error: 'No pudimos cotizar tu pedido. Escríbenos por WhatsApp y lo vemos.' }, 422);
  }
  if (totalClp !== pedido.totalConfirmadoClp) {
    return json({ recotizado: true, totalClp, totalAnteriorClp: pedido.totalConfirmadoClp }, 409);
  }

  // 3) Emitir: OCs por mayorista, persistencia, backoffice. Un fallo parcial
  // de OC no rebota el pedido (contrato honesto del bot: se declara).
  const emision = await invocarFunction(
    'emitir-ordenes-compra',
    armarPayloadEmision(quote, pedido.comprador, pedido.facturacion, pedido.comprador.telefono),
  );
  if (emision === null || emision.status >= 500) {
    // OJO: la idempotencia D1 de emitir-ordenes-compra NO cubre este flujo.
    // Su order_key se deriva de la quote, y cada POST a /api/confirmar crea
    // una quote NUEVA: reintentar aca no deduplica nada, emite una SEGUNDA
    // orden de compra al mayorista. Y como no sabemos si emitir alcanzo a
    // correr antes de caerse, lo unico honesto es frenar al cliente y
    // resolverlo a mano.
    return json({ error: MENSAJE_INCIERTO, noReintentar: true }, 503);
  }
  const ok = (emision.data as { ok?: boolean }).ok === true;
  if (!ok) return json({ error: MENSAJE_INCIERTO, noReintentar: true }, 503);

  const purchaseOk = (emision.data as { vars?: { purchase_orders_ok?: boolean } }).vars?.purchase_orders_ok === true;
  // Honestidad del abastecimiento: si alguna linea no sale de stock inmediato,
  // el plazo de entrega no es el de siempre y el cliente tiene que saberlo
  // antes de que se lo digamos por WhatsApp.
  const lineas = quote.lineas ?? [];
  const porEncargo = lineas.some((l) => l?.abastecimiento !== 'stock_inmediato');
  return json({
    ok: true,
    quoteId: quote.quote_id,
    totalClp,
    ...(purchaseOk ? {} : { avisoOc: true }),
    ...(porEncargo ? { avisoAbastecimiento: true } : {}),
  });
}
