async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const disponibles = body.available_edges || [];
  const crudo = vars.quote_result?.quote?.valid_until || vars.quote_result?.valid_until || vars.quote_valid_until || "";
  const instante = Date.parse(String(crudo));
  const expirada = !Number.isFinite(instante) || Date.now() >= instante;
  const deseado = expirada ? "expired" : "valid";
  const next = disponibles.includes(deseado) ? deseado : disponibles[0] || deseado;
  return new Response(JSON.stringify({ next_edge: next, vars: { quote_expired: expirada } }), { headers: { "Content-Type": "application/json" } });
}
