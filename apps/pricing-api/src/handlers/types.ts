import type { VercelRequest, VercelResponse } from '@vercel/node';

export type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

// La implementacion real vive en @rr/http; se re-exporta para no tocar el
// import de cada handler (`import { firstString, type Handler } from './types.js'`).
export { firstString } from '@rr/http/http';
