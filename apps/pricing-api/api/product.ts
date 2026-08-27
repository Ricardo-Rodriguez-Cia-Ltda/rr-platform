import { createProductHandler } from '../src/handlers/product.js';
import { PROVIDERS } from '@rr/providers';

// Alias historico: el agente Rayo apunta aca y no debe enterarse del cambio.
export default createProductHandler(PROVIDERS.intcomex);
