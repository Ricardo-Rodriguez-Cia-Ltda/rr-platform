async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const result = vars.credit_result || {};
  const available = body.available_edges || [];
  const requested = Number(result.monto_solicitado || vars.quote_total_clp || 0);
  const line = Number(result.linea_disponible || 0);
  const next = result.codigo === "credito_no_configurado" || result.codigo === "credito_no_disponible" || result.estado === "no_disponible" ? "human" : result.aprobado === true ? "approved" : line > 0 && line < requested ? "partial" : "rejected";
  return new Response(JSON.stringify({ next_edge: available.includes(next) ? next : available[0] || next }), { headers: { "Content-Type": "application/json" } });
}