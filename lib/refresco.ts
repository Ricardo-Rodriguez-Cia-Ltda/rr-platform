/**
 * Refresca los catalogos de varios proveedores a la vez.
 *
 * allSettled y no all: un proveedor caido no puede cancelar la carga de los
 * otros. El error de cada uno se reporta por separado y la promesa nunca
 * rechaza, porque el llamador es un temporizador de fondo sin nadie que
 * atrape la excepcion.
 */
export async function refrescarTodos(
  nombres: string[],
  cargar: (proveedor: string) => Promise<unknown[]>,
  alFallar: (proveedor: string) => void = () => {},
): Promise<void> {
  const resultados = await Promise.allSettled(
    nombres.map(async (nombre) => {
      const productos = await cargar(nombre);
      console.log(`[catalog] ${nombre}: ${productos.length} productos disponibles`);
    }),
  );

  resultados.forEach((resultado, i) => {
    if (resultado.status === 'rejected') {
      console.error(`[catalog] ${nombres[i]}: no se pudo cargar`, resultado.reason);
      alFallar(nombres[i]);
    }
  });
}
