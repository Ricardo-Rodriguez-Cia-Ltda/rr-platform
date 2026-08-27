import { createSearchHandler } from '../src/handlers/search.js';
import { PROVIDERS } from '@rr/providers';

// Alias historico: el agente Rayo apunta aca y no debe enterarse del cambio.
export default createSearchHandler(PROVIDERS.intcomex);
