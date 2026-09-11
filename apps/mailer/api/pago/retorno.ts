import type { VercelRequest, VercelResponse } from '@vercel/node';

// La pagina a la que Mercado Pago devuelve al cliente. No decide nada: la
// verdad del pago llega por el webhook. Solo lo devuelve a la conversacion.
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago recibido</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 system-ui,sans-serif; background:#f6f5f1; color:#1c1c1c; padding:24px; }
  main { max-width:26rem; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 .5rem; }
  p { margin:0; color:#4a4a4a; }
</style>
</head>
<body>
  <main>
    <h1>Listo</h1>
    <p>Vuelve a WhatsApp: apenas se acredite el pago te confirmamos el pedido por ahí.</p>
  </main>
</body>
</html>`);
}
