import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { firstString } from '@rr/http/http';
import { buildOrdenView, type OrdenView, type PedidoRow } from './orden-view.js';
import {
  PAGE_W,
  PAGE_H,
  MARGIN,
  GRIS,
  NEGRO,
  ROJO,
  truncar,
  centrado as centradoEn,
  derecha as derechaEn,
  dibujarMembrete,
  dibujarPie,
} from './pdf-comunes.js';

// El po_id lo arma emitir-ordenes-compra: "oc-" + `${quote_id}:${version}:${proveedor}`
// con todo lo no-alfanumerico reemplazado por "-". El UUID de la cotizacion
// queda embebido (122 bits aleatorios), asi que la URL es una capability URL
// igual que la de /api/cotizacion. Se valida la forma completa ANTES de tocar
// Supabase.
const PO_ID_RE = /^oc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9_-]{1,60}$/i;
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] as const;
const TIMEOUT_MS = 8000;

export interface OrdenEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

// null => la llamada fallo (red, timeout, status no-2xx): 503 "upstream",
// nunca 404 -- eso confundiria "no existe" con "no se pudo preguntar".
async function supabaseGet(env: Required<OrdenEnv>, path: string): Promise<unknown[] | null> {
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

// `draw` es inyectable solo para pruebas, igual que en cotizacion.ts.
export function createOrdenHandler(draw: (view: OrdenView) => Promise<Uint8Array> = drawOrden) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: OrdenEnv = process.env as OrdenEnv,
  ): Promise<void> {
    const id = firstString(req.query.id) ?? '';

    if (!PO_ID_RE.test(id)) {
      res.status(404).json({ error: 'orden_no_encontrada' });
      return;
    }

    const faltan = REQUIRED_ENV.filter((name) => !env[name]);
    if (faltan.length > 0) {
      res.status(503).json({ error: 'falta_configuracion', faltan });
      return;
    }
    const supaEnv = env as Required<OrdenEnv>;

    const rows = await supabaseGet(supaEnv, `/pedidos?po_id=eq.${encodeURIComponent(id)}&limit=1`);
    if (rows === null) {
      res.status(503).json({ error: 'upstream' });
      return;
    }
    const row = rows[0] as PedidoRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'orden_no_encontrada' });
      return;
    }

    // El numero correlativo vive en la cotizacion de origen; en el documento
    // es la referencia humana ("Cotización N° 1600001"). Si la fila no
    // aparece (cotizacion purgada), la referencia cae al quote_id -- pero un
    // fallo de red sigue siendo 503 reintentable, no una referencia peor.
    const cotizaciones = await supabaseGet(
      supaEnv,
      `/cotizaciones?quote_id=eq.${encodeURIComponent(row.quote_id)}&version=eq.${encodeURIComponent(row.quote_version)}&select=numero&limit=1`,
    );
    if (cotizaciones === null) {
      res.status(503).json({ error: 'upstream' });
      return;
    }
    const numero = (cotizaciones[0] as { numero?: number | null } | undefined)?.numero ?? null;

    const view = buildOrdenView(row, numero);

    let bytes: Uint8Array;
    try {
      bytes = await draw(view);
    } catch {
      console.error(`orden ${row.po_id}: drawOrden revento`);
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
// Membrete, pie y helpers compartidos con cotizacion.ts via pdf-comunes.ts.

const MAX_FILAS_POR_PAGINA = 18; // el caso real es 1-5 lineas; tope de seguridad

// 7 columnas en 525pt utiles: la descripcion cede ancho para que quepan los
// dos costos y el abastecimiento.
const COL = {
  sku: { x: MARGIN, w: 75 },
  codigo: { x: MARGIN + 75, w: 75 },
  descripcion: { x: MARGIN + 150, w: 165 },
  cantidad: { x: MARGIN + 315, w: 30 },
  abastecimiento: { x: MARGIN + 345, w: 60 },
  costoUnit: { x: MARGIN + 405, w: 60 },
  costoTotal: { x: MARGIN + 465, w: 60 },
};
const TABLA_DERECHA = COL.costoTotal.x + COL.costoTotal.w;

export async function drawOrden(view: OrdenView): Promise<Uint8Array> {
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

  centrado('ORDEN DE COMPRA', 13, helvBold, y);
  y -= 14;
  centrado(view.poId, 8, helv, y, GRIS);
  y -= 18;

  if (view.estadoAviso) {
    centrado(truncar(helvBold, view.estadoAviso, PAGE_W - 2 * MARGIN, 9), 9, helvBold, y, ROJO);
    y -= 18;
  }

  // Destinatario: el mayorista
  page.drawText('Señores:', { x: MARGIN, y, size: 10, font: helv });
  y -= 14;
  page.drawText(view.proveedor, { x: MARGIN, y, size: 10, font: helvBold });
  y -= 16;

  // Referencia a la cotizacion de origen y al cliente final
  page.drawText(view.referencia, { x: MARGIN, y, size: 9, font: helv });
  y -= 13;
  const clienteFinal = view.cliente
    ? `Cliente final: ${view.cliente.razonSocial}${view.cliente.rut ? ` — R.U.T. ${view.cliente.rut}` : ''}`
    : 'Cliente final: no registrado';
  page.drawText(truncar(helv, clienteFinal, PAGE_W - 2 * MARGIN, 9), { x: MARGIN, y, size: 9, font: helv });
  y -= 20;

  const dibujarEncabezadoTabla = () => {
    page.drawText('SKU proveedor', { x: COL.sku.x, y, size: 8, font: helvBold });
    page.drawText('MPN', { x: COL.codigo.x, y, size: 8, font: helvBold });
    page.drawText('Producto', { x: COL.descripcion.x, y, size: 8, font: helvBold });
    derecha('Cant.', 8, helvBold, COL.cantidad.x + COL.cantidad.w, y);
    page.drawText('Abastec.', { x: COL.abastecimiento.x + 8, y, size: 8, font: helvBold });
    derecha('Costo unit.', 8, helvBold, COL.costoUnit.x + COL.costoUnit.w, y);
    derecha('Costo total', 8, helvBold, COL.costoTotal.x + COL.costoTotal.w, y);
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
    page.drawText(truncar(helv, linea.sku, COL.sku.w - 5, 7), { x: COL.sku.x, y, size: 7, font: helv });
    page.drawText(truncar(helv, linea.codigo, COL.codigo.w - 5, 7), { x: COL.codigo.x, y, size: 7, font: helv });
    page.drawText(truncar(helv, linea.descripcion, COL.descripcion.w - 5, 7), { x: COL.descripcion.x, y, size: 7, font: helv });
    derecha(String(linea.cantidad), 8, helv, COL.cantidad.x + COL.cantidad.w, y);
    page.drawText(truncar(helv, linea.abastecimiento, COL.abastecimiento.w - 3, 6), { x: COL.abastecimiento.x + 8, y, size: 6, font: helv });
    derecha(linea.costoUnitario, 7, helv, COL.costoUnit.x + COL.costoUnit.w, y);
    derecha(linea.costoTotal, 7, helv, COL.costoTotal.x + COL.costoTotal.w, y);
    y -= ALTO_FILA;
    filasEnPagina++;
  }

  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: TABLA_DERECHA, y }, thickness: 0.75, color: NEGRO });
  y -= 16;

  derecha(`Total orden: ${view.totalFmt}`, 10, helvBold, TABLA_DERECHA, y);
  y -= 24;

  page.drawText('Observaciones:', { x: MARGIN, y, size: 9, font: helvBold });
  y -= 13;
  const observaciones = [
    'Valores en dólares (US$), costos de compra.',
    'DOCUMENTO INTERNO: contiene costos — no reenviar al cliente final.',
    'Pago del cliente: contado.',
  ];
  for (const obs of observaciones) {
    page.drawText(`•  ${obs}`, { x: MARGIN, y, size: 8, font: helv });
    y -= 11;
  }

  dibujarPie(page, helv);

  return doc.save();
}
