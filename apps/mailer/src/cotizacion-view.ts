const ZONA = 'America/Santiago';

export interface CotizacionRow {
  quote_id: string;
  numero: number | null; // null si la fila es anterior al ALTER
  telefono: string | null; // para buscar al cliente
  neto_clp: number;
  iva_clp: number;
  total_clp: number;
  valida_hasta: string | null; // ISO
  created_at: string; // ISO
  lineas: Array<{
    mpn?: string | null;
    sku_proveedor?: string | null;
    nombre?: string | null;
    cantidad?: number;
    precio_unitario_clp?: number;
    subtotal_neto_clp?: number;
  }>;
}

export interface ClienteRow {
  razon_social: string;
  rut: string;
}

export interface CotizacionView {
  numero: string; // "1600001" o "S/N"
  archivo: string; // "cotizacion-1600001.pdf" o "cotizacion-SN.pdf"
  fechaLarga: string; // "Santiago, 1 de septiembre de 2026" (zona America/Santiago)
  cliente: { razonSocial: string; rut: string } | null;
  lineas: Array<{ codigo: string; descripcion: string; cantidad: number; valorUnitario: string; total: string }>;
  netoFmt: string;
  ivaFmt: string;
  totalFmt: string; // "$1.221.795"
  vigenciaTexto: string; // "COTIZACIÓN VÁLIDA HASTA: 01-09-2026, 18:45 hrs (hora de Santiago)" o "" si no hay fecha
}

export function formatCLP(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CL'); // es-CL usa punto de miles
}

// Extrae dia/mes/anio/hora/minuto de un instante ISO, ya resueltos en la zona
// horaria de Santiago (con su DST vigente para esa fecha), sin hardcodear el
// offset UTC-3/UTC-4: Intl con timeZone es siempre la autoridad.
function partesSantiago(iso: string): { dia: string; mes: string; anio: string; hora: string; minuto: string } {
  const fecha = new Date(iso);
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(fecha);

  const valor = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  return {
    dia: valor('day'),
    mes: valor('month'),
    anio: valor('year'),
    // en-GB con hour12:false puede devolver "24" para medianoche; se normaliza a "00".
    hora: valor('hour') === '24' ? '00' : valor('hour'),
    minuto: valor('minute'),
  };
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

function vigenciaTexto(validaHasta: string | null): string {
  if (!validaHasta) return '';
  const { dia, mes, anio, hora, minuto } = partesSantiago(validaHasta);
  return `COTIZACIÓN VÁLIDA HASTA: ${dia}-${mes}-${anio}, ${hora}:${minuto} hrs (hora de Santiago)`;
}

export function buildCotizacionView(row: CotizacionRow, cliente: ClienteRow | null): CotizacionView {
  const numero = row.numero != null ? String(row.numero) : 'S/N';
  const archivo = row.numero != null ? `cotizacion-${row.numero}.pdf` : 'cotizacion-SN.pdf';

  return {
    numero,
    archivo,
    fechaLarga: fechaLarga(row.created_at),
    cliente: cliente ? { razonSocial: cliente.razon_social, rut: cliente.rut } : null,
    lineas: row.lineas.map((l) => ({
      codigo: l.mpn ?? l.sku_proveedor ?? '—',
      descripcion: l.nombre ?? '',
      cantidad: l.cantidad ?? 0,
      valorUnitario: formatCLP(l.precio_unitario_clp ?? 0),
      total: formatCLP(l.subtotal_neto_clp ?? 0),
    })),
    netoFmt: formatCLP(row.neto_clp),
    ivaFmt: formatCLP(row.iva_clp),
    totalFmt: formatCLP(row.total_clp),
    vigenciaTexto: vigenciaTexto(row.valida_hasta),
  };
}
