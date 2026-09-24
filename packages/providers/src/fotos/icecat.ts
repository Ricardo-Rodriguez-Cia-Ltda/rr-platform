// Open Icecat: catalogo abierto de fichas por marca + part number. Cubre ~40%
// de lo que Intcomex no tiene; otro ~15% son marcas "Full Icecat" (de pago),
// que responden 403. Cuenta de Pyxis: pyxis.latam (no exige token ni IP).

export type ResultadoIcecat =
  | { url: string }
  | { motivo: 'no_encontrado' | 'icecat_full' }
  | { reintentar: true };

const API = 'https://live.icecat.biz/api';
const TIMEOUT_MS = 20000;

interface RespuestaIcecat { data?: { Image?: { Pic500x500?: unknown; HighPic?: unknown } } }

export function crearIcecat(usuario: string, fetchImpl: typeof fetch = fetch) {
  return async function buscar(mpn: string, marca: string): Promise<ResultadoIcecat> {
    const url = new URL(API);
    url.searchParams.set('UserName', usuario);
    url.searchParams.set('Language', 'es');
    // Icecat conoce al fabricante por su nombre corto; el catalogo le pega la
    // unidad de negocio ("EPSON COMMERCIAL HW"), igual que en canonicalBrand.
    url.searchParams.set('Brand', marca.trim().split(/\s+/)[0] ?? '');
    // El sufijo regional de HP (#ABM) no existe en Icecat.
    url.searchParams.set('ProductCode', mpn.replace(/#.*$/, '').trim());

    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return { reintentar: true };
    }
    if (res.status === 404) return { motivo: 'no_encontrado' };
    if (res.status === 403) return { motivo: 'icecat_full' };
    if (!res.ok) return { reintentar: true };

    const body = (await res.json().catch(() => ({}))) as RespuestaIcecat;
    const img = body.data?.Image;
    const elegida = [img?.Pic500x500, img?.HighPic].find(
      (u): u is string => typeof u === 'string' && u.startsWith('https://'),
    );
    return elegida ? { url: elegida } : { motivo: 'no_encontrado' };
  };
}
