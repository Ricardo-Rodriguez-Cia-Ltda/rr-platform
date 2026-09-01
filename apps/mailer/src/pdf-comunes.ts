import { rgb, type PDFFont, type PDFPage } from 'pdf-lib';

// Piezas compartidas entre los documentos PDF de la empresa (cotizacion y
// orden de compra): membrete, pie de pagina, colores y helpers de layout.
// Extraidas de cotizacion.ts cuando aparecio el segundo documento, para que
// el membrete no viva dos veces y se desincronice.

export const PAGE_W = 595;
export const PAGE_H = 842;
export const MARGIN = 35;
export const AZUL = rgb(0.23, 0.23, 0.7);
export const GRIS = rgb(0.45, 0.45, 0.45);
export const NEGRO = rgb(0, 0, 0);
export const ROJO = rgb(0.75, 0.1, 0.1);

export function truncar(font: PDFFont, texto: string, anchoMax: number, size: number): string {
  if (font.widthOfTextAtSize(texto, size) <= anchoMax) return texto;
  let recortado = texto;
  while (recortado.length > 0 && font.widthOfTextAtSize(recortado + '…', size) > anchoMax) {
    recortado = recortado.slice(0, -1);
  }
  return recortado.length > 0 ? recortado + '…' : '…';
}

export function centrado(page: PDFPage, texto: string, size: number, font: PDFFont, atY: number, color = NEGRO): void {
  const w = font.widthOfTextAtSize(texto, size);
  page.drawText(texto, { x: (PAGE_W - w) / 2, y: atY, size, font, color });
}

export function derecha(page: PDFPage, texto: string, size: number, font: PDFFont, xDerecha: number, atY: number, color = NEGRO): void {
  const w = font.widthOfTextAtSize(texto, size);
  page.drawText(texto, { x: xDerecha - w, y: atY, size, font, color });
}

// Monograma + membrete centrado + fecha a la derecha + linea divisoria.
// Devuelve la Y donde empieza el contenido del documento. La fecha va en su
// propia linea (no junto al titulo): el titulo centrado en bold14 es ancho, y
// compartir altura con la fecha las hacia chocar.
export function dibujarMembrete(page: PDFPage, helv: PDFFont, helvBold: PDFFont, fechaLarga: string): number {
  let y = PAGE_H - 40;

  // Monograma: no hay logo separado en "idea pdf/" (solo el mockup completo,
  // que no se incrusta) -- va el monograma "R" dibujado a mano.
  page.drawRectangle({ x: MARGIN, y: y - 50, width: 50, height: 50, borderColor: AZUL, borderWidth: 1.5 });
  const anchoR = helvBold.widthOfTextAtSize('R', 28);
  page.drawText('R', { x: MARGIN + (50 - anchoR) / 2, y: y - 36, size: 28, font: helvBold, color: AZUL });

  centrado(page, 'RICARDO RODRIGUEZ & CIA. LTDA.', 14, helvBold, y - 8);
  centrado(page, 'DIVISION INFORMATICA', 9, helv, y - 22);
  centrado(page, 'R.U.T.: 89.912.300-K', 9, helv, y - 34);
  derecha(page, fechaLarga, 9, helv, PAGE_W - MARGIN, y - 46);

  y -= 65;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: GRIS });
  return y - 20;
}

// Pie de pagina, chico y gris, igual en todos los documentos.
export function dibujarPie(page: PDFPage, helv: PDFFont): void {
  const piePagina = [
    'WWW.RICARDORODRIGUEZ.CL',
    'Los productos vendidos cuentan con la garantia del fabricante; consulte condiciones y plazos con su ejecutivo.',
    'José M. Infante #2629 Ñuñoa · Santiago — CHILE · e-mail: ventas@ricardorodriguez.cl',
  ];
  piePagina.forEach((linea, i) => {
    centrado(page, linea, 7, helv, 40 - i * 9, GRIS);
  });
}
