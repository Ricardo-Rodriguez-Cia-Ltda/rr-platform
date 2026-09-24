import { fileURLToPath } from 'node:url';

// Mismo cache que server.ts: la raiz del repo.
process.env.CATALOG_CACHE_DIR ??= fileURLToPath(new URL('../../../cache', import.meta.url));

import { loadCatalog } from '@rr/providers/catalog';
import { PROVIDERS } from '@rr/providers';
import { configuredProviders } from '@rr/domain/refresh';
import { correrBancoFotos } from '@rr/providers/fotos/correr';
import type { NormalizedProduct } from '@rr/domain/product';

// Uso: npm run fotos             -> corrida completa (la primera tarda horas)
//      npm run fotos -- 200      -> solo las 200 claves pendientes de mas prioridad
const limite = process.argv[2] ? Number(process.argv[2]) : undefined;
if (limite !== undefined && !(Number.isInteger(limite) && limite > 0)) {
  console.error('El argumento debe ser un entero positivo (tope de productos).');
  process.exit(1);
}

const catalogos: Record<string, NormalizedProduct[]> = {};
for (const nombre of configuredProviders(PROVIDERS)) {
  try {
    catalogos[nombre] = await loadCatalog(nombre);
  } catch (error) {
    console.error(`[fotos] ${nombre}: sin catalogo, queda fuera de esta corrida`, error);
  }
}

await correrBancoFotos(catalogos, { limite });
