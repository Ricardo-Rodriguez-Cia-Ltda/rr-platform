const API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 10000;

// El link de pago muere 15 minutos antes que la cotizacion, para que un pago
// iniciado justo antes del cierre alcance a completarse dentro de la vigencia:
// emitir-ordenes-compra rechaza con 409 cualquier cotizacion vencida.
export const MARGEN_VIGENCIA_MS = 15 * 60 * 1000;

export interface DatosPreferencia {
  quoteId: string;
  numero: number | null;
  montoClp: number;
  nombre: string;
  email: string;
  baseUrl: string;
  validUntil: string;
  // A donde vuelve el cliente al salir del checkout. El bot no la manda y cae
  // a la pagina "vuelve a WhatsApp" del rele; la tienda manda su pagina del
  // pedido. El webhook NO depende de esto: siempre es el nuestro.
  retornoUrl?: string;
}

export interface PagoMP {
  id: number | string;
  status: string;
  status_detail?: string;
  external_reference?: string;
  transaction_amount?: number;
}

// Solo registra etapa y tipo de fallo. Nunca el cuerpo ni el token.
function registrar(etapa: string, detalle: string): void {
  console.error(`[pago] ${etapa} fallo`, { detalle });
}

function tipoDeFallo(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.name;
  return 'desconocido';
}

export function construirPreferencia(p: DatosPreferencia): Record<string, unknown> {
  const base = p.baseUrl.replace(/\/+$/, '');
  const retorno = p.retornoUrl ?? `${base}/api/pago/retorno`;
  return {
    items: [{
      id: p.quoteId,
      title: p.numero != null ? `Pedido N° ${p.numero}` : 'Pedido',
      quantity: 1,
      unit_price: p.montoClp,
      currency_id: 'CLP',
    }],
    payer: { name: p.nombre, email: p.email },
    // La llave con que el webhook encuentra la fila de `pagos`.
    external_reference: p.quoteId,
    notification_url: `${base}/api/pago/webhook`,
    back_urls: { success: retorno, failure: retorno, pending: retorno },
    auto_return: 'approved',
    expires: true,
    expiration_date_to: new Date(Date.parse(p.validUntil) - MARGEN_VIGENCIA_MS).toISOString(),
    // Efectivo y cajero quedan `pending` por dias: dejarian pedidos en limbo
    // con la cotizacion vencida hace rato. Las cuotas se dejan como vengan
    // por defecto (fuera de alcance de esta fase).
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
  };
}

export async function crearPreferencia(
  cuerpo: unknown,
  token: string,
  quoteId: string,
): Promise<{ id: string; init_point: string } | null> {
  try {
    const r = await fetch(`${API}/checkout/preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Un reintento por la misma cotizacion no crea una segunda preferencia.
        'X-Idempotency-Key': quoteId,
      },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      registrar('crear-preferencia', `status ${r.status}`);
      return null;
    }
    const data = (await r.json().catch(() => ({}))) as { id?: string; init_point?: string };
    if (!data.id || !data.init_point) {
      registrar('crear-preferencia', 'respuesta sin id o init_point');
      return null;
    }
    return { id: String(data.id), init_point: String(data.init_point) };
  } catch (error) {
    registrar('crear-preferencia', tipoDeFallo(error));
    return null;
  }
}

export async function consultarPago(paymentId: string, token: string): Promise<PagoMP | null> {
  try {
    const r = await fetch(`${API}/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      registrar('consultar-pago', `status ${r.status}`);
      return null;
    }
    return (await r.json()) as PagoMP;
  } catch (error) {
    registrar('consultar-pago', tipoDeFallo(error));
    return null;
  }
}
