async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  const base = String(env.API_PRECIOS_URL || "https://api.pyxis-latam.cl/rr/captador-precios").replace(/\/+$/, "");
  const apiKey = String(env.API_PRECIOS_KEY || "").trim();
  const rut = String(vars.rut_normalized || vars.billing_rut || "").trim();
  const total = Number(vars.quote_total_clp || vars.quote_result?.quote?.total_clp || vars.quote_result?.total_clp);
  if (!apiKey) return json({ estado: "error", aprobado: false, linea_disponible: 0, monto_solicitado: total || 0, codigo: "credito_no_configurado" }, 500);
  if (!rut || !Number.isFinite(total) || total <= 0) return json({ estado: "error", aprobado: false, linea_disponible: 0, monto_solicitado: total || 0, codigo: "datos_invalidos" }, 400);
  let response;
  try {
    response = await fetch(`${base}/credito/mock`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ rut, total_clp: total }), signal: AbortSignal.timeout(20000) });
  } catch (_) {
    return json({ estado: "no_disponible", aprobado: false, linea_disponible: 0, monto_solicitado: total, codigo: "credito_no_disponible" }, 503);
  }
  const data = await response.json().catch(() => ({}));
  const line = Number(data.disponible_clp ?? data.linea_credito_clp ?? 0);
  const requested = Number(data.solicitado_clp ?? total);
  const result = { estado: response.ok ? "ok" : "error", aprobado: data.aprobado === true, linea_disponible: Number.isFinite(line) ? line : 0, monto_solicitado: Number.isFinite(requested) ? requested : total, codigo: data.aprobado === true ? "aprobado" : "no_aprobado" };
  return json({ ...result, vars: { credit_result: result } }, response.ok ? 200 : 502);
}