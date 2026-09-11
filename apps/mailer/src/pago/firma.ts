import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Valida la firma HMAC-SHA256 con que Mercado Pago firma cada notificacion.
 * Es lo unico que separa este endpoint publico de cualquiera que sepa la URL,
 * asi que ante la menor duda se devuelve false.
 */

// El header llega como `ts=1742505638683,v1=<hex>`.
export function parseSignature(header: string | undefined): { ts: string; v1: string } | null {
  if (!header) return null;
  const partes: Record<string, string> = {};
  for (const trozo of header.split(',')) {
    const i = trozo.indexOf('=');
    if (i < 0) continue;
    partes[trozo.slice(0, i).trim()] = trozo.slice(i + 1).trim();
  }
  return partes.ts && partes.v1 ? { ts: partes.ts, v1: partes.v1 } : null;
}

// El template de Mercado Pago. Un valor que no vino en la notificacion se
// omite entero, no se deja vacio: firmar `request-id:;` daria distinto.
export function construirManifiesto(dataId: string, requestId: string | undefined, ts: string): string {
  let manifiesto = `id:${dataId.toLowerCase()};`;
  if (requestId) manifiesto += `request-id:${requestId};`;
  manifiesto += `ts:${ts};`;
  return manifiesto;
}

export function firmaValida(params: {
  dataId: string;
  requestId?: string;
  header?: string;
  secret: string;
}): boolean {
  if (!params.secret || !params.dataId) return false;
  const firma = parseSignature(params.header);
  if (!firma) return false;

  const esperada = createHmac('sha256', params.secret)
    .update(construirManifiesto(params.dataId, params.requestId, firma.ts))
    .digest('hex');

  // timingSafeEqual revienta si los largos difieren, y el largo de un hex de
  // sha256 es publico: compararlo antes no filtra nada.
  const recibida = Buffer.from(firma.v1);
  const buffer = Buffer.from(esperada);
  return recibida.length === buffer.length && timingSafeEqual(recibida, buffer);
}
