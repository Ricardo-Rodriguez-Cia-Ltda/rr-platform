import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kapso } from './client.js';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface KapsoFunction { id: string; name: string; }
interface FunctionStatus { id: string; status: string; }
interface KapsoSecret { name: string; type?: string; }

// El POST /deploy responde antes de que Kapso termine de propagar el estado
// "deployed" (se confirmo en la practica: justo despues de un deploy exitoso,
// /secrets todavia respondia "Function must be deployed"). Se espera a que
// el GET confirme el estado antes de intentar los secretos, con un tope de
// espera para no colgar el script si algo quedo atascado de verdad.
async function waitForDeploy(id: string, attempts = 10, waitMs = 1500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const { data } = await kapso<{ data: FunctionStatus }>(`/functions/${id}`);
    if (data.status === 'deployed') return true;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return false;
}

// La API de Kapso no tiene PUT ni PATCH de secretos: `POST /secrets` exige que
// el nombre sea unico dentro de la function (lo rechaza si ya existe, no lo
// sobrescribe) y `DELETE /secrets/{name}` borra por nombre. `GET /secrets`
// devuelve solo `{name, type}`, nunca valores. Consecuencia: cambiar el valor
// de un secreto es borrarlo y crearlo de nuevo, y lo unico verificable despues
// es que el nombre este presente.
// La respuesta real es `{ data: { secrets: [{ name, type }] } }` (verificado
// contra la cuenta; el OpenAPI publicado sugiere una lista pelada). Se aceptan
// las dos formas para no volver a caerse si la envuelven distinto.
async function secretNames(id: string): Promise<Set<string>> {
  const { data } = await kapso<{ data: KapsoSecret[] | { secrets?: KapsoSecret[] } }>(`/functions/${id}/secrets`);
  const list = Array.isArray(data) ? data : data?.secrets ?? [];
  return new Set(list.map((s) => s.name));
}

async function createSecret(id: string, name: string, value: string): Promise<void> {
  await kapso(`/functions/${id}/secrets`, { method: 'POST', body: { secret: { name, value } } });
}

// Devuelve que se hizo, para que el resumen pueda decir la verdad. Si el
// secreto ya existia hay una ventana entre el DELETE y el POST en la que la
// function se queda sin el: por eso el llamador verifica al final con un GET y
// grita si algun nombre no volvio.
async function syncSecret(
  id: string,
  name: string,
  value: string,
  existing: Set<string>,
): Promise<'creado' | 'reemplazado'> {
  if (!existing.has(name)) {
    await createSecret(id, name, value);
    return 'creado';
  }
  await kapso(`/functions/${id}/secrets/${name}`, { method: 'DELETE' });
  await createSecret(id, name, value);
  return 'reemplazado';
}

// Las functions de v2 y los secretos que necesita cada una. El margen de 13%
// vive aqui. Las de v1 tienen sus propios secretos, en functions propias, y no
// se tocan: el `0.30` que aparece en el codigo de v1 es su valor por defecto,
// no una lectura del secreto real (la API nunca expone valores).
const FUNCTIONS = [
  { name: 'buscar-productos-v2', secrets: ['API_PRECIOS_KEY', 'MARGEN'] },
  { name: 'generar-cotizacion-v2', secrets: ['API_PRECIOS_KEY', 'MARGEN', 'TIPO_CAMBIO_CLP_USD', 'IVA_RATE', 'COTIZACION_VALID_HOURS'] },
  { name: 'emitir-ordenes-compra', secrets: ['MARGEN', 'MAILER_URL', 'MAILER_API_KEY', 'OC_EMAIL_DESTINO'] },
  // Un solo router para los tres nodos `decide`. El plan de Kapso permite 5
  // Workers desplegados y las cuatro de arriba ya ocupan cuatro; tres routers
  // separados no caben. Ver el comentario de cabecera de router-v2.js.
  { name: 'router-v2', secrets: [] },
] as const;

const VALUES: Record<string, string> = {
  API_PRECIOS_KEY: process.env.API_SECRET_KEY ?? '',
  MARGEN: '0.13',
  TIPO_CAMBIO_CLP_USD: process.env.TIPO_CAMBIO_CLP_USD ?? '950',
  IVA_RATE: '0.19',
  COTIZACION_VALID_HOURS: '3',
  MAILER_URL: process.env.MAILER_URL ?? '',
  MAILER_API_KEY: process.env.MAILER_API_KEY ?? '',
  OC_EMAIL_DESTINO: process.env.OC_EMAIL_DESTINO ?? 'pyxis.latam@gmail.com',
};

function printSummary(
  ids: Record<string, string>,
  withoutQuota: string[],
  unconfirmed: string[],
  pending: string[],
): void {
  // Se llama desde un `finally`, asi que corre tanto si las seis functions se
  // procesaron bien como si la corrida revento a mitad de camino (por
  // ejemplo, una caida de red en el POST de secretos de la cuarta). El
  // estado acumulado hasta ese punto es lo que el operador necesita ver para
  // saber que quedo creado y que falta, en vez de solo un stack trace.
  console.log('\nfunction_id por nombre:');
  console.log(JSON.stringify(ids, null, 2));

  if (withoutQuota.length > 0) {
    console.log('\nSIN DESPLEGAR (sin cupo de Cloudflare Worker en el plan actual):');
    for (const name of withoutQuota) console.log(`  - ${name}`);
  }

  if (unconfirmed.length > 0) {
    console.log('\nSIN CONFIRMAR (el deploy se acepto pero el estado no confirmo a tiempo; revisar a mano):');
    for (const name of unconfirmed) console.log(`  - ${name}`);
  }

  if (pending.length > 0) {
    console.log('\nSECRETOS PENDIENTES (cargar en Kapso antes de emitir ordenes):');
    for (const item of pending) console.log(`  - ${item}`);
  }
}

