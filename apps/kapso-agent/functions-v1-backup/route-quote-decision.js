async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const available = body.available_edges || [];
  const decision = ["accepted", "rejected", "pending"].includes(String(vars.quote_decision)) ? String(vars.quote_decision) : "pending";
  const next = available.includes(decision) ? decision : available[0] || decision;
  return new Response(JSON.stringify({ next_edge: next }), { headers: { "Content-Type": "application/json" } });
}