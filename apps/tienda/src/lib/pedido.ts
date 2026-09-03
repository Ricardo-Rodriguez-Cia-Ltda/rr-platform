import { MAX_LINEAS, MAX_UNIDADES, type ItemCarro } from './carro.js';

export interface Comprador { nombre: string; telefono: string; email: string }
export interface Facturacion {
  rut: string; razonSocial: string; giro: string; direccion: string;
  comuna: string; ciudad: string; emailFactura: string;
}

const CAMPOS_FACT: Array<keyof Facturacion> = ['rut', 'razonSocial', 'giro', 'direccion', 'comuna', 'ciudad', 'emailFactura'];

// Valida el POST del checkout. El honeypot devuelve un error generico a
// proposito: a un bot no se le explica que fallo.
export function validarPedido(body: unknown):
  | { items: ItemCarro[]; comprador: Comprador; facturacion: Facturacion | null; totalConfirmadoClp: number }
  | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return { error: 'Pedido inválido.' };
  if (String(b.sitio_web ?? '') !== '') return { error: 'No pudimos procesar tu pedido.' };

  const c = (b.comprador ?? {}) as Record<string, unknown>;
  const nombre = String(c.nombre ?? '').trim();
  const telefono = String(c.telefono ?? '').replace(/\D/g, '');
  const email = String(c.email ?? '').trim();
  if (nombre.length < 2) return { error: 'Cuéntanos tu nombre.' };
  if (telefono.length < 8 || telefono.length > 15) return { error: 'Revisa el teléfono (con código de país, ej. +56 9 ...).' };
  if (!email.includes('@') || !email.includes('.')) return { error: 'Revisa el email.' };

  const crudos = Array.isArray(b.items) ? b.items : [];
  if (crudos.length === 0) return { error: 'El carro está vacío.' };
  if (crudos.length > MAX_LINEAS) return { error: `Máximo ${MAX_LINEAS} productos distintos.` };
  const items: ItemCarro[] = [];
  for (const crudo of crudos as Array<Record<string, unknown>>) {
    if (!crudo || typeof crudo !== 'object') return { error: 'Una línea del carro no es válida.' };
    const cantidad = Number(crudo.cantidad);
    const sku = String(crudo.sku ?? '').trim();
    if (!sku) return { error: 'Una línea del carro no es válida.' };
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_UNIDADES) {
      return { error: 'Una cantidad no es válida.' };
    }
    items.push({
      sku,
      mpn: crudo.mpn == null ? null : String(crudo.mpn),
      marca: crudo.marca == null ? null : String(crudo.marca),
      nombre: String(crudo.nombre ?? ''),
      cantidad,
      precioTiendaClp: Number(crudo.precioTiendaClp ?? 0),
    });
  }

  let facturacion: Facturacion | null = null;
  const f = b.facturacion as Record<string, unknown> | undefined;
  if (f && CAMPOS_FACT.some((k) => String(f[k] ?? '').trim() !== '')) {
    const completos = CAMPOS_FACT.every((k) => String(f[k] ?? '').trim() !== '');
    if (!completos) return { error: 'Los datos de facturación van completos o vacíos (los 7 campos).' };
    facturacion = Object.fromEntries(CAMPOS_FACT.map((k) => [k, String(f[k]).trim()])) as unknown as Facturacion;
  }

  return { items, comprador: { nombre, telefono, email }, facturacion, totalConfirmadoClp: Number(b.totalConfirmadoClp ?? 0) };
}

export function armarPayloadCotizacion(items: ItemCarro[], telefono: string): unknown {
  return {
    execution_context: {
      vars: { cart_items: items.map((i) => ({ sku: i.sku, mpn: i.mpn, marca: i.marca, cantidad: i.cantidad })) },
      context: { phone_number: telefono },
    },
  };
}

export function armarPayloadEmision(
  quote: unknown, comprador: Comprador, facturacion: Facturacion | null, telefono: string,
): unknown {
  return {
    execution_context: {
      vars: {
        quote_result: quote,
        quote_confirmed: true,
        quote_customer_name: comprador.nombre,
        ...(facturacion
          ? {
              billing_rut: facturacion.rut,
              billing_razon_social: facturacion.razonSocial,
              billing_giro: facturacion.giro,
              billing_direccion: facturacion.direccion,
              billing_comuna: facturacion.comuna,
              billing_ciudad: facturacion.ciudad,
              billing_email: facturacion.emailFactura,
            }
          : {}),
      },
      context: { phone_number: telefono },
    },
  };
}
