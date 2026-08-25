import { crearHandlerBusqueda } from '../lib/handlers/busqueda.js';
import { PROVEEDORES } from '../lib/providers/index.js';

// Alias historico: el agente Rayo apunta aca y no debe enterarse del cambio.
export default crearHandlerBusqueda(PROVEEDORES.intcomex);
