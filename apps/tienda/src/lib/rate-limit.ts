// Limite de confirmaciones por IP, en memoria del proceso. Best-effort en
// serverless (cada instancia su mapa) — decision del spec, aceptada: la
// proteccion de fondo es que nada se factura automaticamente.
const VENTANA_MS = 10 * 60 * 1000;
const MAX_POR_VENTANA = 5;
const golpes = new Map<string, number[]>();

export function _limpiarRateLimit(): void {
  golpes.clear();
}

export function permitir(ip: string, ahoraMs: number): boolean {
  const recientes = (golpes.get(ip) ?? []).filter((t) => ahoraMs - t < VENTANA_MS);
  if (recientes.length >= MAX_POR_VENTANA) {
    golpes.set(ip, recientes);
    return false;
  }
  recientes.push(ahoraMs);
  golpes.set(ip, recientes);
  return true;
}
