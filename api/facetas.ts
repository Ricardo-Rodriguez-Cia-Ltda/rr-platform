import { crearHandlerFacetas } from '../lib/handlers/facetas.js';
import { PROVEEDORES } from '@rr/providers';

// Alias historico: el agente Rayo apunta aca y no debe enterarse del cambio.
export default crearHandlerFacetas(PROVEEDORES.intcomex);
