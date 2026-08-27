import { fileURLToPath } from 'node:url';

// El caché vive en la raíz del repositorio, no dentro de la app: los tres
// catalogos se comparten y bajarlos de nuevo cuesta cuota en Tecnoglobal.
process.env.CATALOG_CACHE_DIR ??= fileURLToPath(new URL('../../cache', import.meta.url));

import { cargarCatalogo } from '@rr/providers/catalog';
import { PROVEEDORES } from '@rr/providers';
import { MENSAJE_CUOTA } from '@rr/providers/tecnoglobal';
import { proveedoresConfigurados, refrescarTodos } from '@rr/domain/refresh';
import { createApp } from './src/app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection', reason);
});

createApp().listen(port, host, () => {
  console.log(`price-fetcher API listening on http://${host}:${port}`);
});

// El catalogo se carga en segundo plano: el servidor ya responde (con 503 en
// las rutas que lo necesitan) mientras la primera descarga termina.
const REFRESCO_MS = 24 * 60 * 60 * 1000;

const REINTENTO_MS = 5 * 60 * 1000;

// Cuando el proveedor nos rechazo por cuota, insistir cada 5 minutos es la
// forma mas segura de seguir rechazados: varios limitadores extienden la
// ventana con cada intento fallido.
const REINTENTO_CUOTA_MS = 30 * 60 * 1000;

function esCuotaAgotada(error: unknown): boolean {
  return error instanceof Error && error.message.includes(MENSAJE_CUOTA);
}

// El reintento se agenda solo para el proveedor que fallo: reintentar los tres
// porque uno se cayo multiplica llamadas a proveedores que ya respondieron bien.
function reintentar(proveedor: string, error: unknown): void {
  const espera = esCuotaAgotada(error) ? REINTENTO_CUOTA_MS : REINTENTO_MS;
  console.log(`[catalog] ${proveedor}: reintento en ${Math.round(espera / 60000)} min`);
  setTimeout(() => {
    void refrescarTodos([proveedor], cargarCatalogo, reintentar);
  }, espera).unref();
}

function refrescar(): void {
  const nombres = proveedoresConfigurados(PROVEEDORES);
  const pendientes = Object.keys(PROVEEDORES).filter((n) => !nombres.includes(n));
  if (pendientes.length > 0) {
    console.log(`[catalog] sin credenciales, no se refrescan: ${pendientes.join(', ')}`);
  }
  void refrescarTodos(nombres, cargarCatalogo, reintentar);
}

refrescar();
setInterval(refrescar, REFRESCO_MS).unref();
