async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const quote = vars.quote_result?.quote || vars.quote_result || vars.quote || null;
  const recipient = "pyxis.latam@gmail.com";
  const from = env.RESEND_FROM_EMAIL;
  const apiKey = env.RESEND_API_KEY;
  const decision = String(vars.quote_decision || "");
  const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  if (decision !== "accepted") return json({ ok: false, error: "La cotización no está aceptada." }, 400);
  if (String(vars.payment_method || "").toLowerCase() !== "contado") return json({ ok: false, error: "El crédito requiere revisión humana." }, 400);
  if (!quote || !Array.isArray(quote.lineas) || !quote.quote_id) return json({ ok: false, error: "Falta la cotización estructurada." }, 400);
  const validUntil = Date.parse(String(quote.valid_until || vars.quote_valid_until || ""));
  if (!Number.isFinite(validUntil) || Date.now() >= validUntil) return json({ ok: false, error: "La cotización expiró; debe recalcularse." }, 409);
  if (!from || !apiKey) return json({ ok: false, error: "Faltan RESEND_API_KEY o RESEND_FROM_EMAIL." }, 500);
  if (!env.DB) return json({ ok: false, error: "Falta la base D1 para idempotencia." }, 500);
  const quoteId = String(quote.quote_id);
  const quoteVersion = String(quote.version ?? vars.quote_version ?? "1");
  const orderKey = `${quoteId}:${quoteVersion}`;
  const orderId = `order-${orderKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare("INSERT INTO quote_orders (order_key, order_id, quote_id, quote_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', ?, ?)").bind(orderKey, orderId, quoteId, quoteVersion, now, now).run();
  } catch (error) {
    const existing = await env.DB.prepare("SELECT order_id, status, email_id, error FROM quote_orders WHERE order_key = ? LIMIT 1").bind(orderKey).first();
    if (existing && existing.status !== "failed") return json({ ok: true, duplicate: true, order_id: existing.order_id, status: existing.status, email_id: existing.email_id || null, error: existing.error || null, vars: { order_id: existing.order_id, order_created: existing.status === "sent", order_duplicate: true } });
    if (!existing) return json({ ok: false, error: "No se pudo reservar la orden de forma idempotente." }, 503);
    await env.DB.prepare("UPDATE quote_orders SET status = 'processing', error = NULL, updated_at = ? WHERE order_key = ? AND status = 'failed'").bind(new Date().toISOString(), orderKey).run();
  }
  const customer = String(vars.quote_customer_name || vars.customer_name || "No informado");
  const phone = String(vars.quote_customer_phone || vars.customer_phone || "No informado");
  const payment = String(vars.payment_method || "No informado");
  const billing = { rut: vars.billing_rut || "No informado", razon_social: vars.billing_razon_social || "No informado", giro: vars.billing_giro || "No informado", direccion: vars.billing_direccion || "No informado", comuna: vars.billing_comuna || "No informado", ciudad: vars.billing_ciudad || "No informado", email: vars.billing_email || "No informado" };
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const immediate = quote.lineas.filter((line) => line.disponible);
  const sourcing = quote.lineas.filter((line) => !line.disponible);
  const render = (lines) => lines.map((line) => `<li>${escape(line.nombre)} | SKU ${escape(line.sku || "-")} | ${escape(line.cantidad)} x $${escape(line.precio_unitario_clp)} = $${escape(line.subtotal_neto_clp)} CLP</li>`).join("") || "<li>Ninguno</li>";
  const html = `<h2>Erik! Nueva orden ${escape(orderId)}</h2><p><b>Cotización:</b> ${escape(quoteId)} v${escape(quoteVersion)}</p><p><b>Cliente:</b> ${escape(customer)}<br><b>WhatsApp:</b> ${escape(phone)}<br><b>Pago:</b> ${escape(payment)}</p><h3>Stock inmediato</h3><ul>${render(immediate)}</ul><h3>Por comprar/importar</h3><ul>${render(sourcing)}</ul><p><b>Neto:</b> $${escape(quote.neto_clp)} CLP<br><b>IVA:</b> $${escape(quote.iva_clp)} CLP<br><b>Total:</b> $${escape(quote.total_clp)} CLP</p><h3>Facturación</h3><p>RUT: ${escape(billing.rut)}<br>Razón social: ${escape(billing.razon_social)}<br>Giro: ${escape(billing.giro)}<br>Dirección: ${escape(billing.direccion)}<br>Comuna: ${escape(billing.comuna)}<br>Ciudad: ${escape(billing.ciudad)}<br>Email: ${escape(billing.email)}</p>`;
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [recipient], subject: `Nueva orden ${orderId} - cotización ${quoteId}`, html, text: `Nueva orden ${orderId}\nCotización ${quoteId} v${quoteVersion}\nCliente: ${customer}\nWhatsApp: ${phone}\nPago: ${payment}\nStock inmediato: ${immediate.length} líneas\nPor comprar/importar: ${sourcing.length} líneas\nNeto: ${quote.neto_clp} CLP\nIVA: ${quote.iva_clp} CLP\nTotal: ${quote.total_clp} CLP` }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    await env.DB.prepare("UPDATE quote_orders SET status = 'failed', error = ?, updated_at = ? WHERE order_key = ?").bind(String(result?.message || "No se pudo enviar la orden."), new Date().toISOString(), orderKey).run();
    return json({ ok: false, error: result?.message || "No se pudo enviar la orden." }, 502);
  }
  const emailId = result.id || null;
  await env.DB.prepare("UPDATE quote_orders SET status = 'sent', email_id = ?, error = NULL, updated_at = ? WHERE order_key = ?").bind(emailId, new Date().toISOString(), orderKey).run();
  return json({ ok: true, order_id: orderId, email_id: emailId, vars: { order_id: orderId, order_created: true } });
}