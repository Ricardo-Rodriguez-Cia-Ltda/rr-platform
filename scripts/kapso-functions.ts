import { readFileSync } from 'node:fs';
import { kapso } from './kapso.js';

interface Funcion { id: string; name: string; }
interface FuncionEstado { id: string; status: string; }

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

// Las functions de v2 y los secretos que necesita cada una. El margen de 13%
// vive aqui: las de v1 siguen en 0.30 y no se tocan.
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

async function main() {
  const { data: existentes } = await kapso<{ data: Funcion[] }>('/functions');
  const ids: Record<string, string> = {};
  const pendientes: string[] = [];
  const sinDesplegar: string[] = [];

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
        console.log(`aviso        ${nombre} desplegada pero el estado tardo en confirmarse; sus secretos quedan pendientes`);
      }
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      if (/cloudflare_worker_script_limit_exceeded/.test(mensaje)) {
        console.log(`sin cupo     ${nombre} (queda en draft; los nodos "decide" del workflow corren asi)`);
        sinDesplegar.push(nombre);
      } else {
        throw error;
      }
    }

    if (!desplegada) {
      for (const secreto of secretos) pendientes.push(`${nombre}: ${secreto} (function sin desplegar o sin confirmar)`);
    } else {
      for (const secreto of secretos) {
        const valor = VALORES[secreto];
        // RESEND_API_KEY y RESEND_FROM_EMAIL no viven en .env.local, y la API de
        // Kapso solo lista los nombres de los secretos de v1, nunca sus valores.
        // Se avisa y se sigue: abortar dejaria el despliegue a medias.
        if (!valor) { pendientes.push(`${nombre}: ${secreto}`); continue; }
        await kapso(`/functions/${id}/secrets`, { metodo: 'POST', cuerpo: { secret: { name: secreto, value: valor } } })
          .catch((error: Error) => {
            // Solo un secreto que ya existe no es un fallo real: se deja el
            // valor vigente. Todo lo demas se propaga — una regex que
            // tragaba cualquier 422 escondia errores reales (por ejemplo,
            // intentar setear un secreto en una function sin desplegar).
            if (!/already/i.test(error.message)) throw error;
          });
      }
    }

    ids[nombre] = id;
  }

  console.log('\nfunction_id por nombre:');
  console.log(JSON.stringify(ids, null, 2));

  if (sinDesplegar.length > 0) {
    console.log('\nSIN DESPLEGAR (sin cupo de Cloudflare Worker en el plan actual):');
    for (const nombre of sinDesplegar) console.log(`  - ${nombre}`);
  }

  if (pendientes.length > 0) {
    console.log('\nSECRETOS PENDIENTES (cargar en Kapso antes de emitir ordenes):');
    for (const pendiente of pendientes) console.log(`  - ${pendiente}`);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
