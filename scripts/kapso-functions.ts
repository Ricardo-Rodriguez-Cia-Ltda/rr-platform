import { readFileSync } from 'node:fs';
import { kapso } from './kapso.js';

interface Funcion { id: string; name: string; }
interface FuncionEstado { id: string; status: string; }
interface Secreto { name: string; type?: string; }

// El POST /deploy responde antes de que Kapso termine de propagar el estado
// "deployed" (se confirmo en la practica: justo despues de un deploy exitoso,
// /secrets todavia respondia "Function must be deployed"). Se espera a que
// el GET confirme el estado antes de intentar los secretos, con un tope de
// espera para no colgar el script si algo quedo atascado de verdad.
async function esperarDespliegue(id: string, intentos = 10, esperaMs = 1500): Promise<boolean> {
  for (let i = 0; i < intentos; i++) {
    const { data } = await kapso<{ data: FuncionEstado }>(`/functions/${id}`);
    if (data.status === 'deployed') return true;
    await new Promise((resolve) => setTimeout(resolve, esperaMs));
  }
  return false;
}

// La API de Kapso no tiene PUT ni PATCH de secretos: `POST /secrets` exige que
// el nombre sea unico dentro de la function (lo rechaza si ya existe, no lo
// sobrescribe) y `DELETE /secrets/{name}` borra por nombre. `GET /secrets`
// devuelve solo `{name, type}`, nunca valores. Consecuencia: cambiar el valor
// de un secreto es borrarlo y crearlo de nuevo, y lo unico verificable despues
// es que el nombre este presente.
async function nombresDeSecretos(id: string): Promise<Set<string>> {
  const { data } = await kapso<{ data: Secreto[] }>(`/functions/${id}/secrets`);
  return new Set((data ?? []).map((s) => s.name));
}

async function cargarSecreto(id: string, nombre: string, valor: string): Promise<void> {
  await kapso(`/functions/${id}/secrets`, { metodo: 'POST', cuerpo: { secret: { name: nombre, value: valor } } });
}

// Devuelve que se hizo, para que el resumen pueda decir la verdad. Si el
// secreto ya existia hay una ventana entre el DELETE y el POST en la que la
// function se queda sin el: por eso el llamador verifica al final con un GET y
// grita si algun nombre no volvio.
async function sincronizarSecreto(
  id: string,
  nombre: string,
  valor: string,
  existentes: Set<string>,
): Promise<'creado' | 'reemplazado'> {
  if (!existentes.has(nombre)) {
    await cargarSecreto(id, nombre, valor);
    return 'creado';
  }
  await kapso(`/functions/${id}/secrets/${nombre}`, { metodo: 'DELETE' });
  await cargarSecreto(id, nombre, valor);
  return 'reemplazado';
}

// Las functions de v2 y los secretos que necesita cada una. El margen de 13%
// vive aqui. Las de v1 tienen sus propios secretos, en functions propias, y no
// se tocan: el `0.30` que aparece en el codigo de v1 es su valor por defecto,
// no una lectura del secreto real (la API nunca expone valores).
const FUNCIONES = [
  { nombre: 'buscar-productos-v2', secretos: ['API_PRECIOS_KEY', 'MARGEN'] },
  { nombre: 'generar-cotizacion-v2', secretos: ['API_PRECIOS_KEY', 'MARGEN', 'TIPO_CAMBIO_CLP_USD', 'IVA_RATE', 'COTIZACION_VALID_HOURS'] },
  { nombre: 'emitir-ordenes-compra', secretos: ['MARGEN', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'OC_EMAIL_DESTINO'] },
  { nombre: 'route-quote-decision-v2', secretos: [] },
  { nombre: 'check-quote-validity-v2', secretos: [] },
  { nombre: 'route-rut-v2', secretos: [] },
] as const;

const VALORES: Record<string, string> = {
  API_PRECIOS_KEY: process.env.API_SECRET_KEY ?? '',
  MARGEN: '0.13',
  TIPO_CAMBIO_CLP_USD: process.env.TIPO_CAMBIO_CLP_USD ?? '950',
  IVA_RATE: '0.19',
  COTIZACION_VALID_HOURS: '3',
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL ?? '',
  OC_EMAIL_DESTINO: process.env.OC_EMAIL_DESTINO ?? 'pyxis.latam@gmail.com',
};

function imprimirResumen(
  ids: Record<string, string>,
  sinCupo: string[],
  sinConfirmar: string[],
  pendientes: string[],
): void {
  // Se llama desde un `finally`, asi que corre tanto si las seis functions se
  // procesaron bien como si la corrida revento a mitad de camino (por
  // ejemplo, una caida de red en el POST de secretos de la cuarta). El
  // estado acumulado hasta ese punto es lo que el operador necesita ver para
  // saber que quedo creado y que falta, en vez de solo un stack trace.
  console.log('\nfunction_id por nombre:');
  console.log(JSON.stringify(ids, null, 2));

  if (sinCupo.length > 0) {
    console.log('\nSIN DESPLEGAR (sin cupo de Cloudflare Worker en el plan actual):');
    for (const nombre of sinCupo) console.log(`  - ${nombre}`);
  }

  if (sinConfirmar.length > 0) {
    console.log('\nSIN CONFIRMAR (el deploy se acepto pero el estado no confirmo a tiempo; revisar a mano):');
    for (const nombre of sinConfirmar) console.log(`  - ${nombre}`);
  }

  if (pendientes.length > 0) {
    console.log('\nSECRETOS PENDIENTES (cargar en Kapso antes de emitir ordenes):');
    for (const pendiente of pendientes) console.log(`  - ${pendiente}`);
  }
}

