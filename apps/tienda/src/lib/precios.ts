// Conversion costo->venta IDENTICA a la del bot (generar-cotizacion-v2.js):
// la pricing-api entrega COSTOS del mayorista en USD; lo que ve el cliente
// es venta con margen, en CLP, con IVA. Si esta formula divergiera de la del
// bot, generar-cotizacion-v2 recotizaria distinto y CADA pedido rebotaria con
// el 409 de recotizacion antes de llegar a emitirse.
export interface CfgPrecios { margen: number; tipoCambio: number; iva: number }

export function cfgPrecios(): CfgPrecios | null {
  const margen = Number(process.env.MARGEN ?? '');
  const tipoCambio = Number(process.env.TIPO_CAMBIO_CLP_USD ?? '');
  const iva = Number(process.env.IVA_RATE ?? '');
  if (![margen, tipoCambio, iva].every(Number.isFinite)) return null;
  if (margen <= 0 || tipoCambio <= 0 || iva < 0) return null; // margen 0 = vender a costo
  return { margen, tipoCambio, iva };
}

// generar-cotizacion-v2.js:104-105
//   const venta = (costo) => Math.round(Number(costo) * (1 + margen) * 100) / 100;
//   const aClp  = (usd)   => Math.round(usd * tipoCambio);
// El redondeo a CENTAVOS DE DOLAR ocurre ANTES del tipo de cambio: saltarselo
// desplaza el neto unos pesos (1.18 USD -> 1264 con el redondeo, 1267 sin el).
export function ventaNetaClp(costoUsd: number, cfg: CfgPrecios): number {
  const ventaUsd = Math.round(costoUsd * (1 + cfg.margen) * 100) / 100;
  return Math.round(ventaUsd * cfg.tipoCambio);
}

// generar-cotizacion-v2.js:150-152: iva_clp = round(neto * iva); total = neto + iva_clp.
// No es lo mismo que round(neto * (1 + iva)) cuando neto*iva cae en .5 exacto.
export function conIvaClp(netoClp: number, cfg: CfgPrecios): number {
  return netoClp + Math.round(netoClp * cfg.iva);
}

// Precio unitario con IVA, solo para MOSTRAR. El total del carro NO se calcula
// sumando esto: el bot suma netos y aplica el IVA una sola vez (ver carro.ts).
export function precioTiendaClp(costoUsd: number, cfg: CfgPrecios): number {
  return conIvaClp(ventaNetaClp(costoUsd, cfg), cfg);
}

// Inversa para el filtro precio_max de la API (que espera costo en USD).
export function costoMaxUsd(precioTienda: number, cfg: CfgPrecios): number {
  return precioTienda / (1 + cfg.iva) / (1 + cfg.margen) / cfg.tipoCambio;
}

export function formatCLP(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CL');
}
