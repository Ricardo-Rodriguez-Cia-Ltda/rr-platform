import type { Proveedor } from '@rr/domain/types';
import { ingram } from './ingram.js';
import { intcomex } from './intcomex.js';
import { tecnoglobal } from './tecnoglobal.js';

// Agregar un proveedor es escribir su modulo y sumarlo aca: las rutas, el
// catalogo por proveedor y el refresco salen de este objeto.
export const PROVEEDORES: Record<string, Proveedor> = { intcomex, tecnoglobal, ingram };

export function resolverProveedor(nombre: string | undefined): Proveedor | null {
  return (nombre && PROVEEDORES[nombre]) || null;
}
