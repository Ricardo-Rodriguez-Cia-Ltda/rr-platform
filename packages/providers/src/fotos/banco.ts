import { unionKey, type NormalizedProduct } from '@rr/domain/product';
import type { FuenteFoto, IndiceFotos, MotivoSinFoto } from './indice.js';
import type { ResultadoIcecat } from './icecat.js';

// Orquestador del banco de fotos. Recibe todo lo que toca red o disco como
// dependencia, asi se prueba sin red. Reglas en
// docs/superpowers/specs/2026-09-23-banco-fotos-design.md.

export interface ProductoBanco {
  clave: string; mpn: string; marca: string; nombre: string; proveedores: string[]; conStock: boolean;
}
export interface Descarga { bytes: Uint8Array; contentType: string }

export interface DepsBanco {
  productos: ProductoBanco[];
  indice: IndiceFotos;
  guardar(indice: IndiceFotos): void;
  fotosIntcomex(): Promise<Map<string, string>>;
  icecat: ((mpn: string, marca: string) => Promise<ResultadoIcecat>) | null;
  descargar(url: string): Promise<Descarga | null>;
  subir(ruta: string, bytes: Uint8Array, contentType: string): Promise<string>;
  ahora?: () => Date;
  limite?: number;
  concurrencia?: number;
}

export interface ResumenBanco {
  procesados: number;
  nuevas: Record<FuenteFoto, number>;
  sinFoto: Record<MotivoSinFoto, number>;
  pendientes: number;
  intcomexCaido: boolean;
}

export const REINTENTO_MS = 30 * 24 * 60 * 60 * 1000;
export const GUARDAR_CADA = 200;
const MIN_BYTES = 2 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
const TIPOS = ['image/jpeg', 'image/png', 'image/webp'];

