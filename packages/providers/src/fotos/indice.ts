import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unionKey, type NormalizedProduct } from '@rr/domain/product';

// El indice del banco de fotos: que clave tiene foto, de donde salio, y que
// claves se intentaron sin exito (y por que). Ver
// docs/superpowers/specs/2026-09-23-banco-fotos-design.md.

export type FuenteFoto = 'intcomex' | 'icecat';
export type MotivoSinFoto = 'no_encontrado' | 'icecat_full' | 'descarga_fallida';

export interface EntradaFoto { url: string; fuente: FuenteFoto; obtenidaEn: string }
export interface EntradaSinFoto { motivo: MotivoSinFoto; intentadoEn: string }
export interface IndiceFotos {
  actualizadoEn: string;
  fotos: Record<string, EntradaFoto>;
  sinFoto: Record<string, EntradaSinFoto>;
}

function cacheDir(): string {
  return process.env.CATALOG_CACHE_DIR ?? 'cache';
}

export function rutaIndice(): string {
  return join(cacheDir(), 'fotos.json');
}

export function indiceVacio(): IndiceFotos {
  return { actualizadoEn: new Date(0).toISOString(), fotos: {}, sinFoto: {} };
}

export function leerIndice(ruta: string = rutaIndice()): IndiceFotos {
  try {
    const raw = JSON.parse(readFileSync(ruta, 'utf8')) as Partial<IndiceFotos>;
    return {
      actualizadoEn: typeof raw.actualizadoEn === 'string' ? raw.actualizadoEn : indiceVacio().actualizadoEn,
      fotos: raw.fotos && typeof raw.fotos === 'object' ? raw.fotos : {},
      sinFoto: raw.sinFoto && typeof raw.sinFoto === 'object' ? raw.sinFoto : {},
    };
  } catch (error) {
    // Ausente o corrupto: se parte vacio. Jamas es fatal, pero corrupto se
    // registra: significa que la tienda quedo sin fotos hasta la proxima corrida.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`[fotos] indice ilegible en ${ruta}; se usa vacio`, error);
    }
    return indiceVacio();
  }
}

export function guardarIndice(indice: IndiceFotos, ruta: string = rutaIndice()): void {
  mkdirSync(dirname(ruta), { recursive: true });
  // Temporal por pid + rename, como price-cache.ts: el servidor lee este
  // archivo mientras el recolector lo escribe, y jamas debe ver uno a medias.
  const tmp = `${ruta}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...indice, actualizadoEn: new Date().toISOString() }));
  renameSync(tmp, ruta);
}

// Lectura para la API: el indice cambia a lo sumo una vez por corrida, asi
// que basta revisar la fecha del archivo una vez por minuto.
const REVISION_MS = 60 * 1000;
let cargado: { mtimeMs: number; fotos: Record<string, EntradaFoto> } | null = null;
let revisadoEn = 0;

function fotosVigentes(): Record<string, EntradaFoto> {
  const ahora = Date.now();
  if (cargado && ahora - revisadoEn < REVISION_MS) return cargado.fotos;
  revisadoEn = ahora;
  try {
    const mtimeMs = statSync(rutaIndice()).mtimeMs;
    if (!cargado || cargado.mtimeMs !== mtimeMs) {
      cargado = { mtimeMs, fotos: leerIndice().fotos };
    }
  } catch {
    cargado = { mtimeMs: -1, fotos: {} };
  }
  return cargado.fotos;
}

export function fotoDe(producto: NormalizedProduct): string | null {
  const clave = unionKey(producto);
  if (!clave) return null;
  return fotosVigentes()[clave]?.url ?? null;
}

export function _resetFotosForTests(): void {
  cargado = null;
  revisadoEn = 0;
}
