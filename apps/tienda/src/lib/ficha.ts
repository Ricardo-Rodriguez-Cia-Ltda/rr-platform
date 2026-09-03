/**
 * Los nombres del catalogo mayorista son fichas tecnicas disfrazadas de titulo:
 *
 *   "HP 240 G5 - Core i5 6200U / 2.3 GHz - FreeDOS 2.0 - 4 GB RAM - 1 TB HDD -
 *    14\" 1366 x 768 (HD) - HD Graphics 520 - negro (teclado), ceniza oscura"
 *
 * Mostrarlos crudos da un parrafo ilegible; esta funcion los separa en lo que
 * ya eran: un identificador, un punado de datos medibles, y el resto. La tienda
 * no tiene fotos — la ficha ES la imagen del producto.
 *
 * Todo lo que no calza con un patron conocido cae al detalle en vez de
 * inventarse: mas vale una ficha corta que una ficha equivocada.
 */
export interface Ficha {
  /** Primer segmento del nombre: "HP 240 G5". */
  titulo: string;
  /** Datos medibles, en orden fijo (CPU, RAM, disco, pantalla). Maximo 4. */
  specs: string[];
  /** El resto del nombre, para quien quiera leer todo. */
  detalle: string;
}

const MAX_SPECS = 4;

// Orden fijo: es el orden en que un tecnico lee una maquina, y hace que dos
// fichas distintas se puedan comparar de un vistazo columna a columna.
const PATRONES: RegExp[] = [
  /\b(?:Intel\s+)?Core\s+(i[3579])\b/i,
  /\b(Ryzen\s+[3579])\b/i,
  /\b(Celeron|Pentium|Athlon|Snapdragon|Xeon)\b/i,
  // Los dos ordenes en que el catalogo escribe la memoria: "4 GB RAM" y
  // "RAM 2 GB" (los mayoristas no se ponen de acuerdo).
  /\b(\d{1,3})\s?GB\s+RAM\b/i,
  /\bRAM\s+(\d{1,3})\s?GB\b/i,
  /\b(\d{1,2})\s?(TB|GB)\s+(SSD|HDD|eMMC|NVMe)\b/i,
  // El decimal lleva hasta dos digitos y el numero va anclado: sin el ancla,
  // un 6.53" se leia como 53" (el motor hacia backtracking hasta calzar).
  /(?<![\d.,])(\d{1,2}(?:[.,]\d{1,2})?)\s?["”]/,
];

function limpiar(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function spec(nombre: string, patron: RegExp): string | null {
  const m = patron.exec(nombre);
  if (!m) return null;

  const fuente = patron.source;
  if (fuente.includes('Core')) return `Core ${m[1].toLowerCase()}`;
  if (fuente.includes('RAM')) return `${m[1]} GB RAM`;
  if (fuente.includes('SSD')) return `${m[1]} ${m[2].toUpperCase()} ${m[3].toUpperCase()}`;
  if (fuente.includes('"')) return `${m[1]}"`;
  return limpiar(m[1]);
}

export function leerFicha(nombre: string, marca?: string | null): Ficha {
  const limpio = limpiar(nombre ?? '');
  if (limpio === '') return { titulo: '', specs: [], detalle: '' };

  const partes = limpio.split(' - ').map(limpiar).filter((p) => p !== '');

  // Varios nombres empiezan con la marca sola ("Nexxt - Cable de
  // interconexion - ..."). Como la ficha ya muestra la marca arriba, repetirla
  // de titulo deja la tarjeta sin decir QUE es el producto: en ese caso el
  // titulo pasa al segmento siguiente. Solo si el segmento es SOLO la marca —
  // "HP 240 G5" se queda como esta.
  // La comparacion es contra la marca completa Y contra su primera palabra: el
  // catalogo dice "Nexxt Solutions Infrastructure" donde el nombre del producto
  // abrevia "Nexxt". Es la misma regla de primera palabra con que el repo une
  // marcas entre mayoristas. Un segmento de varias palabras ("HP 240 G5") no
  // se salta nunca: ahi el modelo es el titulo.
  const marcaLimpia = limpiar(marca ?? '').toLowerCase();
  const primeraPalabra = marcaLimpia.split(' ')[0] ?? '';
  const primerSegmento = (partes[0] ?? '').toLowerCase();
  const esSoloLaMarca =
    marcaLimpia !== '' &&
    (primerSegmento === marcaLimpia || (!primerSegmento.includes(' ') && primerSegmento === primeraPalabra));
  const desde = esSoloLaMarca && partes.length > 1 ? 1 : 0;

  const titulo = partes[desde] ?? '';
  const detalle = partes.slice(desde + 1).join(' · ');

  const specs: string[] = [];
  for (const patron of PATRONES) {
    if (specs.length >= MAX_SPECS) break;
    const valor = spec(limpio, patron);
    // Una sola CPU: los tres primeros patrones son alternativas del mismo dato.
    if (valor && !specs.includes(valor)) specs.push(valor);
  }

  return { titulo, specs, detalle };
}
