async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const available = body.available_edges || [];
  const method = String(vars.payment_method || "").toLowerCase().trim();
  const next = method === "contado" ? "cash" : method === "credito" ? "credit" : "human";
  return new Response(JSON.stringify({ next_edge: available.includes(next) ? next : available[0] || next }), { headers: { "Content-Type": "application/json" } });
}