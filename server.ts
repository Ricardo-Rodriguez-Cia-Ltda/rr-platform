import { cargarCatalogo } from '@rr/domain/catalog';
import { PROVEEDORES } from './lib/providers/index.js';
import { MENSAJE_CUOTA } from './lib/providers/tecnoglobal.js';
import { proveedoresConfigurados, refrescarTodos } from '@rr/domain/refresh';
import { createApp } from './lib/server.js';

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
