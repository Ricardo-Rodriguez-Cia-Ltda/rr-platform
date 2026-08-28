// Los headers y los parametros de query de Vercel llegan como string o como
// string[] cuando la clave se repite. La mayoria de los handlers solo quiere
// el primer valor.
export function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
