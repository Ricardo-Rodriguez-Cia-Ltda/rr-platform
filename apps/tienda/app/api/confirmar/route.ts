import { invocarFunction } from '../../../src/lib/kapso.js';
import { armarPayloadCotizacion, armarPayloadEmision, validarPedido } from '../../../src/lib/pedido.js';
import { permitir } from '../../../src/lib/rate-limit.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

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
  const quote = (cotizacion.data as { quote?: { quote_id?: string; total_clp?: number } }).quote;
  if (cotizacion.status !== 200 || !quote?.quote_id) {
    const mensaje = String((cotizacion.data as { mensaje?: string }).mensaje ?? 'Un producto ya no está disponible.');
    return json({ error: mensaje }, 422);
  }

  // 2) El cliente confirmo un total: si el vivo difiere, se le muestra ANTES
  // de emitir nada. La cotizacion recien creada queda huerfana en Supabase —
  // inocua: las cotizaciones son inmutables y sin pedido asociado.
  const totalClp = Number(quote.total_clp ?? 0);
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
    // La cotizacion existe pero la emision no corrio: el pedido NO quedo
    // registrado. Honesto: pedir reintento (la idempotencia de emitir
    // absorbe cualquier duplicado).
    return json({ error: 'No pudimos registrar el pedido. Intenta de nuevo en un momento.' }, 503);
  }
  const ok = (emision.data as { ok?: boolean }).ok === true;
  if (!ok) return json({ error: 'No pudimos registrar el pedido. Intenta de nuevo.' }, 503);

  const purchaseOk = (emision.data as { vars?: { purchase_orders_ok?: boolean } }).vars?.purchase_orders_ok === true;
  return json({ ok: true, quoteId: quote.quote_id, totalClp, ...(purchaseOk ? {} : { avisoOc: true }) });
}
