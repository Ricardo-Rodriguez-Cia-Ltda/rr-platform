async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const available = body.available_edges || [];
  const raw = vars.quote_result?.quote?.valid_until || vars.quote_result?.valid_until || vars.quote_valid_until || "";
  const timestamp = Date.parse(String(raw));
  const expired = !Number.isFinite(timestamp) || Date.now() >= timestamp;
  const desired = expired ? "expired" : "valid";
  const next_edge = available.includes(desired) ? desired : available[0] || desired;
  return new Response(JSON.stringify({ next_edge, vars: { quote_expired: expired } }), { headers: { "Content-Type": "application/json" } });
}