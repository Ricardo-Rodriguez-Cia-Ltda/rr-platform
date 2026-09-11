import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kapso } from './client.js';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface KapsoFunction { id: string; name: string; }
interface Workflow { id: string; name: string; slug: string; }

const MODEL = '8c6d57df-3f07-4290-b8a5-38047608c4df';  // claude-haiku-4-5, el mismo de v1

// La version que se despliega es la que el propio directorio declara
// `vigente`, no un `v-01` fijo: al subir un prompt lo unico que hay que tocar
// es la cabecera del archivo, y `tests/prompts.test.ts` ya garantiza que hay
// como maximo una vigente por agente.
function currentPromptFile(agent: string): string {
  const dir = join(APP_ROOT, 'prompts', agent);
  const current = readdirSync(dir)
    .filter((n) => /^v-\d+\.md$/.test(n))
    .filter((n) => /\| \*\*Estado\*\* \| vigente \|/.test(readFileSync(join(dir, n), 'utf8')));

  if (current.length !== 1) {
    throw new Error(`${agent} tiene ${current.length} versiones vigentes; tiene que haber exactamente una`);
  }
  return join(dir, current[0]);
}

// Solo el bloque delimitado va al system_prompt. La cabecera y las notas de
// diseno son documentacion nuestra; en v1 se subio el archivo entero por error.
function prompt(agent: string): string {
  const path = currentPromptFile(agent);
  const file = readFileSync(path, 'utf8');
  const block = /<!-- PROMPT:INICIO -->([\s\S]*?)<!-- PROMPT:FIN -->/.exec(file);
  if (!block) throw new Error(`${path} no tiene delimitadores de prompt`);
  console.log(`prompt ${agent}: ${path}`);
  return block[1].trim();
}

function agentNode(id: string, x: number, y: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'agent',
      display_name: id,
      config: {
        system_prompt: text,
        provider_model_id: MODEL,
        temperature: 0,
        max_iterations: 20,
        message_delivery_mode: 'auto_send_assistant_text',
        enabled_default_tools: ['get_variable', 'save_variable', 'enter_waiting', 'complete_task', 'handoff_to_human'],
        ...extra,
      },
    },
  };
}

function fn(id: string, functionId: string, name: string, saveTo: string, x: number, y: number) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'function',
      display_name: `Function: ${name}`,
      config: { function_id: functionId, function_name: name, save_response_to: saveTo },
    },
  };
}

// El cobro entra por un nodo `webhook` y no por una function nueva: el cupo de
// Cloudflare Workers de Kapso esta en 5 de 5 y ninguna sobra. Un `webhook` no
// consume cupo.
function webhook(id: string, url: string, body: Record<string, unknown>, saveTo: string, x: number, y: number) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'webhook',
      display_name: 'Webhook: crear pago',
      config: {
        url,
        method: 'POST',
        headers: { 'X-API-Key': '${ENV:MAILER_API_KEY}', 'Content-Type': 'application/json' },
        body_template: body,
        save_response_to: saveTo,
      },
    },
  };
}

function decide(id: string, functionId: string, name: string, labels: Array<[string, string]>, x: number, y: number) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'decide',
      display_name: `Decide: ${name}`,
      config: {
        decision_type: 'function',
        function_id: functionId,
        function_name: name,
        conditions: labels.map(([label, description]) => ({ label, description })),
      },
    },
  };
}

