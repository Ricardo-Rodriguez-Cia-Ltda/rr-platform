import { cargarCatalogo } from './lib/catalog.js';
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

async function refrescarCatalogo(): Promise<void> {
  try {
    const productos = await cargarCatalogo();
    console.log(`[catalog] ${productos.length} productos disponibles`);
  } catch (error) {
    console.error('[catalog] no se pudo cargar, reintento en 5 min', error);
    setTimeout(() => void refrescarCatalogo(), REINTENTO_MS).unref();
  }
}

void refrescarCatalogo();
setInterval(() => void refrescarCatalogo(), REFRESCO_MS).unref();
