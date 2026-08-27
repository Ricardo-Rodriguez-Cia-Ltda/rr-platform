async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const available = body.available_edges || [];
  const billingRequired = vars.factura === true || String(vars.factura || "").toLowerCase() === "true";
  const next = billingRequired && vars.rut_valid !== true ? "invalid" : "valid";
  return new Response(JSON.stringify({ next_edge: available.includes(next) ? next : available[0] || next }), { headers: { "Content-Type": "application/json" } });
}