async function main() {
  const { data: functions } = await kapso<{ data: KapsoFunction[] }>('/functions');
  const id = (name: string) => {
    const f = functions.find((x) => x.name === name);
    if (!f) throw new Error(`Falta la function ${name}. Corre antes: npm run kapso:functions`);
    return f.id;
  };

  const nodes = [
    { id: 'start', type: 'flow-node', position: { x: -700, y: 0 }, data: { node_type: 'start', display_name: 'Start', config: {} } },

    agentNode('agente_descubrimiento', -480, 0, prompt('agente-descubrimiento'), {
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
            subcategoria: {
              type: 'string',
              description:
                'Subcategoría exacta del catálogo. Para computadores: Portátiles | Todo-en-Uno | Computadores de Mesa | Servidores | Tableta.',
            },
            precio_max: { type: 'number', description: 'Tope de precio de venta EN PESOS CHILENOS. Nunca en dólares.' },
            limite: { type: 'integer' },
            incluir_sin_stock: { type: 'boolean', description: 'Solo en true si el cliente acepta ver productos sin stock inmediato.' },
          },
        },
      }],
    }),

    fn('fn_cotizar', id('generar-cotizacion-v2'), 'generar-cotizacion-v2', 'quote_function_response', -260, 0),
    agentNode('agente_presentacion', -40, 0, prompt('agente-presentacion')),
    decide('route_decision', id('router-v2'), 'router-v2', [
      ['accepted', 'El cliente acepta la cotización'],
      ['rejected', 'El cliente rechaza o pide cambios'],
    ], 180, 0),

    agentNode('agente_facturacion', 400, 120, prompt('agente-facturacion')),
    fn('fn_validar_rut', id('validar-rut'), 'validar-rut', 'rut_validation_response', 620, 120),
    decide('route_rut', id('router-v2'), 'router-v2', [
      ['valid', 'RUT válido'],
      ['invalid', 'RUT inválido'],
    ], 840, 120),

    decide('fn_check_validity', id('router-v2'), 'router-v2', [
      ['valid', 'La cotización sigue vigente'],
      ['expired', 'La cotización expiró y debe recalcularse'],
    ], 1060, 120),

    agentNode('agente_cierre', 1280, 120, prompt('agente-cierre'), {
      max_iterations: 30,
      enabled_default_tools: ['get_execution_metadata', 'get_whatsapp_context', 'get_variable', 'save_variable', 'enter_waiting', 'complete_task', 'handoff_to_human'],
    }),

    // El cobro reemplaza a la emision en el grafo: emitir-ordenes-compra sigue
    // desplegada, pero ahora la invoca el servicio de pagos cuando Mercado Pago
    // confirma. Y el texto de confirmacion lo manda ese mismo servicio, que es
    // el unico que sabe si hubo link, si no lo hubo, o si la cotizacion ya no
    // servia -- un send_text fijo aca mentiria en dos de los tres casos.
    webhook(
      'fn_crear_pago',
      'https://rr-mailing.vercel.app/api/pago/crear',
      {
        quote_id: '{{vars.quote_id}}',
        quote_version: '{{vars.quote_version}}',
        // El guard de consentimiento. La arista `agente_cierre ->
        // fn_crear_pago` es incondicional; hasta este cambio de grafo el
        // destino era `fn_emitir_ordenes`, y emitir-ordenes-compra.js
        // rechazaba con 400 cualquier invocacion sin `quote_confirmed`. Ese
        // era el unico chequeo determinista de que el cliente dijo que si, y
        // al mover el destino quedo fuera del camino. Va aca, y el handler de
        // `/api/pago/crear` lo exige con el mismo criterio permisivo. Si se
        // cae de este cuerpo, un `complete_task` sin un si inequivoco le
        // manda un cobro real a alguien que no acepto comprar.
        quote_confirmed: '{{vars.quote_confirmed}}',
        phone_number: '{{context.phone_number}}',
        phone_number_id: '{{system.whatsapp_config.phone_number_id}}',
        customer_name: '{{vars.quote_customer_name}}',
        billing_rut: '{{vars.billing_rut}}',
        billing_razon_social: '{{vars.billing_razon_social}}',
        billing_giro: '{{vars.billing_giro}}',
        billing_direccion: '{{vars.billing_direccion}}',
        billing_comuna: '{{vars.billing_comuna}}',
        billing_ciudad: '{{vars.billing_ciudad}}',
        billing_email: '{{vars.billing_email}}',
      },
      'pago_response',
      1500,
      120,
    ),

    { id: 'handoff_fin', type: 'flow-node', position: { x: 1940, y: 120 }, data: { node_type: 'handoff', display_name: 'Handoff', config: { reason: 'Link de pago enviado; el pedido se emite al acreditarse' } } },
  ];

  const edges = [
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
    { source: 'agente_cierre', target: 'fn_crear_pago', label: 'next' },
    { source: 'fn_crear_pago', target: 'handoff_fin', label: 'next' },
  ];

  const { data: existing } = await kapso<{ data: Workflow[] }>('/workflows');
  const previous = existing.find((w) => w.slug === 'rr-isia-version2');

  if (previous) {
    const { data: meta } = await kapso<{ data: { lock_version: number } }>(`/workflows/${previous.id}`);
    await kapso(`/workflows/${previous.id}`, {
      method: 'PATCH',
      body: { workflow: { lock_version: meta.lock_version, definition: { nodes, edges } } },
    });
    console.log(`workflow actualizado: ${previous.id}`);
    return;
  }

  const { data } = await kapso<{ data: Workflow }>('/workflows', {
    method: 'POST',
    body: {
      workflow: {
        name: 'rr-isia-version2',
        slug: 'rr-isia-version2',
        description: 'Cotiza con el mejor precio entre los tres mayoristas y emite una orden de compra por mayorista.',
        status: 'draft',
        definition: { nodes, edges },
      },
    },
  });
  console.log(`workflow creado: ${data.id}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
