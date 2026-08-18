import { cargarCatalogo } from './lib/catalog.js';
import { PROVEEDORES } from './lib/providers/index.js';
import { refrescarTodos } from './lib/refresco.js';
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

// El reintento se agenda solo para el proveedor que fallo: reintentar los tres
// porque uno se cayo multiplica llamadas a proveedores que ya respondieron bien.
function reintentar(proveedor: string): void {
  setTimeout(() => {
    void refrescarTodos([proveedor], cargarCatalogo, reintentar);
  }, REINTENTO_MS).unref();
}

void refrescarTodos(Object.keys(PROVEEDORES), cargarCatalogo, reintentar);
setInterval(() => {
  void refrescarTodos(Object.keys(PROVEEDORES), cargarCatalogo, reintentar);
}, REFRESCO_MS).unref();
