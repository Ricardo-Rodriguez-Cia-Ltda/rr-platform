import type { Proveedor } from '../types.js';
import { intcomex } from './intcomex.js';

// Ingram y Tecnoglobal entran aca cuando sus modulos existan.
export const PROVEEDORES: Record<string, Proveedor> = { intcomex };
