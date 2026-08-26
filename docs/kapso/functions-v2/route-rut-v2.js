async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const disponibles = body.available_edges || [];
  // A diferencia de route-rut de v1, aca no hay bandera `factura`: en v2 los
  // datos tributarios se piden siempre, asi que un RUT sin validar es invalido.
  const deseado = vars.rut_valid === true ? "valid" : "invalid";
  const next = disponibles.includes(deseado) ? deseado : disponibles[0] || deseado;
  return new Response(JSON.stringify({ next_edge: next }), { headers: { "Content-Type": "application/json" } });
}
