const ZONA = 'America/Santiago';

// pdf-lib dibuja con WinAnsiEncoding (cp1252) cuando se usa una fuente
// estandar (Helvetica): drawText LANZA si el texto trae un caracter que esa
// codificacion no puede representar. Esto llego a produccion real: 44
// nombres del catalogo de Ingram (0,27% del catalogo) traen mojibake
// (p.ej. U+0081, U+009D -- bytes de cp1252 sin caracter asignado, producto
// de una doble-decodificacion rota rio arriba) y no habia try/catch, asi que
// el endpoint moria con 500 determinista para esas cotizaciones. `razonSocial`
// tiene el mismo riesgo porque lo tipea el cliente.
//
// El conjunto permitido es: ASCII imprimible (0x20-0x7E), el rango Latin-1
// que cp1252 comparte con WinAnsi (0xA0-0xFF), y los 27 caracteres que cp1252
// SI define en el bloque 0x80-0x9F (comillas curvas, guion largo, €, etc. --
// los que ya se usan en el documento). Cualquier otro caracter, sanitizado
// a '?': mas simple y predecible que adivinar la codificacion original rota.
const WINANSI_ESPECIALES_80_9F = new Set<number>([
  0x20ac, // €
  0x201a, // ‚
  0x0192, // ƒ
  0x201e, // „
  0x2026, // …
  0x2020, // †
  0x2021, // ‡
  0x02c6, // ˆ
  0x2030, // ‰
  0x0160, // Š
  0x2039, // ‹
  0x0152, // Œ
  0x017d, // Ž
  0x2018, // '
  0x2019, // '
  0x201c, // "
  0x201d, // "
  0x2022, // •
  0x2013, // –
  0x2014, // —
  0x02dc, // ˜
  0x2122, // ™
  0x0161, // š
  0x203a, // ›
  0x0153, // œ
  0x017e, // ž
  0x0178, // Ÿ
]);

function esWinAnsi(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;
  return WINANSI_ESPECIALES_80_9F.has(codePoint);
}

export function sanitizeWinAnsi(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += esWinAnsi(cp) ? ch : '?';
  }
  return out;
}

export interface CotizacionRow {
  quote_id: string;
  // En Postgres, `add column ... generated always as identity` rellena
  // retroactivamente TODAS las filas existentes -- no queda ninguna fila
  // real sin numero tras correr el ALTER. `null` es una rama defensiva
  // (columna todavia no existe / consulta que no la trajo), no un caso
  // esperado en producción.
  numero: number | null;
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
    cliente: cliente ? { razonSocial: sanitizeWinAnsi(cliente.razon_social), rut: cliente.rut } : null,
    lineas: row.lineas.map((l) => ({
      // Ya NO cae al SKU del mayorista: es un documento de cliente, y ese
      // codigo interno es informacion que facilita ir a comprarle directo al
      // proveedor (desintermediacion). Sin MPN, va '—'.
      codigo: sanitizeWinAnsi(l.mpn ?? '—'),
      descripcion: sanitizeWinAnsi(l.nombre ?? ''),
      // Dato corrupto (undefined) se muestra en 0, no revienta el dibujo del
      // PDF -- decision adjudicada, no un bug pendiente.
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
