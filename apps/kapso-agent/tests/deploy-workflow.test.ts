import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// El grafo se define en `scripts/deploy-workflow.ts` y solo existe de verdad
// cuando el script corre contra la API de Kapso, que no se puede ejercitar en
// una prueba. Lo que si se puede verificar -- y lo unico que hace falta -- es
// que el cuerpo que el nodo del cobro promete mandar calce con lo que el
// handler del otro lado exige. Este es exactamente el tipo de hueco que
// ninguna revision por tarea ve: el nodo y el handler viven en apps distintas.
const FUENTE = readFileSync('apps/kapso-agent/scripts/deploy-workflow.ts', 'utf8');

/** El bloque de argumentos de la llamada `webhook('fn_crear_pago', ...)`. */
function nodoCrearPago(): string {
  const desde = FUENTE.indexOf("'fn_crear_pago'");
  expect(desde, 'el grafo ya no tiene un nodo fn_crear_pago').toBeGreaterThan(-1);
  const hasta = FUENTE.indexOf("'pago_response'", desde);
  expect(hasta, 'fn_crear_pago ya no guarda su respuesta en pago_response').toBeGreaterThan(desde);
  return FUENTE.slice(desde, hasta);
}

describe('nodo fn_crear_pago del grafo', () => {
  // C1: la arista `agente_cierre -> fn_crear_pago` es incondicional. Antes el
  // destino era `fn_emitir_ordenes`, y emitir-ordenes-compra.js rechaza con
  // 400 cualquier invocacion sin `quote_confirmed` -- ese era el unico guard
  // determinista sobre el consentimiento del cliente. Al cambiar el destino
  // quedo fuera del camino, y sin esta variable en el cuerpo el handler de
  // pagos no tiene con que reponerlo.
  it('manda quote_confirmed, el guard de consentimiento del cliente', () => {
    expect(nodoCrearPago()).toContain("quote_confirmed: '{{vars.quote_confirmed}}'");
  });

  it('manda la cotizacion y el destinatario del link', () => {
    const nodo = nodoCrearPago();
    for (const clave of ['quote_id', 'quote_version', 'phone_number', 'phone_number_id']) {
      expect(nodo, `falta ${clave} en el cuerpo del nodo`).toContain(`${clave}: '{{`);
    }
  });

  // Los siete campos de facturacion mas el nombre: es lo que
  // emitir-ordenes-compra espera en `vars` y que el servicio de pagos guarda
  // en `pagos.datos` para reponerlo cuando Mercado Pago confirme. Si uno se
  // cae del cuerpo, la orden de compra sale sin el y nadie se entera.
  it('manda los datos de facturacion que la orden de compra necesita', () => {
    const nodo = nodoCrearPago();
    const campos = [
      'customer_name', 'billing_rut', 'billing_razon_social', 'billing_giro',
      'billing_direccion', 'billing_comuna', 'billing_ciudad', 'billing_email',
    ];
    for (const campo of campos) {
      expect(nodo, `falta ${campo} en el cuerpo del nodo`).toContain(`${campo}: '{{vars.`);
    }
  });
});
