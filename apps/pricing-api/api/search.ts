import { crearHandlerBusqueda } from '../src/handlers/search.js';
import { PROVEEDORES } from '@rr/providers';

// Alias historico: el agente Rayo apunta aca y no debe enterarse del cambio.
export default crearHandlerBusqueda(PROVEEDORES.intcomex);
