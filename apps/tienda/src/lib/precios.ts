// Conversion costo->venta IDENTICA a la del bot (buscar-productos-v2):
// la pricing-api entrega COSTOS del mayorista en USD; lo que ve el cliente
// es venta con margen, en CLP, con IVA. Si esta formula divergiera de la del
// bot, los dos canales mostrarian precios distintos para el mismo producto.
export interface CfgPrecios { margen: number; tipoCambio: number; iva: number }

export function cfgPrecios(): CfgPrecios | null {
  const margen = Number(process.env.MARGEN ?? '');
  const tipoCambio = Number(process.env.TIPO_CAMBIO_CLP_USD ?? '');
  const iva = Number(process.env.IVA_RATE ?? '');
  if (![margen, tipoCambio, iva].every(Number.isFinite)) return null;
  if (margen <= 0 || tipoCambio <= 0 || iva < 0) return null; // margen 0 = vender a costo
  return { margen, tipoCambio, iva };
}

export function ventaNetaClp(costoUsd: number, cfg: CfgPrecios): number {
  return Math.round(costoUsd * (1 + cfg.margen) * cfg.tipoCambio);
}

export function precioTiendaClp(costoUsd: number, cfg: CfgPrecios): number {
  return Math.round(ventaNetaClp(costoUsd, cfg) * (1 + cfg.iva));
}

// Inversa para el filtro precio_max de la API (que espera costo en USD).
export function costoMaxUsd(precioTienda: number, cfg: CfgPrecios): number {
  return precioTienda / (1 + cfg.iva) / (1 + cfg.margen) / cfg.tipoCambio;
}

export function formatCLP(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CL');
}
