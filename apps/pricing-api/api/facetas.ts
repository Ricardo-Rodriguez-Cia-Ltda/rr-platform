import { createFacetsHandler } from '../src/handlers/facets.js';
import { PROVIDERS } from '@rr/providers';

// Alias historico: el agente Rayo apunta aca y no debe enterarse del cambio.
export default createFacetsHandler(PROVIDERS.intcomex);
