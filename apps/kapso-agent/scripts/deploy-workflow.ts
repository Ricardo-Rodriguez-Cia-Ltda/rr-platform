import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kapso } from './client.js';

const RAIZ_APP = fileURLToPath(new URL('..', import.meta.url));

interface Funcion { id: string; name: string; }
interface Workflow { id: string; name: string; slug: string; }

const MODELO = '8c6d57df-3f07-4290-b8a5-38047608c4df';  // claude-haiku-4-5, el mismo de v1

// La version que se despliega es la que el propio directorio declara
// `vigente`, no un `v-01` fijo: al subir un prompt lo unico que hay que tocar
// es la cabecera del archivo, y `tests/prompts.test.ts` ya garantiza que hay
// como maximo una vigente por agente.
function archivoVigente(agente: string): string {
  const dir = join(RAIZ_APP, 'prompts', agente);
  const vigentes = readdirSync(dir)
    .filter((n) => /^v-\d+\.md$/.test(n))
    .filter((n) => /\| \*\*Estado\*\* \| vigente \|/.test(readFileSync(join(dir, n), 'utf8')));

  if (vigentes.length !== 1) {
    throw new Error(`${agente} tiene ${vigentes.length} versiones vigentes; tiene que haber exactamente una`);
  }
  return join(dir, vigentes[0]);
}

// Solo el bloque delimitado va al system_prompt. La cabecera y las notas de
// diseno son documentacion nuestra; en v1 se subio el archivo entero por error.
function prompt(agente: string): string {
  const ruta = archivoVigente(agente);
  const archivo = readFileSync(ruta, 'utf8');
  const bloque = /<!-- PROMPT:INICIO -->([\s\S]*?)<!-- PROMPT:FIN -->/.exec(archivo);
  if (!bloque) throw new Error(`${ruta} no tiene delimitadores de prompt`);
  console.log(`prompt ${agente}: ${ruta}`);
  return bloque[1].trim();
}

function agente(id: string, x: number, y: number, texto: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'agent',
      display_name: id,
      config: {
        system_prompt: texto,
        provider_model_id: MODELO,
        temperature: 0,
        max_iterations: 20,
        message_delivery_mode: 'auto_send_assistant_text',
        enabled_default_tools: ['get_variable', 'save_variable', 'enter_waiting', 'complete_task', 'handoff_to_human'],
        ...extra,
      },
    },
  };
}

function fn(id: string, functionId: string, nombre: string, guardarEn: string, x: number, y: number) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'function',
      display_name: `Function: ${nombre}`,
      config: { function_id: functionId, function_name: nombre, save_response_to: guardarEn },
    },
  };
}

function decide(id: string, functionId: string, nombre: string, etiquetas: Array<[string, string]>, x: number, y: number) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'decide',
      display_name: `Decide: ${nombre}`,
      config: {
        decision_type: 'function',
        function_id: functionId,
        function_name: nombre,
        conditions: etiquetas.map(([label, description]) => ({ label, description })),
      },
    },
  };
}

