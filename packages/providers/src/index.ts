import type { Provider } from '@rr/domain/types';
import { ingram } from './ingram.js';
import { intcomex } from './intcomex.js';
import { tecnoglobal } from './tecnoglobal.js';

// Agregar un proveedor es escribir su modulo y sumarlo aca: las rutas, el
// catalogo por proveedor y el refresco salen de este objeto.
export const PROVIDERS: Record<string, Provider> = { intcomex, tecnoglobal, ingram };

export function resolveProvider(nombre: string | undefined): Provider | null {
  return (nombre && PROVIDERS[nombre]) || null;
}
