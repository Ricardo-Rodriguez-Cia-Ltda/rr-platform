import type { Proveedor } from '../types.js';
import { intcomex } from './intcomex.js';

// Ingram y Tecnoglobal entran aca cuando sus modulos existan.
export const PROVEEDORES: Record<string, Proveedor> = { intcomex };

export function resolverProveedor(nombre: string | undefined): Proveedor | null {
  return (nombre && PROVEEDORES[nombre]) || null;
}
