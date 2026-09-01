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

// --- persistencia (Supabase) ---------------------------------------------
// Memoria del negocio, no un eslabon del flujo: nunca lanza, 4s de timeout,
// y sin secretos configurados no hace nada. Ver el spec 2026-08-31.
async function supabase(env, method, path, body, prefer) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  try {
    const base = String(env.SUPABASE_URL).replace(/\/+$/, "");
    const r = await fetch(`${base}/rest/v1${path}`, {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: prefer || (method === "POST" ? "resolution=merge-duplicates,return=minimal" : "count=none")
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return null;
  }
}

// El telefono de WhatsApp es la llave del cliente: llega solo, en el contexto.
function telefonoDesdeContexto(executionContext) {
  const ctx = executionContext?.context || {};
  const crudo = ctx.phone_number || ctx.contact?.wa_id || "";
  const digitos = String(crudo).replace(/\D/g, "");
  return digitos.length > 0 ? digitos : null;
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
  // .trim(): la lista blanca del rele compara contra valores que si vienen
  // recortados de su lado (apps/mailer/api/send.ts). Un secreto de Kapso
  // pegado con un espacio de mas convertiria todas las ordenes en
  // 403 destinatario_no_permitido.
  const destino = String(env.OC_EMAIL_DESTINO || DESTINO_DEFAULT).trim();

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
  const giro = String(vars.billing_giro || "No informado");
  const direccion = String(vars.billing_direccion || "No informado");
  const comuna = String(vars.billing_comuna || "No informado");
  const ciudad = String(vars.billing_ciudad || "No informado");
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
  const filasPedidos = [];
  const telefono = telefonoDesdeContexto(body.execution_context);

  for (const [proveedor, lineas] of grupos) {
    const orderKey = `${quote.quote_id}:${version}:${proveedor}`;
    const poId = `oc-${orderKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const ahora = new Date().toISOString();

    // El detalle con costos se calcula ANTES de la idempotencia: la fila de
    // /pedidos lo persiste en TODAS las ramas (tambien failed/duplicate), y
    // el PDF de la orden (GET /api/orden/<po_id>) se dibuja desde ahi.
    const detalle = lineas.map((linea) => {
      const costoUnitario = Math.round((Number(linea.precio_unitario_usd) / (1 + margen)) * 100) / 100;
      return { ...linea, costo_unitario_usd: costoUnitario, costo_total_usd: Math.round(costoUnitario * Number(linea.cantidad) * 100) / 100 };
    });
    const totalUsd = Math.round(detalle.reduce((suma, l) => suma + l.costo_total_usd, 0) * 100) / 100;

    // Una fila de /pedidos por rama de la maquina de estados de abajo; las
    // cinco ramas solo difieren en `estado` y `email_id`, asi que arman la
    // fila igual (mismo proveedor, mismas lineas) via este closure en vez de
    // repetir el objeto cinco veces con margen para que alguna copia se
    // desincronice de las demas. Las lineas guardadas son el `detalle` (un
    // superconjunto de las lineas de la cotizacion: agrega los costos), no
    // las lineas peladas: sin costo guardado, el PDF de la orden no tendria
    // que mostrar.
    const registrarPedido = (estado, emailId) => {
      filasPedidos.push({
        po_id: poId,
        quote_id: quote.quote_id,
        quote_version: version,
        proveedor,
        telefono,
        rut: rut === "No informado" ? null : rut,
        razon_social: razon === "No informado" ? null : razon,
        lineas: detalle,
        neto_grupo_clp: detalle.reduce((suma, l) => suma + (Number(l.subtotal_neto_clp) || 0), 0),
        estado,
        email_id: emailId
      });
    };

    let saltar = false;
    try {
      await env.DB.prepare(
        "INSERT INTO purchase_orders (order_key, po_id, quote_id, quote_version, proveedor, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)"
      ).bind(orderKey, poId, String(quote.quote_id), version, proveedor, ahora, ahora).run();
    } catch (_) {
      const existente = await env.DB.prepare("SELECT po_id, status, email_id, updated_at FROM purchase_orders WHERE order_key = ? LIMIT 1").bind(orderKey).first();

      if (!existente) {
        // El INSERT fallo y ademas no hay fila: no fue un choque de clave, fue
        // D1 caida, bloqueada o sin espacio. Sin fila persistida la
        // idempotencia no existe, y cada reintento reenviaria esta misma orden
        // al mayorista. Se aborta esta orden; las demas siguen.
        resultados.push({ proveedor, po_id: poId, status: "failed", lineas: lineas.length });
        registrarPedido("failed", null);
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
          // El estado y el email_id de la fila son los de D1 (la verdad de lo
          // que de verdad paso), nunca el literal "duplicate": una segunda
          // invocacion no puede pisar el email_id de un envio real con null
          // solo porque esta corrida no volvio a mandar el correo.
          registrarPedido(estado, existente.email_id ?? null);
          saltar = true;
        } else {
          await env.DB.prepare("UPDATE purchase_orders SET status = 'processing', error = NULL, updated_at = ? WHERE order_key = ?").bind(ahora, orderKey).run();
        }
      }
    }
    if (saltar) continue;

    const filas = detalle.map((l) =>
      `<tr><td>${escapar(l.sku_proveedor)}</td><td>${escapar(l.mpn || "-")}</td><td>${escapar(l.nombre)}</td><td>${escapar(l.cantidad)}</td><td>US$ ${escapar(l.costo_unitario_usd)}</td><td>US$ ${escapar(l.costo_total_usd)}</td><td>${escapar(l.abastecimiento)}</td></tr>`
    ).join("");

    const aviso = incompletos.length > 0
      ? `<p><b>Ojo:</b> al cotizar no respondieron ${escapar(incompletos.join(", "))}. El precio ganador lo es solo entre los que sí respondieron.</p>`
      : "";

    // Link al PDF formal de esta orden (GET /api/orden/<po_id> en el rele).
    // La URL contiene el UUID de la cotizacion: mismo modelo capability-URL
    // que el PDF de cotizacion. Ojo que el documento lleva COSTOS: es tan
    // interno como este mismo correo.
    const pdfBase = String(env.ORDEN_PDF_BASE || "").trim().replace(/\/+$/, "");
    const pdfUrl = pdfBase ? `${pdfBase}/${poId}` : null;
    const pdfHtml = pdfUrl ? `<p><b>PDF de la orden:</b> <a href="${escapar(pdfUrl)}">${escapar(pdfUrl)}</a></p>` : "";

    const html = `<h2>Orden de compra ${escapar(poId)}</h2>`
      + `<p><b>Mayorista:</b> ${escapar(proveedor.toUpperCase())}<br><b>Cotización:</b> ${escapar(quote.quote_id)} v${escapar(version)}</p>`
      + `<table border="1" cellpadding="4" cellspacing="0"><tr><th>SKU ${escapar(proveedor)}</th><th>MPN</th><th>Producto</th><th>Cant.</th><th>Costo unit.</th><th>Costo total</th><th>Abastecimiento</th></tr>${filas}</table>`
      + `<p><b>Total de esta orden:</b> US$ ${escapar(totalUsd)}</p>`
      + pdfHtml
      + `<h3>Cliente</h3><p>${escapar(cliente)}<br>RUT: ${escapar(rut)}<br>Razón social: ${escapar(razon)}<br>Email: ${escapar(email)}</p>`
      + `<p>Pago del cliente: contado.</p>${aviso}`;

    const texto = [
      `Orden de compra ${poId}`,
      `Mayorista: ${proveedor.toUpperCase()}`,
      `Cotización: ${quote.quote_id} v${version}`,
      ...detalle.map((l) => `${l.sku_proveedor} | ${l.mpn || "-"} | ${l.nombre} | ${l.cantidad} x US$ ${l.costo_unitario_usd} = US$ ${l.costo_total_usd}`),
      `Total: US$ ${totalUsd}`,
      ...(pdfUrl ? [`PDF: ${pdfUrl}`] : []),
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
      registrarPedido("failed", null);
      continue;
    }

    if (!respuesta.ok) {
      // El rele nunca devuelve `message` (eso era Resend): en un fallo
      // devuelve `error` y, si el transporte se cayo, tambien `codigo`
      // (EAUTH, ETIMEDOUT...). Se combinan los dos cuando estan, para que la
      // fila diga algo util en vez de caer siempre al generico.
      const partes = [cuerpo?.error, cuerpo?.codigo].filter((parte) => typeof parte === "string" && parte !== "");
      const mensaje = partes.length > 0 ? partes.join(": ") : "No se pudo enviar la orden.";
      await env.DB.prepare("UPDATE purchase_orders SET status = 'failed', error = ?, updated_at = ? WHERE order_key = ?")
        .bind(mensaje, new Date().toISOString(), orderKey).run();
      resultados.push({ proveedor, po_id: poId, status: "failed", lineas: lineas.length });
      registrarPedido("failed", null);
      continue;
    }

    await env.DB.prepare("UPDATE purchase_orders SET status = 'sent', email_id = ?, error = NULL, updated_at = ? WHERE order_key = ?")
      .bind(cuerpo.id || null, new Date().toISOString(), orderKey).run();
    resultados.push({ proveedor, po_id: poId, status: "sent", lineas: lineas.length });
    registrarPedido("sent", cuerpo.id || null);
  }

  const todasOk = resultados.every((r) => r.status === "sent" || r.status === "duplicate");

  // Registro de negocio, best-effort. D1 ya guardo la verdad tecnica; esto es
  // lo que el humano quiere mirar despues. Un fallo se declara, no se esconde.
  let persistencia;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    const escrituras = [supabase(env, "POST", "/pedidos?on_conflict=po_id", filasPedidos)];
    // Upsert solo si los siete campos de facturacion llegaron informados: un
    // agente que cerro con 5 de 7 (una reentrada por RUT invalido, un
    // handoff a medio llenar) no debe pisar la fila buena que ya estaba
    // guardada de una compra anterior con "No informado". La venta no se
    // toca por esto — el correo de la orden ya salio —, solo se omite esta
    // escritura de memoria.
    const datosClienteCompletos = telefono
      && [rut, razon, giro, direccion, comuna, ciudad, email].every((campo) => campo !== "No informado");
    if (datosClienteCompletos) {
      escrituras.push(supabase(env, "POST", "/clientes?on_conflict=telefono", {
        telefono,
        rut,
        razon_social: razon,
        giro,
        direccion,
        comuna,
        ciudad,
        email,
        updated_at: new Date().toISOString()
      }));
    }
    const resultadosEscritura = await Promise.all(escrituras);
    persistencia = resultadosEscritura.every((r) => r !== null) ? "ok" : "fallo";
  }

  return json({
    ok: true,
    ordenes: resultados,
    vars: {
      purchase_orders_result: resultados,
      purchase_orders_count: resultados.length,
      purchase_orders_ok: todasOk
    },
    ...(persistencia !== undefined ? { persistencia } : {})
  });
}
