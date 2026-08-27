import { crearHandlerProducto } from '../lib/handlers/producto.js';
import { PROVEEDORES } from '@rr/providers';

// Alias historico: el agente Rayo apunta aca y no debe enterarse del cambio.
export default crearHandlerProducto(PROVEEDORES.intcomex);
