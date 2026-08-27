async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const rawItems = vars.cart_items;
  let items = Array.isArray(rawItems) ? rawItems : null;
  if (!items && typeof rawItems === "string") { try { const parsed = JSON.parse(rawItems); items = Array.isArray(parsed) ? parsed : null; } catch (_) {} }
  const apiKey = String(env.API_PRECIOS_KEY || "").trim();
  const margin = Number(env.MARGEN ?? "0.30");
  const exchangeRate = Number(env.TIPO_CAMBIO_CLP_USD ?? "950");
  const ivaRate = Number(env.IVA_RATE ?? "0.19");
  const validHours = Number(env.COTIZACION_VALID_HOURS ?? "3");
  const base = String(env.API_PRECIOS_URL || "https://api.pyxis-latam.cl/rr/captador-precios").replace(/\/+$/, "");
  const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  const salePrice = (cost) => { const value = Number(cost); return Number.isFinite(value) && value >= 0 ? Math.round(value * (1 + margin) * 100) / 100 : null; };
  if (!apiKey) return json({ estado: "error", mensaje: "La cotización no está configurada." }, 500);
  if (![margin, exchangeRate, ivaRate, validHours].every(Number.isFinite) || margin < 0 || exchangeRate <= 0 || ivaRate < 0 || validHours <= 0) return json({ estado: "error", mensaje: "La configuración de cotización no es válida." }, 500);
  if (!items || items.length === 0 || items.length > 50) return json({ estado: "error", mensaje: "El carro no es válido." }, 400);
  const lines = [];
  for (const item of items) {
    const quantity = Number(item.cantidad ?? item.quantity);
    const sku = String(item.sku ?? "").trim();
    const mpn = String(item.mpn ?? "").trim();
    const upc = String(item.upc ?? "").trim();
    if (!sku && !mpn && !upc) return json({ estado: "error", mensaje: "Una línea no tiene identificador." }, 400);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return json({ estado: "error", mensaje: "Una línea tiene cantidad inválida." }, 400);
    const params = new URLSearchParams();
    if (sku) params.set("sku", sku); else if (mpn) params.set("mpn", mpn); else params.set("upc", upc);
    params.set("provider", "intcomex");
    let response;
    try { response = await fetch(`${base}/price?${params.toString()}`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(25000) }); } catch (_) { return json({ estado: "no_disponible", mensaje: "No se pudo revalidar el catálogo." }, 503); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) return json({ estado: "producto_no_disponible", sku: sku || mpn || upc, mensaje: "Un producto ya no tiene precio vigente." }, 409);
    if (response.status === 503) return json({ estado: "no_disponible", mensaje: "El catálogo no está disponible para revalidar." }, 503);
    if (!response.ok) return json({ estado: "error", mensaje: "No se pudo revalidar la cotización." }, 502);
    const unitUsd = salePrice(data.price);
    const stockSignal = typeof data.disponible === "boolean" ? data.disponible : (typeof data.inStock === "boolean" ? data.inStock : null);
    const stockCount = stockSignal === null && data.inStock != null ? Number(data.inStock) : null;
    if (unitUsd === null || (stockCount !== null && !Number.isFinite(stockCount))) return json({ estado: "error", mensaje: "La respuesta del proveedor no es válida." }, 502);
    const unitClp = Math.round(unitUsd * exchangeRate);
    const subtotal = unitClp * quantity;
    const disponible = stockSignal !== null ? stockSignal : stockCount !== null ? stockCount > 0 : false;
    lines.push({ sku: data.sku || sku || null, mpn: data.mpn || mpn || null, nombre: item.nombre || data.description || "Producto", cantidad: quantity, precio_unitario_usd: unitUsd, precio_unitario_clp: unitClp, subtotal_neto_clp: subtotal, disponible, abastecimiento: disponible ? "stock_inmediato" : "por_comprar_importar" });
  }
  const neto = lines.reduce((sum, line) => sum + line.subtotal_neto_clp, 0);
  const iva = Math.round(neto * ivaRate);
  const now = new Date();
  const quote = { quote_id: crypto.randomUUID(), version: 1, moneda: "CLP", tipo_cambio_clp_usd: exchangeRate, iva_rate: ivaRate, lineas: lines, neto_clp: neto, iva_clp: iva, total_clp: neto + iva, created_at: now.toISOString(), valid_until: new Date(now.getTime() + validHours * 3600000).toISOString() };
  return json({ estado: "ok", quote, vars: { quote_result: quote, quote_id: quote.quote_id, quote_version: quote.version, quote_total_clp: quote.total_clp, quote_valid_until: quote.valid_until } });
}