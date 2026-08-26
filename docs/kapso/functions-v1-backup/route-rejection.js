async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const available = body.available_edges || [];
  const reason = String(vars.rejection_reason || "").toLowerCase().trim();
  const cartChange = ["cambio_de_cantidad", "cambio_cantidad", "modify_cart", "agregar_producto", "eliminar_producto"].includes(reason);
  const known = ["precio_alto", "specs_equivocadas", "lo_pensare", "cambio_de_cantidad", "cambio_cantidad", "modify_cart", "agregar_producto", "eliminar_producto"];
  const count = Number(vars.iteration_count || 0) + (cartChange ? 0 : reason === "" || !known.includes(reason) ? 0 : 1);
  let next = cartChange ? (reason === "cambio_de_cantidad" || reason === "cambio_cantidad" ? "quantity_change" : "modify_cart") : reason === "" || !known.includes(reason) ? "clarify" : count >= 3 ? "human" : reason === "precio_alto" ? "price_high" : reason === "specs_equivocadas" ? "specs_wrong" : reason === "lo_pensare" ? "thinking" : "clarify";
  if (!available.includes(next)) next = available[0] || "human";
  return new Response(JSON.stringify({ next_edge: next, vars: { iteration_count: count, rejection_reason_ambiguous: next === "clarify" } }), { headers: { "Content-Type": "application/json" } });
}