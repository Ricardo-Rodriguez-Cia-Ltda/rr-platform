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

## `apps/kapso-agent/` — la integración con el agente de WhatsApp

Empieza por aquí si vas a **conectar** la API a un agente conversacional. Vive
fuera de `docs/`, en `apps/`, porque es algo que se despliega (a la cuenta de
Kapso), no solo documentación.

- [`../apps/kapso-agent/README.md`](../apps/kapso-agent/README.md) — operación
  de `rr-isia-version2` (la generación vigente): mapa de functions, secretos,
  cómo redesplegar, cómo cambiar el margen, la tabla `purchase_orders` y qué
  revisar cuando una orden queda `failed`.
- [`../apps/kapso-agent/README-v1.md`](../apps/kapso-agent/README-v1.md) —
  paso a paso de la generación anterior (`Rayo Perez`): dónde vive el margen,
  cómo se evita que el modelo vea el precio de costo, esquemas de las tools y
  reglas para el system prompt.
- `../apps/kapso-agent/functions/` — las seis Kapso Functions de
  `rr-isia-version2` que envuelven la API y aplican el margen.
  `../apps/kapso-agent/functions-v1-backup/` guarda el código de las de v1 que
  ya se borraron de la cuenta.
- [`../apps/kapso-agent/prompts/`](../apps/kapso-agent/prompts/) — el
  `system_prompt` de cada nodo `agent` del workflow vigente, una versión por
  archivo. Empieza por su
  [README](../apps/kapso-agent/prompts/README.md): explica la convención de
  versionado y el principio de latencia que ordena todos los prompts.
  `../apps/kapso-agent/prompts-v1/` guarda los prompts de la generación
  anterior con el mismo formato.
- `../apps/kapso-agent/prompts-rayo/` — histórico: el prompt monolítico de
  cuando todo el flujo vivía en un solo nodo. Ya no se despliega.

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
| `apps/kapso-agent/prompts/`, `prompts-v1/` | [`apps/kapso-agent/tests/prompts.test.ts`](../apps/kapso-agent/tests/prompts.test.ts) verifica el formato de cada versión: cabecera completa, delimitadores del prompt y un solo `vigente` por agente. El contenido se escribe a mano. |
| `apps/kapso-agent/` (resto), `superpowers/` | A mano. |