async function main() {
  const { data: funciones } = await kapso<{ data: Funcion[] }>('/functions');
  const id = (nombre: string) => {
    const f = funciones.find((x) => x.name === nombre);
    if (!f) throw new Error(`Falta la function ${nombre}. Corre antes: npm run kapso:functions`);
    return f.id;
  };

  const nodos = [
    { id: 'start', type: 'flow-node', position: { x: -700, y: 0 }, data: { node_type: 'start', display_name: 'Start', config: {} } },

    agente('agente_descubrimiento', -480, 0, prompt('agente-descubrimiento'), {
      max_iterations: 40,
      enabled_default_tools: ['get_execution_metadata', 'get_variable', 'save_variable', 'enter_waiting', 'complete_task', 'handoff_to_human'],
      flow_agent_function_tools: [{
        name: 'buscar_productos',
        description: 'Busca productos del catálogo y devuelve precio final de venta, MPN, marca y disponibilidad; nunca costos.',
        function_id: id('buscar-productos-v2'),
        function_name: 'buscar-productos-v2',
        input_schema: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string' },
            marca: { type: 'string' },
            categoria: { type: 'string' },
            precio_max: { type: 'number' },
            limite: { type: 'integer' },
            incluir_sin_stock: { type: 'boolean' },
          },
        },
      }],
    }),

    fn('fn_cotizar', id('generar-cotizacion-v2'), 'generar-cotizacion-v2', 'quote_function_response', -260, 0),
    agente('agente_presentacion', -40, 0, prompt('agente-presentacion')),
    decide('route_decision', id('route-quote-decision-v2'), 'route-quote-decision-v2', [
      ['accepted', 'El cliente acepta la cotización'],
      ['rejected', 'El cliente rechaza o pide cambios'],
    ], 180, 0),

    agente('agente_facturacion', 400, 120, prompt('agente-facturacion')),
    fn('fn_validar_rut', id('validar-rut'), 'validar-rut', 'rut_validation_response', 620, 120),
    decide('route_rut', id('route-rut-v2'), 'route-rut-v2', [
      ['valid', 'RUT válido'],
      ['invalid', 'RUT inválido'],
    ], 840, 120),

    decide('fn_check_validity', id('check-quote-validity-v2'), 'check-quote-validity-v2', [
      ['valid', 'La cotización sigue vigente'],
      ['expired', 'La cotización expiró y debe recalcularse'],
    ], 1060, 120),

    agente('agente_cierre', 1280, 120, prompt('agente-cierre'), {
      max_iterations: 30,
      enabled_default_tools: ['get_execution_metadata', 'get_whatsapp_context', 'get_variable', 'save_variable', 'enter_waiting', 'complete_task', 'handoff_to_human'],
    }),

    fn('fn_emitir_ordenes', id('emitir-ordenes-compra'), 'emitir-ordenes-compra', 'purchase_orders_response', 1500, 120),

    {
      id: 'send_confirmacion',
      type: 'flow-node',
      position: { x: 1720, y: 120 },
      data: {
        node_type: 'send_text',
        display_name: 'Confirmación',
        config: {
          // La arista fn_emitir_ordenes → send_confirmacion es incondicional:
          // este texto sale igual si la emision devolvio 400, 500, o `ok: true`
          // con todas las ordenes en `failed`. Por eso NO afirma que el pedido
          // quedo cursado — afirma lo unico que es cierto en todos los casos.
          // Ramificar de verdad por `purchase_orders_ok` necesita otro nodo
          // `decide`; ver README-v2.md, seccion de pendientes.
          message: 'Listo, dejamos tu pedido con el equipo comercial 🙌 Te contactan para confirmarlo y coordinar el pago y la entrega. ¡Gracias!',
          delay_seconds: 0,
        },
      },
    },

    { id: 'handoff_fin', type: 'flow-node', position: { x: 1940, y: 120 }, data: { node_type: 'handoff', display_name: 'Handoff', config: { reason: 'Pedido cursado, órdenes de compra emitidas' } } },
  ];

  const aristas = [
    { source: 'start', target: 'agente_descubrimiento', label: 'next' },
    { source: 'agente_descubrimiento', target: 'fn_cotizar', label: 'next' },
    { source: 'fn_cotizar', target: 'agente_presentacion', label: 'next' },
    { source: 'agente_presentacion', target: 'route_decision', label: 'next' },
    { source: 'route_decision', target: 'agente_facturacion', label: 'accepted' },
    { source: 'route_decision', target: 'agente_descubrimiento', label: 'rejected' },
    { source: 'agente_facturacion', target: 'fn_validar_rut', label: 'next' },
    { source: 'fn_validar_rut', target: 'route_rut', label: 'next' },
    { source: 'route_rut', target: 'fn_check_validity', label: 'valid' },
    { source: 'route_rut', target: 'agente_facturacion', label: 'invalid' },
    { source: 'fn_check_validity', target: 'agente_cierre', label: 'valid' },
    { source: 'fn_check_validity', target: 'fn_cotizar', label: 'expired' },
    { source: 'agente_cierre', target: 'fn_emitir_ordenes', label: 'next' },
    { source: 'fn_emitir_ordenes', target: 'send_confirmacion', label: 'next' },
    { source: 'send_confirmacion', target: 'handoff_fin', label: 'next' },
  ];

  const { data: existentes } = await kapso<{ data: Workflow[] }>('/workflows');
  const previo = existentes.find((w) => w.slug === 'rr-isia-version2');

  if (previo) {
    const { data: meta } = await kapso<{ data: { lock_version: number } }>(`/workflows/${previo.id}`);
    await kapso(`/workflows/${previo.id}`, {
      metodo: 'PATCH',
      cuerpo: { workflow: { lock_version: meta.lock_version, definition: { nodes: nodos, edges: aristas } } },
    });
    console.log(`workflow actualizado: ${previo.id}`);
    return;
  }

  const { data } = await kapso<{ data: Workflow }>('/workflows', {
    metodo: 'POST',
    cuerpo: {
      workflow: {
        name: 'rr-isia-version2',
        slug: 'rr-isia-version2',
        description: 'Cotiza con el mejor precio entre los tres mayoristas y emite una orden de compra por mayorista.',
        status: 'draft',
        definition: { nodes: nodos, edges: aristas },
      },
    },
  });
  console.log(`workflow creado: ${data.id}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
