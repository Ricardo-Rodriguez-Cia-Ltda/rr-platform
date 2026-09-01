import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { firstString } from '@rr/http/http';
import { buildCotizacionView, type ClienteRow, type CotizacionRow, type CotizacionView } from './cotizacion-view.js';
import {
  PAGE_W,
  PAGE_H,
  MARGIN,
  GRIS,
  NEGRO,
  truncar,
  centrado as centradoEn,
  derecha as derechaEn,
  dibujarMembrete,
  dibujarPie,
} from './pdf-comunes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] as const;
const TIMEOUT_MS = 8000;

export interface CotizacionEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

// null => la llamada fallo (red, timeout, status no-2xx): el caller responde
// 503 "upstream", nunca 404 -- eso confundiria "no existe" con "no se pudo
// preguntar".
async function supabaseGet(env: Required<CotizacionEnv>, path: string): Promise<unknown[] | null> {
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/rest/v1${path}`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return (await r.json()) as unknown[];
  } catch {
    return null;
  }
}

// `draw` es inyectable solo para pruebas -- ver `apps/mailer/tests/cotizacion.test.ts`,
// el caso que fuerza el 503 cuando drawCotizacion revienta. En produccion
// siempre corre el `drawCotizacion` real, de mas abajo en este archivo.
export function createCotizacionHandler(draw: (view: CotizacionView) => Promise<Uint8Array> = drawCotizacion) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: CotizacionEnv = process.env as CotizacionEnv,
  ): Promise<void> {
    const id = firstString(req.query.id) ?? '';

    // El id llega crudo en la URL: se valida ANTES de tocar Supabase, para
    // que un intento de path traversal o inyeccion ni siquiera dispare un
    // fetch.
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'cotizacion_no_encontrada' });
      return;
    }

    const faltan = REQUIRED_ENV.filter((name) => !env[name]);
    if (faltan.length > 0) {
      res.status(503).json({ error: 'falta_configuracion', faltan });
      return;
    }
    const supaEnv = env as Required<CotizacionEnv>;

    const rows = await supabaseGet(supaEnv, `/cotizaciones?quote_id=eq.${id}&limit=1`);
    if (rows === null) {
      res.status(503).json({ error: 'upstream' });
      return;
    }
    const row = rows[0] as CotizacionRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'cotizacion_no_encontrada' });
      return;
    }

    let cliente: ClienteRow | null = null;
    if (row.telefono) {
      const clientes = await supabaseGet(supaEnv, `/clientes?telefono=eq.${encodeURIComponent(row.telefono)}&limit=1`);
      if (clientes === null) {
        res.status(503).json({ error: 'upstream' });
        return;
      }
      cliente = (clientes[0] as ClienteRow | undefined) ?? null;
    }

    const view = buildCotizacionView(row, cliente);

    // sanitizeWinAnsi en buildCotizacionView cubre el caso conocido (mojibake
    // de Ingram), pero drawCotizacion sigue sin try/catch propio: cualquier
    // otra forma de reventar el dibujo (fuente, layout) no puede tumbar la
    // respuesta con un 500 sin cuerpo. Se degrada a 503 "upstream" -- el
    // mismo contrato que un fallo de Supabase, asi que el link sigue siendo
    // reintentable. Solo se loguea el quote_id, nunca datos del cliente.
    let bytes: Uint8Array;
    try {
      bytes = await draw(view);
    } catch {
      console.error(`cotizacion ${row.quote_id}: drawCotizacion revento`);
      res.status(503).json({ error: 'upstream' });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${view.archivo}"`);
    res.send(Buffer.from(bytes));
  };
}

// --- dibujo del PDF --------------------------------------------------------
// El membrete, el pie y los helpers de layout viven en pdf-comunes.ts,
// compartidos con la orden de compra (orden.ts).

const MAX_FILAS_POR_PAGINA = 18; // el caso real es 1-5 lineas; es solo un tope de seguridad

const COL = {
  codigo: { x: MARGIN, w: 70 },
  descripcion: { x: MARGIN + 70, w: 260 },
  cantidad: { x: MARGIN + 70 + 260, w: 60 },
  valor: { x: MARGIN + 70 + 260 + 60, w: 70 },
  total: { x: MARGIN + 70 + 260 + 60 + 70, w: 70 },
};
const TABLA_DERECHA = COL.total.x + COL.total.w;