async function main() {
  const { data: existing } = await kapso<{ data: KapsoFunction[] }>('/functions');
  const ids: Record<string, string> = {};
  const pending: string[] = [];
  const withoutQuota: string[] = [];
  const unconfirmed: string[] = [];

  try {
    for (const { name, secrets } of FUNCTIONS) {
    const code = readFileSync(join(APP_ROOT, 'functions', `${name}.js`), 'utf8');
    const existingFn = existing.find((f) => f.name === name);

    // El slug vive en un espacio de nombres propio (isia-v2-*) porque al menos
    // una function de v1 (buscar-productos) tiene un slug que no coincide con
    // su name y que choca con el slug que usariamos por defecto. No se puede
    // tocar esa function de v1, asi que evitamos el choque de raiz con un
    // prefijo que hoy no usa nadie en la cuenta.
    const slug = 'isia-v2-' + name.replace(/-v2$/, '');

    let id: string;
    if (existingFn) {
      await kapso(`/functions/${existingFn.id}`, { method: 'PATCH', body: { function: { code } } });
      id = existingFn.id;
      console.log(`actualizada  ${name}`);
    } else {
      const { data } = await kapso<{ data: KapsoFunction }>('/functions', {
        method: 'POST',
        body: { function: { name, slug, code, function_type: 'cloudflare_worker' } },
      });
      id = data.id;
      console.log(`creada       ${name}`);
    }

    // Se registra apenas se conoce el id, no al final del todo: si algo
    // revienta mas adelante (deploy, secretos), el resumen del `finally`
    // igual sabe que esta function ya quedo creada/actualizada con este id.
    ids[name] = id;

    // Kapso exige la function desplegada antes de aceptar secretos ("Function
    // must be deployed before managing secrets"), asi que el deploy va antes
    // que los secretos, al reves de como lo tenia el borrador original.
    // El plan de la cuenta tiene cupo limitado de Cloudflare Worker
    // desplegadas: si ya no queda cupo, Kapso responde
    // cloudflare_worker_script_limit_exceeded. Eso no es un fallo del
    // despliegue de las demas functions: se registra y se sigue, igual que
    // ya se hace con los secretos que no se pueden resolver.
    let deployed = false;
    try {
      await kapso(`/functions/${id}/deploy`, { method: 'POST' });
      deployed = await waitForDeploy(id);
      if (deployed) {
        console.log(`desplegada   ${name}`);
      } else {
        // El deploy se acepto, pero el estado nunca confirmo dentro del tope
        // de espera. Es un caso distinto de "sin cupo": aca no sabemos si de
        // verdad quedo desplegada o no, y el resumen final lo tiene que decir
        // por separado para que alguien lo revise a mano.
        console.log(`sin confirmar ${name} (el deploy se acepto pero el estado no confirmo a tiempo; sus secretos quedan pendientes)`);
        unconfirmed.push(name);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cloudflare_worker_script_limit_exceeded/.test(message)) {
        // Ojo: `draft` NO es un estado funcional. Kapso responde
        // 422 "Function is not deployed" al invocarla, asi que cualquier nodo
        // que dependa de esta function deja la conversacion colgada.
        console.log(`sin cupo     ${name} (queda en DRAFT y NO se puede invocar: los nodos que la usan van a fallar)`);
        withoutQuota.push(name);
      } else {
        throw error;
      }
    }

    if (!deployed) {
      for (const secret of secrets) pending.push(`${name}: ${secret} (function sin desplegar o sin confirmar)`);
    } else {
      const before = await secretNames(id);
      const attempted: string[] = [];

      for (const secret of secrets) {
        const value = VALUES[secret];
        // Si `value` esta vacio es porque el operador no cargo esa variable en
        // .env.local (ver el README): MAILER_URL y MAILER_API_KEY si viven ahi,
        // igual que el resto. Y la API de Kapso nunca devuelve valores, asi que
        // no hay forma de saber si ya esta cargado del otro lado. Se avisa y se
        // sigue: abortar dejaria el despliegue a medias.
        if (!value) {
          pending.push(`${name}: ${secret} (sin valor de origen; queda como estuviera)`);
          continue;
        }
        attempted.push(secret);
        try {
          const action = await syncSecret(id, secret, value, before);
          console.log(`  secreto ${secret}: ${action}`);
        } catch (error) {
          // Si el fallo fue despues del DELETE, el secreto quedo borrado. El
          // GET de verificacion de abajo lo detecta y lo dice con esas
          // palabras: lo que no puede pasar es que esto se vea como exito.
          const message = error instanceof Error ? error.message : String(error);
          pending.push(`${name}: ${secret} (no se pudo cargar → ${message})`);
        }
      }

      // Verificacion: lo unico observable es el nombre, pero un nombre que no
      // volvio despues de un reemplazo es un secreto perdido, y hay que verlo.
      const after = attempted.length > 0 ? await secretNames(id) : before;
      for (const secret of attempted) {
        if (!after.has(secret)) {
          pending.push(`${name}: ${secret} (NO figura en la function; cargarlo a mano en la UI de Kapso)`);
        }
      }
    }
    }
  } finally {
    // Se imprime pase lo que pase: si el `for` completo las seis functions o
    // si algo revento a mitad de camino, el operador necesita ver que
    // alcanzo a quedar creado, con que id, que quedo sin desplegar (por
    // cupo o sin confirmar) y que secretos quedaron pendientes.
    printSummary(ids, withoutQuota, unconfirmed, pending);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
