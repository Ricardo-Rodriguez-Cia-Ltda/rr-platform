/**
 * Codigo de moneda en ISO 4217, tres letras mayusculas.
 *
 * Cada proveedor lo escribe a su manera: Intcomex manda "us", Tecnoglobal e
 * Ingram mandan "USD". Los tres significan lo mismo, pero la respuesta salia
 * con dos etiquetas distintas para la misma moneda, y el agente se la muestra
 * al cliente.
 *
 * No se traduce nada mas que la forma: si un proveedor empieza a cotizar en
 * otra moneda, su codigo pasa tal cual en mayusculas y se nota.
 */
export function normalizarMoneda(cruda: string | null | undefined): string {
  const limpia = (cruda ?? '').trim().toUpperCase();
  if (!limpia) return 'USD';
  // Intcomex abrevia el dolar como "US"; el resto del mundo usa "USD".
  return limpia === 'US' ? 'USD' : limpia;
}