export async function drawCotizacion(view: CotizacionView): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);

  // Cierran sobre `page`, que se reasigna cuando la tabla salta de pagina.
  const centrado = (texto: string, size: number, font: PDFFont, atY: number, color = NEGRO) =>
    centradoEn(page, texto, size, font, atY, color);
  const derecha = (texto: string, size: number, font: PDFFont, xDerecha: number, atY: number, color = NEGRO) =>
    derechaEn(page, texto, size, font, xDerecha, atY, color);

  let y = dibujarMembrete(page, helv, helvBold, view.fechaLarga);

  centrado(`COTIZACION N° ${view.numero}`, 13, helvBold, y);
  y -= 25;

  // Bloque cliente
  page.drawText('Señores:', { x: MARGIN, y, size: 10, font: helv });
  y -= 14;
  if (view.cliente) {
    page.drawText(view.cliente.razonSocial, { x: MARGIN, y, size: 10, font: helvBold });
    y -= 14;
    if (view.cliente.rut) {
      page.drawText(`R.U.T.: ${view.cliente.rut}`, { x: MARGIN, y, size: 10, font: helv });
      y -= 14;
    }
  } else {
    page.drawText('Presente', { x: MARGIN, y, size: 10, font: helv });
    y -= 14;
  }
  y -= 10;

  // Parrafo de cortesia
  page.drawText('De acuerdo a lo solicitado, tenemos el agrado de cotizar a usted lo siguiente:', {
    x: MARGIN,
    y,
    size: 10,
    font: helv,
  });
  y -= 20;

  const dibujarEncabezadoTabla = () => {
    page.drawText('Código', { x: COL.codigo.x, y, size: 9, font: helvBold });
    page.drawText('Descripción', { x: COL.descripcion.x, y, size: 9, font: helvBold });
    derecha('Cantidad', 9, helvBold, COL.cantidad.x + COL.cantidad.w, y);
    derecha('Valor', 9, helvBold, COL.valor.x + COL.valor.w, y);
    derecha('Total', 9, helvBold, COL.total.x + COL.total.w, y);
    y -= 3;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: TABLA_DERECHA, y }, thickness: 0.75, color: NEGRO });
    y -= 14;
  };
  dibujarEncabezadoTabla();

  const ALTO_FILA = 14;
  let filasEnPagina = 0;
  for (const linea of view.lineas) {
    if (filasEnPagina >= MAX_FILAS_POR_PAGINA) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - 40;
      dibujarEncabezadoTabla();
      filasEnPagina = 0;
    }
    page.drawText(linea.codigo, { x: COL.codigo.x, y, size: 9, font: helv });
    const desc = truncar(helv, linea.descripcion, COL.descripcion.w - 5, 8);
    page.drawText(desc, { x: COL.descripcion.x, y, size: 8, font: helv });
    derecha(String(linea.cantidad), 9, helv, COL.cantidad.x + COL.cantidad.w, y);
    derecha(linea.valorUnitario, 9, helv, COL.valor.x + COL.valor.w, y);
    derecha(linea.total, 9, helv, COL.total.x + COL.total.w, y);
    y -= ALTO_FILA;
    filasEnPagina++;
  }

  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: TABLA_DERECHA, y }, thickness: 0.75, color: NEGRO });
  y -= 16;

  // Neto / IVA / Total alineados a la derecha, Total en bold
  derecha(`Neto: ${view.netoFmt}`, 9, helv, TABLA_DERECHA, y);
  y -= 13;
  derecha(`IVA: ${view.ivaFmt}`, 9, helv, TABLA_DERECHA, y);
  y -= 13;
  derecha(`Total: ${view.totalFmt}`, 10, helvBold, TABLA_DERECHA, y);
  y -= 24;

  // Observaciones
  page.drawText('Observaciones:', { x: MARGIN, y, size: 9, font: helvBold });
  y -= 13;
  const observaciones = ['Valores en pesos chilenos.'];
  if (view.vigenciaTexto) observaciones.push(view.vigenciaTexto);
  observaciones.push('CONSULTAS AL FONO: +56-2-23641111');
  for (const obs of observaciones) {
    page.drawText(`•  ${obs}`, { x: MARGIN, y, size: 8, font: helv });
    y -= 11;
  }
  y -= 8;

  page.drawText('Sin otro particular, saluda atentamente a usted.', { x: MARGIN, y, size: 9, font: helv });

  dibujarPie(page, helv);

  return doc.save();
}