async function main() {
  const { data: existentes } = await kapso<{ data: Funcion[] }>('/functions');
  const ids: Record<string, string> = {};
  const pendientes: string[] = [];
  const sinCupo: string[] = [];
  const sinConfirmar: string[] = [];

  try {
    for (const { nombre, secretos } of FUNCIONES) {
    const codigo = readFileSync(`docs/kapso/functions-v2/${nombre}.js`, 'utf8');
    const previa = existentes.find((f) => f.name === nombre);

    // El slug vive en un espacio de nombres propio (isia-v2-*) porque al menos
    // una function de v1 (buscar-productos) tiene un slug que no coincide con
    // su name y que choca con el slug que usariamos por defecto. No se puede
    // tocar esa function de v1, asi que evitamos el choque de raiz con un
    // prefijo que hoy no usa nadie en la cuenta.
    const slug = 'isia-v2-' + nombre.replace(/-v2$/, '');

    let id: string;
    if (previa) {
      await kapso(`/functions/${previa.id}`, { metodo: 'PATCH', cuerpo: { function: { code: codigo } } });
      id = previa.id;
      console.log(`actualizada  ${nombre}`);
    } else {
      const { data } = await kapso<{ data: Funcion }>('/functions', {
        metodo: 'POST',
        cuerpo: { function: { name: nombre, slug, code: codigo, function_type: 'cloudflare_worker' } },
      });
      id = data.id;
      console.log(`creada       ${nombre}`);
    }

    // Se registra apenas se conoce el id, no al final del todo: si algo
    // revienta mas adelante (deploy, secretos), el resumen del `finally`
    // igual sabe que esta function ya quedo creada/actualizada con este id.
    ids[nombre] = id;

    // Kapso exige la function desplegada antes de aceptar secretos ("Function
    // must be deployed before managing secrets"), asi que el deploy va antes
    // que los secretos, al reves de como lo tenia el borrador original.
    // El plan de la cuenta tiene cupo limitado de Cloudflare Worker
    // desplegadas: si ya no queda cupo, Kapso responde
    // cloudflare_worker_script_limit_exceeded. Eso no es un fallo del
    // despliegue de las demas functions: se registra y se sigue, igual que
    // ya se hace con los secretos que no se pueden resolver.
    let desplegada = false;
    try {
      await kapso(`/functions/${id}/deploy`, { metodo: 'POST' });
      desplegada = await esperarDespliegue(id);
      if (desplegada) {
        console.log(`desplegada   ${nombre}`);
      } else {
        // El deploy se acepto, pero el estado nunca confirmo dentro del tope
        // de espera. Es un caso distinto de "sin cupo": aca no sabemos si de
        // verdad quedo desplegada o no, y el resumen final lo tiene que decir
        // por separado para que alguien lo revise a mano.
        console.log(`sin confirmar ${nombre} (el deploy se acepto pero el estado no confirmo a tiempo; sus secretos quedan pendientes)`);
        sinConfirmar.push(nombre);
      }
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      if (/cloudflare_worker_script_limit_exceeded/.test(mensaje)) {
        console.log(`sin cupo     ${nombre} (queda en draft; los nodos "decide" del workflow corren asi)`);
        sinCupo.push(nombre);
      } else {
        throw error;
      }
    }

    if (!desplegada) {
      for (const secreto of secretos) pendientes.push(`${nombre}: ${secreto} (function sin desplegar o sin confirmar)`);
    } else {
      const previos = await nombresDeSecretos(id);
      const intentados: string[] = [];

      for (const secreto of secretos) {
        const valor = VALORES[secreto];
        // RESEND_API_KEY y RESEND_FROM_EMAIL no viven en .env.local, y la API de
        // Kapso nunca devuelve valores. Se avisa y se sigue: abortar dejaria el
        // despliegue a medias.
        if (!valor) {
          pendientes.push(`${nombre}: ${secreto} (sin valor de origen; queda como estuviera)`);
          continue;
        }
        intentados.push(secreto);
        try {
          const accion = await sincronizarSecreto(id, secreto, valor, previos);
          console.log(`  secreto ${secreto}: ${accion}`);
        } catch (error) {
          // Si el fallo fue despues del DELETE, el secreto quedo borrado. El
          // GET de verificacion de abajo lo detecta y lo dice con esas
          // palabras: lo que no puede pasar es que esto se vea como exito.
          const mensaje = error instanceof Error ? error.message : String(error);
          pendientes.push(`${nombre}: ${secreto} (no se pudo cargar → ${mensaje})`);
        }
      }

      // Verificacion: lo unico observable es el nombre, pero un nombre que no
      // volvio despues de un reemplazo es un secreto perdido, y hay que verlo.
      const finales = intentados.length > 0 ? await nombresDeSecretos(id) : previos;
      for (const secreto of intentados) {
        if (!finales.has(secreto)) {
          pendientes.push(`${nombre}: ${secreto} (NO figura en la function; cargarlo a mano en la UI de Kapso)`);
        }
      }
    }
    }
  } finally {
    // Se imprime pase lo que pase: si el `for` completo las seis functions o
    // si algo revento a mitad de camino, el operador necesita ver que
    // alcanzo a quedar creado, con que id, que quedo sin desplegar (por
    // cupo o sin confirmar) y que secretos quedaron pendientes.
    imprimirResumen(ids, sinCupo, sinConfirmar, pendientes);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
