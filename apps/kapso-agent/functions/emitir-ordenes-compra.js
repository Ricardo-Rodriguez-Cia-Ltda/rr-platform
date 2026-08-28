const DESTINO_DEFAULT = "pyxis.latam@gmail.com";

// Una fila que quedo en 'processing' mas tiempo que esto es una corrida que se
// murio entre el INSERT y el UPDATE terminal (limite de CPU, reintento del
// nodo). No es un duplicado: es una orden que nunca se mando.
const ABANDONO_MS = 10 * 60 * 1000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function escapar(valor) {
  return String(valor)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const quote = vars.quote_result?.quote || vars.quote_result || null;

  // `quote_confirmed` la escribe el LLM con save_variable, asi que puede llegar
  // como booleano o como la cadena "true". Cualquier otra cosa no es un si.
  const confirmado = vars.quote_confirmed === true
    || String(vars.quote_confirmed ?? "").trim().toLowerCase() === "true";

  if (!confirmado) return json({ ok: false, error: "El cliente no ha confirmado la orden." }, 400);
  if (!quote || !Array.isArray(quote.lineas) || quote.lineas.length === 0 || !quote.quote_id) {
    return json({ ok: false, error: "Falta la cotización estructurada." }, 400);
  }

  // El unico chequeo de vigencia del grafo (fn_check_validity) corre ANTES de
  // agente_cierre, que es una conversacion de WhatsApp sin limite de tiempo. Si
  // el cliente confirma cuatro horas despues, las ordenes irian contra precios
  // vencidos: se revisa aca, que es el ultimo punto antes de emitir.
  const vigenteHasta = Date.parse(String(quote.valid_until || vars.quote_valid_until || ""));
  if (!Number.isFinite(vigenteHasta) || Date.now() >= vigenteHasta) {
    return json({ ok: false, error: "La cotización expiró; debe recalcularse." }, 409);
  }

  const margen = Number(env.MARGEN ?? "0.13");
  const mailerUrl = env.MAILER_URL;
  const mailerKey = env.MAILER_API_KEY;
  const destino = String(env.OC_EMAIL_DESTINO || DESTINO_DEFAULT);

  // Mayor que cero: un secreto MARGEN vacio coacciona a 0 y dejaria el costo
  // reconstruido igual al precio de venta.
  if (!Number.isFinite(margen) || margen <= 0) return json({ ok: false, error: "Margen mal configurado." }, 500);
  if (!mailerUrl || !mailerKey) return json({ ok: false, error: "Faltan MAILER_URL o MAILER_API_KEY." }, 500);
  if (!env.DB) return json({ ok: false, error: "Falta la base D1 para idempotencia." }, 500);

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS purchase_orders (order_key TEXT PRIMARY KEY, po_id TEXT, quote_id TEXT, quote_version TEXT, proveedor TEXT, status TEXT, email_id TEXT, error TEXT, created_at TEXT, updated_at TEXT)"
  ).run();

  const version = String(quote.version ?? vars.quote_version ?? "1");
  const cliente = String(vars.quote_customer_name || "No informado");
  const rut = String(vars.billing_rut || "No informado");
  const razon = String(vars.billing_razon_social || "No informado");
  const email = String(vars.billing_email || "No informado");
  const incompletos = Array.isArray(quote.proveedores_incompletos) ? quote.proveedores_incompletos : [];

  // Una orden por mayorista: el group by es sobre el ganador que quedo
  // congelado en la cotizacion, no sobre una consulta nueva de precios.
  const grupos = new Map();
  for (const linea of quote.lineas) {
    const proveedor = String(linea.proveedor || "desconocido");
    if (!grupos.has(proveedor)) grupos.set(proveedor, []);
    grupos.get(proveedor).push(linea);
  }

  const resultados = [];

  for (const [proveedor, lineas] of grupos) {
    const orderKey = `${quote.quote_id}:${version}:${proveedor}`;
    const poId = `oc-${orderKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const ahora = new Date().toISOString();

    let saltar = false;
    try {
      await env.DB.prepare(
        "INSERT INTO purchase_orders (order_key, po_id, quote_id, quote_version, proveedor, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)"
      ).bind(orderKey, poId, String(quote.quote_id), version, proveedor, ahora, ahora).run();
    } catch (_) {
      const existente = await env.DB.prepare("SELECT po_id, status, updated_at FROM purchase_orders WHERE order_key = ? LIMIT 1").bind(orderKey).first();

      if (!existente) {
        // El INSERT fallo y ademas no hay fila: no fue un choque de clave, fue
        // D1 caida, bloqueada o sin espacio. Sin fila persistida la
        // idempotencia no existe, y cada reintento reenviaria esta misma orden
        // al mayorista. Se aborta esta orden; las demas siguen.
        resultados.push({ proveedor, po_id: poId, status: "failed", lineas: lineas.length });
        saltar = true;
      } else {
        const estado = String(existente.status || "");
        const actualizado = Date.parse(String(existente.updated_at || ""));
        // 'processing' vieja = corrida abandonada. Solo se reintenta cuando se
        // puede probar la antiguedad: sin fecha legible, no hay evidencia de
        // abandono y tratarla como duplicado es el error reversible.
        const abandonada = estado === "processing"
          && Number.isFinite(actualizado)
          && Date.now() - actualizado > ABANDONO_MS;

        if (estado !== "failed" && !abandonada) {
          resultados.push({ proveedor, po_id: String(existente.po_id || poId), status: "duplicate", lineas: lineas.length });
          saltar = true;
        } else {
          await env.DB.prepare("UPDATE purchase_orders SET status = 'processing', error = NULL, updated_at = ? WHERE order_key = ?").bind(ahora, orderKey).run();
        }
      }
    }
    if (saltar) continue;

    const detalle = lineas.map((linea) => {
      const costoUnitario = Math.round((Number(linea.precio_unitario_usd) / (1 + margen)) * 100) / 100;
      return { ...linea, costo_unitario_usd: costoUnitario, costo_total_usd: Math.round(costoUnitario * Number(linea.cantidad) * 100) / 100 };
    });
    const totalUsd = Math.round(detalle.reduce((suma, l) => suma + l.costo_total_usd, 0) * 100) / 100;

    const filas = detalle.map((l) =>
      `<tr><td>${escapar(l.sku_proveedor)}</td><td>${escapar(l.mpn || "-")}</td><td>${escapar(l.nombre)}</td><td>${escapar(l.cantidad)}</td><td>US$ ${escapar(l.costo_unitario_usd)}</td><td>US$ ${escapar(l.costo_total_usd)}</td><td>${escapar(l.abastecimiento)}</td></tr>`
    ).join("");

    const aviso = incompletos.length > 0
      ? `<p><b>Ojo:</b> al cotizar no respondieron ${escapar(incompletos.join(", "))}. El precio ganador lo es solo entre los que sí respondieron.</p>`
      : "";

    const html = `<h2>Orden de compra ${escapar(poId)}</h2>`
      + `<p><b>Mayorista:</b> ${escapar(proveedor.toUpperCase())}<br><b>Cotización:</b> ${escapar(quote.quote_id)} v${escapar(version)}</p>`
      + `<table border="1" cellpadding="4" cellspacing="0"><tr><th>SKU ${escapar(proveedor)}</th><th>MPN</th><th>Producto</th><th>Cant.</th><th>Costo unit.</th><th>Costo total</th><th>Abastecimiento</th></tr>${filas}</table>`
      + `<p><b>Total de esta orden:</b> US$ ${escapar(totalUsd)}</p>`
      + `<h3>Cliente</h3><p>${escapar(cliente)}<br>RUT: ${escapar(rut)}<br>Razón social: ${escapar(razon)}<br>Email: ${escapar(email)}</p>`
      + `<p>Pago del cliente: contado.</p>${aviso}`;

    const texto = [
      `Orden de compra ${poId}`,
      `Mayorista: ${proveedor.toUpperCase()}`,
      `Cotización: ${quote.quote_id} v${version}`,
      ...detalle.map((l) => `${l.sku_proveedor} | ${l.mpn || "-"} | ${l.nombre} | ${l.cantidad} x US$ ${l.costo_unitario_usd} = US$ ${l.costo_total_usd}`),
      `Total: US$ ${totalUsd}`,
      `Cliente: ${cliente} | RUT ${rut} | ${razon} | ${email}`,
      "Pago del cliente: contado."
    ].join("\n");

    const subject = `OC ${poId} · ${proveedor.toUpperCase()} · cotización ${quote.quote_id}`;

    let respuesta;
    let cuerpo = {};
    try {
      respuesta = await fetch(mailerUrl, {
        method: "POST",
        headers: { "x-api-key": mailerKey, "Content-Type": "application/json" },
        body: JSON.stringify({ to: destino, subject, html, text: texto })
      });
      cuerpo = await respuesta.json().catch(() => ({}));
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : "Error desconocido en fetch";
      await env.DB.prepare("UPDATE purchase_orders SET status = 'failed', error = ?, updated_at = ? WHERE order_key = ?")
        .bind(mensaje, new Date().toISOString(), orderKey).run();
      resultados.push({ proveedor, po_id: poId, status: "failed", lineas: lineas.length });
      continue;
    }

    if (!respuesta.ok) {
      await env.DB.prepare("UPDATE purchase_orders SET status = 'failed', error = ?, updated_at = ? WHERE order_key = ?")
        .bind(String(cuerpo?.message || "No se pudo enviar la orden."), new Date().toISOString(), orderKey).run();
      resultados.push({ proveedor, po_id: poId, status: "failed", lineas: lineas.length });
      continue;
    }

    await env.DB.prepare("UPDATE purchase_orders SET status = 'sent', email_id = ?, error = NULL, updated_at = ? WHERE order_key = ?")
      .bind(cuerpo.id || null, new Date().toISOString(), orderKey).run();
    resultados.push({ proveedor, po_id: poId, status: "sent", lineas: lineas.length });
  }

  const todasOk = resultados.every((r) => r.status === "sent" || r.status === "duplicate");

  return json({
    ok: true,
    ordenes: resultados,
    vars: {
      purchase_orders_result: resultados,
      purchase_orders_count: resultados.length,
      purchase_orders_ok: todasOk
    }
  });
}
