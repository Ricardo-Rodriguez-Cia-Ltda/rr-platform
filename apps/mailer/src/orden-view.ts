import { sanitizeWinAnsi } from './cotizacion-view.js';

const ZONA = 'America/Santiago';

// Fila de la tabla `pedidos` (docs/sql/2026-08-31-persistencia.sql). Las
// `lineas` son el detalle del grupo que la function emitir-ordenes-compra
// persiste: desde el cambio de 2026-09-01 vienen CON los costos reconstruidos
// (`costo_unitario_usd`, `costo_total_usd`); en filas anteriores a ese cambio
// esos campos no existen y la vista los muestra como '—'.
export interface PedidoRow {
  po_id: string;
  quote_id: string;
  quote_version: string;
  proveedor: string;
  telefono: string | null;
  rut: string | null;
  razon_social: string | null;
  estado: string; // processing | sent | failed (espejo de D1)
  created_at: string; // ISO
  lineas: Array<{
    sku_proveedor?: string | null;
    mpn?: string | null;
    nombre?: string | null;
    cantidad?: number;
    abastecimiento?: string | null;
    costo_unitario_usd?: number;
    costo_total_usd?: number;
  }>;
}

export interface OrdenView {
  poId: string;
  archivo: string; // "<po_id>.pdf" (el po_id ya parte con "oc-")
  fechaLarga: string; // "Santiago, 1 de septiembre de 2026"
  proveedor: string; // "INTCOMEX"
  referencia: string; // "Ref.: Cotización N° 1600001 (v1)" o con el quote_id si no hay numero
  cliente: { razonSocial: string; rut: string | null } | null;
  lineas: Array<{
    sku: string;
    codigo: string; // MPN
    descripcion: string;
    cantidad: number;
    abastecimiento: string;
    costoUnitario: string; // "US$ 10,00" o "—"
    costoTotal: string;
  }>;
  totalFmt: string; // "US$ 123,45" — o "—" si alguna linea no trae costo
  // '' cuando la orden se emitio bien; texto de advertencia cuando la fila
  // dice failed/processing: un documento de una orden que no salio debe
  // decirlo, no aparentar normalidad.
  estadoAviso: string;
}

// Costos en dolares con dos decimales y separadores es-CL ("1.234,56").
export function formatUSD(n: number): string {
  return 'US$ ' + n.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fechaLarga(iso: string): string {
  const texto = new Intl.DateTimeFormat('es-CL', {
    timeZone: ZONA,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
  return `Santiago, ${texto}`;
}

// Los valores de abastecimiento vienen con guion bajo del catalogo
// ("stock_inmediato", "por_comprar_importar"); en el documento van legibles.
function abastecimientoLegible(valor: string | null | undefined): string {
  if (!valor) return '—';
  return sanitizeWinAnsi(String(valor).replaceAll('_', ' '));
}

export function buildOrdenView(row: PedidoRow, numeroCotizacion: number | null): OrdenView {
  const lineas = row.lineas.map((l) => ({
    sku: sanitizeWinAnsi(l.sku_proveedor ?? '—'),
    codigo: sanitizeWinAnsi(l.mpn ?? '—'),
    descripcion: sanitizeWinAnsi(l.nombre ?? ''),
    cantidad: l.cantidad ?? 0,
    abastecimiento: abastecimientoLegible(l.abastecimiento),
    costoUnitario: typeof l.costo_unitario_usd === 'number' ? formatUSD(l.costo_unitario_usd) : '—',
    costoTotal: typeof l.costo_total_usd === 'number' ? formatUSD(l.costo_total_usd) : '—',
  }));

  // Total solo si TODAS las lineas traen costo: una suma parcial afirmaria un
  // total que no es. Filas anteriores al cambio quedan en '—'.
  const costos = row.lineas.map((l) => l.costo_total_usd);
  const totalFmt = costos.length > 0 && costos.every((c) => typeof c === 'number')
    ? formatUSD(Math.round((costos as number[]).reduce((s, c) => s + c, 0) * 100) / 100)
    : '—';

  const ref = numeroCotizacion != null ? `N° ${numeroCotizacion}` : row.quote_id;

  let estadoAviso = '';
  if (row.estado === 'failed') {
    estadoAviso = 'ATENCIÓN: el correo de esta orden FALLÓ — verificar antes de usar este documento.';
  } else if (row.estado === 'processing') {
    estadoAviso = 'ATENCIÓN: esta orden quedó a medio emitir — verificar su estado real.';
  }

  return {
    poId: row.po_id,
    archivo: `${row.po_id}.pdf`,
    fechaLarga: fechaLarga(row.created_at),
    proveedor: sanitizeWinAnsi(String(row.proveedor).toUpperCase()),
    referencia: `Ref.: Cotización ${ref} (v${row.quote_version})`,
    cliente: row.razon_social ? { razonSocial: sanitizeWinAnsi(row.razon_social), rut: row.rut } : null,
    lineas,
    totalFmt,
    estadoAviso,
  };
}
