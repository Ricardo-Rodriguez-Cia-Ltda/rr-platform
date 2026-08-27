/**
 * Refresca los catalogos de varios proveedores a la vez.
 *
 * allSettled y no all: un proveedor caido no puede cancelar la carga de los
 * otros. El error de cada uno se reporta por separado y la promesa nunca
 * rechaza, porque el llamador es un temporizador de fondo sin nadie que
 * atrape la excepcion.
 */
export async function refreshAll(
  names: string[],
  load: (proveedor: string) => Promise<unknown[]>,
  onFailure: (proveedor: string, error: unknown) => void = () => {},
): Promise<void> {
  const results = await Promise.allSettled(
    names.map(async (nombre) => {
      const productos = await load(nombre);
      console.log(`[catalog] ${nombre}: ${productos.length} productos disponibles`);
    }),
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[catalog] ${names[i]}: no se pudo cargar`, result.reason);
      onFailure(names[i], result.reason);
    }
  });
}

/**
 * Nombres de los proveedores que tienen credenciales.
 *
 * Un proveedor sin configurar no es una falla que valga la pena reintentar:
 * va a fallar igual dentro de 5 minutos. Se lo deja fuera del refresco y sus
 * rutas responden `proveedor_no_configurado`, que dice exactamente que pasa.
 */
export function configuredProviders(
  registry: Record<string, { isConfigured(): boolean }>,
): string[] {
  return Object.entries(registry)
    .filter(([, proveedor]) => proveedor.isConfigured())
    .map(([nombre]) => nombre);
}
