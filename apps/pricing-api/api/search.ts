import { createMultiSearchHandler } from '../src/handlers/search-multi.js';
import { PROVIDERS } from '@rr/providers';

// /search compara los tres mayoristas y muestra el mismo ganador que elige la
// cotizacion (/mejor-precio). La busqueda de un solo mayorista sigue en
// /{proveedor}/search.
export default createMultiSearchHandler(PROVIDERS);
