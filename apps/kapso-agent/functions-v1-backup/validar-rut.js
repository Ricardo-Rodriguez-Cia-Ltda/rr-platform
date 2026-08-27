async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const raw = String(vars.billing_rut || vars.rut || "").toUpperCase();
  const clean = raw.replace(/[^0-9K]/g, "");
  let valid = /^\d{2,9}[0-9K]$/.test(clean);
  if (valid) {
    const digits = clean.slice(0, -1);
    let sum = 0;
    let multiplier = 2;
    for (let i = digits.length - 1; i >= 0; i--) { sum += Number(digits[i]) * multiplier; multiplier = multiplier === 7 ? 2 : multiplier + 1; }
    const remainder = 11 - (sum % 11);
    const dv = remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder);
    valid = dv === clean.slice(-1);
  }
  return new Response(JSON.stringify({ estado: "ok", rut: clean, rut_valid: valid, vars: { rut_normalized: clean, rut_valid: valid } }), { headers: { "Content-Type": "application/json" } });
}