async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const quote = vars.quote_result?.quote || vars.quote_result || {};
  if (!apiKey || !from) return new Response(JSON.stringify({ ok: false, error: "Faltan secretos de correo." }), { status: 500, headers: { "Content-Type": "application/json" } });
  const customer = String(vars.quote_customer_name || "No informado");
  const phone = String(vars.quote_customer_phone || "No informado");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: ["pyxis.latam@gmail.com"], subject: `Cliente dejó cotización pendiente ${quote.quote_id || ""}`, text: `Cliente: ${customer}\nWhatsApp: ${phone}\nCotización: ${quote.quote_id || ""}\nTotal CLP: ${quote.total_clp || ""}\nEl cliente indicó que lo pensará.` }) });
  const result = await response.json().catch(() => ({}));
  return new Response(JSON.stringify({ ok: response.ok, email_id: result.id || null }), { status: response.ok ? 200 : 502, headers: { "Content-Type": "application/json" } });
}