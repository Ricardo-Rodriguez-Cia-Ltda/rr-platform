async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const disponibles = body.available_edges || [];
  // Cualquier valor que no sea un si explicito rutea a rejected: volver a
  // descubrimiento se deshace, emitir ordenes de compra no.
  const decision = String(vars.quote_decision) === "accepted" ? "accepted" : "rejected";
  const next = disponibles.includes(decision) ? decision : disponibles[0] || decision;
  return new Response(JSON.stringify({ next_edge: next }), { headers: { "Content-Type": "application/json" } });
}
