# Documentación

Índice de qué hay aquí y para qué sirve cada cosa.

## `api/` — la referencia de la API

Empieza por aquí si vas a **consumir** la API.

- [`api/README.md`](api/README.md) — referencia completa: endpoints, parámetros,
  formas de respuesta, todos los códigos de error, cómo funciona el ranking de
  búsqueda y cuándo tiene sentido reintentar. Escrita para ser leída por un LLM.
- [`api/openapi.yaml`](api/openapi.yaml) — el mismo contrato en OpenAPI 3.1,
  para generar clientes o alimentar herramientas.
- [`api/vocabulario.md`](api/vocabulario.md) — marcas y categorías reales del
  catálogo, con conteos. **Archivo generado**: `npm run docs:vocabulario`.

## `kapso/` — la integración con el agente de WhatsApp

Empieza por aquí si vas a **conectar** la API a un agente conversacional.

- [`kapso/README.md`](kapso/README.md) — paso a paso: dónde vive el margen, cómo
  se evita que el modelo vea el precio de costo, esquemas de las tools y reglas
  para el system prompt.
- `kapso/buscar-productos.js`, `kapso/detalle-producto.js` — las Kapso Functions
  que envuelven la API y aplican el margen.
- [`kapso/prompts/`](kapso/prompts/) — el `system_prompt` de cada nodo `agent`
  del workflow, una versión por archivo. Empieza por su
  [README](kapso/prompts/README.md): explica la convención de versionado y el
  principio de latencia que ordena todos los prompts.
- `kapso/prompts-rayo/` — histórico: el prompt monolítico de cuando todo el flujo
  vivía en un solo nodo. Ya no se despliega.

## `superpowers/` — historia de diseño

Specs y planes de cada feature, en orden cronológico. Sirven para entender **por
qué** algo está hecho así; no son la referencia de cómo funciona hoy. Para eso
está `api/`.

---

## Cómo se mantiene esto

| Documento | Mecanismo |
|---|---|
| `api/README.md`, `api/openapi.yaml` | [`tests/docs.test.ts`](../tests/docs.test.ts) falla en `npm test` si las rutas, códigos de error, status, nombres de campo o constantes citadas dejan de coincidir con el código. La prosa y las formas de respuesta se actualizan a mano al tocar `api/`. |
| `api/vocabulario.md` | Regenerado desde la API en vivo con `npm run docs:vocabulario`. |
| `kapso/prompts/` | [`tests/prompts.test.ts`](../tests/prompts.test.ts) verifica el formato de cada versión: cabecera completa, delimitadores del prompt y un solo `vigente` por agente. El contenido se escribe a mano. |
| `kapso/` (resto), `superpowers/` | A mano. |
