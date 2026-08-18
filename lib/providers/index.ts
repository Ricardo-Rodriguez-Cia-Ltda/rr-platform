import type { Proveedor } from '../types.js';
import { intcomex } from './intcomex.js';
import { tecnoglobal } from './tecnoglobal.js';

// Ingram entra aca cuando su modulo exista.
export const PROVEEDORES: Record<string, Proveedor> = { intcomex, tecnoglobal };

export function resolverProveedor(nombre: string | undefined): Proveedor | null {
  return (nombre && PROVEEDORES[nombre]) || null;
}
