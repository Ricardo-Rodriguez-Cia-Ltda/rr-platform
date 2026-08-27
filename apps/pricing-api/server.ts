import { fileURLToPath } from 'node:url';

// El caché vive en la raíz del repositorio, no dentro de la app: los tres
// catalogos se comparten y bajarlos de nuevo cuesta cuota en Tecnoglobal.
process.env.CATALOG_CACHE_DIR ??= fileURLToPath(new URL('../../cache', import.meta.url));

import { loadCatalog } from '@rr/providers/catalog';
import { PROVIDERS } from '@rr/providers';
import { QUOTA_MESSAGE } from '@rr/providers/tecnoglobal';
import { configuredProviders, refreshAll } from '@rr/domain/refresh';
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
const REFRESH_MS = 24 * 60 * 60 * 1000;

const RETRY_MS = 5 * 60 * 1000;

// Cuando el proveedor nos rechazo por cuota, insistir cada 5 minutos es la
// forma mas segura de seguir rechazados: varios limitadores extienden la
// ventana con cada intento fallido.
const QUOTA_RETRY_MS = 30 * 60 * 1000;

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof Error && error.message.includes(QUOTA_MESSAGE);
}

// El reintento se agenda solo para el proveedor que fallo: reintentar los tres
// porque uno se cayo multiplica llamadas a proveedores que ya respondieron bien.
function retry(provider: string, error: unknown): void {
  const delay = isQuotaExceeded(error) ? QUOTA_RETRY_MS : RETRY_MS;
  console.log(`[catalog] ${provider}: reintento en ${Math.round(delay / 60000)} min`);
  setTimeout(() => {
    void refreshAll([provider], loadCatalog, retry);
  }, delay).unref();
}

function refresh(): void {
  const names = configuredProviders(PROVIDERS);
  const pending = Object.keys(PROVIDERS).filter((n) => !names.includes(n));
  if (pending.length > 0) {
    console.log(`[catalog] sin credenciales, no se refrescan: ${pending.join(', ')}`);
  }
  void refreshAll(names, loadCatalog, retry);
}

refresh();
setInterval(refresh, REFRESH_MS).unref();