function tipoBase(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

export function imagenValida(contentType: string, bytes: number): boolean {
  return TIPOS.includes(tipoBase(contentType)) && bytes >= MIN_BYTES && bytes <= MAX_BYTES;
}

export function extension(contentType: string): 'jpg' | 'png' | 'webp' {
  const t = tipoBase(contentType);
  return t === 'image/png' ? 'png' : t === 'image/webp' ? 'webp' : 'jpg';
}

export function rutaFoto(clave: string, contentType: string): string {
  const [mpn, marca] = clave.split('|');
  return `${marca}/${mpn}.${extension(contentType)}`;
}

export function productosDesdeCatalogos(
  catalogos: Record<string, NormalizedProduct[]>,
  conStock: (proveedor: string, sku: string) => boolean,
): ProductoBanco[] {
  const porClave = new Map<string, ProductoBanco>();
  for (const [proveedor, productos] of Object.entries(catalogos)) {
    for (const p of productos) {
      const clave = unionKey(p);
      if (!clave || !p.mpn || !p.marca) continue;
      let e = porClave.get(clave);
      if (!e) {
        e = { clave, mpn: p.mpn, marca: p.marca, nombre: p.nombre ?? '', proveedores: [], conStock: false };
        porClave.set(clave, e);
      }
      if (!e.proveedores.includes(proveedor)) e.proveedores.push(proveedor);
      if (conStock(proveedor, p.sku)) e.conStock = true;
    }
  }
  return [...porClave.values()];
}

// Prioridad para procesar y para la lista de faltantes: lo que se puede
// vender hoy primero, despues lo que mas mayoristas ofrecen.
function prioridad(a: ProductoBanco, b: ProductoBanco): number {
  if (a.conStock !== b.conStock) return a.conStock ? -1 : 1;
  return b.proveedores.length - a.proveedores.length;
}

type Resultado =
  | { tipo: 'foto'; url: string; fuente: FuenteFoto }
  | { tipo: 'sin_foto'; motivo: MotivoSinFoto }
  | { tipo: 'pendiente' };

export async function actualizarBancoFotos(deps: DepsBanco): Promise<ResumenBanco> {
  const ahora = deps.ahora ?? (() => new Date());
  const { indice } = deps;
  const resumen: ResumenBanco = {
    procesados: 0,
    nuevas: { intcomex: 0, icecat: 0 },
    sinFoto: { no_encontrado: 0, icecat_full: 0, descarga_fallida: 0 },
    pendientes: 0,
    intcomexCaido: false,
  };

  const inicio = ahora().getTime();
  let pendientes = deps.productos
    .filter((p) => !indice.fotos[p.clave])
    .filter((p) => {
      const previo = indice.sinFoto[p.clave];
      if (!previo) return true;
      const transcurrido = inicio - new Date(previo.intentadoEn).getTime();
      // Una fecha que no se puede interpretar (NaN) se trata como vencida: mejor
      // reintentar de mas que dejar una clave bloqueada para siempre.
      return Number.isNaN(transcurrido) || transcurrido >= REINTENTO_MS;
    })
    .sort(prioridad);
  if (deps.limite !== undefined) pendientes = pendientes.slice(0, deps.limite);

  let deIntcomex = new Map<string, string>();
  try {
    deIntcomex = await deps.fotosIntcomex();
  } catch (error) {
    resumen.intcomexCaido = true;
    console.error('[fotos] no se pudo bajar el catalogo extendido de Intcomex; se sigue con Icecat', error);
  }

  // Descarga, valida y sube. null = la imagen no sirvio. Un fallo del storage
  // lanza: no tiene sentido seguir descargando fotos que no se pueden guardar.
  const guardarFoto = async (clave: string, url: string): Promise<string | null> => {
    const d = await deps.descargar(url).catch(() => null);
    if (!d || !imagenValida(d.contentType, d.bytes.byteLength)) return null;
    return deps.subir(rutaFoto(clave, d.contentType), d.bytes, tipoBase(d.contentType));
  };

  const resolver = async (p: ProductoBanco): Promise<Resultado> => {
    let hayCandidata = false;
    const urlIntcomex = deIntcomex.get(p.clave);
    if (urlIntcomex) {
      hayCandidata = true;
      const url = await guardarFoto(p.clave, urlIntcomex);
      if (url) return { tipo: 'foto', url, fuente: 'intcomex' };
    }
    let motivoIcecat: MotivoSinFoto = 'no_encontrado';
    if (deps.icecat) {
      const r = await deps.icecat(p.mpn, p.marca);
      if ('reintentar' in r) return { tipo: 'pendiente' };
      if ('url' in r) {
        hayCandidata = true;
        const url = await guardarFoto(p.clave, r.url);
        if (url) return { tipo: 'foto', url, fuente: 'icecat' };
      } else {
        motivoIcecat = r.motivo;
      }
    }
    // Con Intcomex caido ningun veredicto de "sin foto" es confiable: puede
    // tener foto alla. No se descarta por 30 dias por una corrida a medias.
    if (resumen.intcomexCaido) return { tipo: 'pendiente' };
    if (hayCandidata) return { tipo: 'sin_foto', motivo: 'descarga_fallida' };
    return { tipo: 'sin_foto', motivo: motivoIcecat };
  };

  const registrar = (p: ProductoBanco, r: Resultado): void => {
    const cuando = ahora().toISOString();
    if (r.tipo === 'foto') {
      indice.fotos[p.clave] = { url: r.url, fuente: r.fuente, obtenidaEn: cuando };
      delete indice.sinFoto[p.clave];
      resumen.nuevas[r.fuente]++;
    } else if (r.tipo === 'sin_foto') {
      indice.sinFoto[p.clave] = { motivo: r.motivo, intentadoEn: cuando };
      resumen.sinFoto[r.motivo]++;
    } else {
      resumen.pendientes++;
    }
    resumen.procesados++;
    if (resumen.procesados % GUARDAR_CADA === 0) deps.guardar(indice);
  };

  let siguiente = 0;
  let abortado = false;
  let primerError: unknown;
  const trabajador = async (): Promise<void> => {
    while (!abortado && siguiente < pendientes.length) {
      const p = pendientes[siguiente++];
      try {
        registrar(p, await resolver(p));
      } catch (error) {
        // Un fallo del storage termina la corrida: no tiene sentido seguir
        // gastando red en fotos que no se van a poder guardar. Se avisa a los
        // demas trabajadores para que no tomen items nuevos, pero se deja que
        // el item en vuelo de cada uno termine antes de guardar y relanzar.
        if (!abortado) primerError = error;
        abortado = true;
        throw error;
      }
    }
  };

  await Promise.allSettled(Array.from({ length: deps.concurrencia ?? 4 }, trabajador));
  if (primerError) {
    deps.guardar(indice);
    throw primerError;
  }
  if (resumen.procesados % GUARDAR_CADA !== 0 || resumen.procesados === 0) deps.guardar(indice);
  return resumen;
}

function celda(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

export function csvFaltantes(productos: ProductoBanco[], indice: IndiceFotos): string {
  const filas = productos
    .filter((p) => !indice.fotos[p.clave])
    .sort(prioridad)
    .map((p) => [
      p.clave, p.mpn, p.marca, p.nombre, p.proveedores.join(' '),
      p.conStock ? 'si' : 'no', indice.sinFoto[p.clave]?.motivo ?? 'pendiente',
    ].map(celda).join(','));
  return ['clave,mpn,marca,nombre,proveedores,con_stock,motivo', ...filas].join('\n');
}
