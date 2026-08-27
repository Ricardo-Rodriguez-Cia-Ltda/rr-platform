# Prompts de los agentes — workflow "Rayo Perez"

Un directorio por nodo `agent` del workflow, una versión por archivo. El texto
que se pega en Kapso vive entre los delimitadores `<!-- PROMPT:INICIO -->` y
`<!-- PROMPT:FIN -->`: todo lo demás del archivo es documentación para nosotros,
no para el modelo.

**Workflow:** `155d9b86-f1f6-42cb-b40e-e623321d7a58` · canal WhatsApp · español chileno.

## Índice

| Directorio | Nodo Kapso | Responsabilidad | Vigente |
|---|---|---|---|
| [`agent-n1-descubrimiento/`](agent-n1-descubrimiento/) | `agent_n1` | Entiende la necesidad, busca productos, arma el carro | v-01 |
| [`agent-n3-presentacion/`](agent-n3-presentacion/) | `agent_n3` | Presenta la cotización y captura la decisión | v-01 |
| [`agent-n4-rechazo/`](agent-n4-rechazo/) | `agent_n4` | Clasifica el rechazo y recupera la venta | v-01 |
| [`agent-n5-facturacion/`](agent-n5-facturacion/) | `agent_n5` | Forma de pago y datos tributarios | v-01 |
| [`agent-main-cierre/`](agent-main-cierre/) | `agent_main` | Último mensaje antes de derivar al equipo comercial | v-01 |
| [`agent-partial-credit/`](agent-partial-credit/) | `agent_partial_credit` | Confirma pago mixto cuando el crédito cubre solo parte | — (borrador) |

Historial anterior al split en [`../prompts-rayo/`](../prompts-rayo/): v-01 a v-03
eran un **único prompt monolítico**, de cuando todo el flujo vivía en un solo
nodo `agent`. Ya no se despliegan; se conservan como referencia. De ahí salieron
el estilo, el silencio operativo y las reglas de catálogo que hoy están
repartidas entre `agent_n1`, `agent_n3` y `agent_main`.

> Los archivos de `prompts-rayo/` están fechados `07_08_2027`. Por el historial
> de git corresponden a agosto de **2026**; el nombre quedó con un año mal
> tipeado. Se dejan como están para no romper referencias.

## Convención de versionado

```
agent-<nodo>-<rol>/
  v-01.md      ← reemplazado
  v-02.md      ← vigente
```

- Un archivo por versión, numeración correlativa por agente. Nunca se edita una
  versión ya desplegada: se crea la siguiente.
- La cabecera de cada archivo lleva **Estado**: `vigente`, `reemplazado` o
  `borrador`. Solo puede haber **un `vigente` por agente**.
- Toda versión nueva explica en "Qué cambió" el porqué de cada cambio. Un
  cambio de prompt sin motivo escrito es imposible de revertir con criterio seis
  meses después.
- [`_plantilla.md`](_plantilla.md) tiene el esqueleto.

`tests/prompts.test.ts` verifica el formato en `npm test`: cabecera completa,
delimitadores presentes y exactamente un `vigente` por agente.

## Por qué seis prompts y no uno

El monolito de `prompts-rayo/` cargaba las reglas de facturación en el mismo
contexto donde el modelo estaba buscando notebooks. Separarlo tiene dos
beneficios medibles:

1. **Latencia.** El prompt entra completo en cada turno. Un prompt de 4.000
   tokens que solo usa 800 paga los otros 3.200 en cada mensaje del cliente.
2. **Precisión.** Reglas que no aplican al paso actual compiten por atención.
   `agent_n5` no debe siquiera saber que existe `buscar_productos`.

El costo es duplicación: el bloque de estilo se repite en los seis. Si se cambia
ese bloque, hay que sacar versión nueva de los seis. Es un intercambio
deliberado — Kapso no tiene includes en `system_prompt`.

## El principio que ordena todos estos prompts

> **Una pregunta al cliente cuesta entre 20 segundos y 10 minutos. Una llamada a
> herramienta cuesta entre 2 y 8 segundos.**

De ahí sale casi todo lo demás:

- Gastar una llamada extra para ahorrar una pregunta es **siempre** buen negocio.
- Gastar una pregunta para ahorrar una llamada, **nunca**.
- Pedir permiso ("¿te muestro opciones?") es un turno entero por cero información.
- Anunciar ("déjame buscar") es medio turno por cero información.
- Una pregunta cerrada con 2 o 3 opciones se responde con una palabra. Una
  pregunta abierta se responde con un párrafo que además hay que interpretar.

Y una excepción importante, que va contra el instinto conversacional:

- **En descubrimiento** se pregunta de a una cosa, porque cada respuesta cambia
  la pregunta siguiente.
- **En captura de datos** (facturación) se pregunta en bloque, porque los campos
  son fijos e independientes. Encadenar seis campos de a uno son seis turnos —
  varios minutos de reloj — para obtener exactamente lo mismo que un mensaje.

## Latencia real de las herramientas

Medida sobre el comportamiento de la API (ver [`../api/README.md`](../api/README.md)):

| Situación | Costo |
|---|---|
| `buscar_productos` normal | 1 lote de hasta 100 SKU contra Intcomex |
| `buscar_productos` con `precio_max` | hasta **3 lotes secuenciales** (la API sube el tope de candidatos de 50 a 300) |
| `demasiado_amplio` (409) | **gratis**: la API corta antes de cotizar nada |
| `detalle_producto` | un viaje completo más, y **no trae ficha más completa** que la búsqueda |

Tres consecuencias que están escritas en los prompts:

1. La Function ya manda `solo_con_stock=true` siempre, así que **toda búsqueda
   toma el camino largo**. Bajar `limite` a 3 hace que el bucle corte antes.
2. Un 409 no cuesta servidor pero cuesta un turno completo de conversación. La
   forma de evitarlo es un `q` más discriminante, no menos filtros.
3. `detalle_producto` solo agrega `subcategorias` sobre lo que la búsqueda ya
   entregó. Para "cuéntame más del primero" **no hay que llamarlo**: la respuesta
   ya está en contexto. Su único uso legítimo es re-verificar precio y stock de
   un SKU visto hace varios turnos, porque eso sí se consulta en vivo.

## Contrato de variables

Lo que cada agente puede leer y lo que debe dejar escrito. Un agente que escribe
una variable con otro nombre rompe el ruteo aguas abajo en silencio.

| Agente | Lee | Escribe |
|---|---|---|
| `agent_n1` | `budget_max`, `clear_cart`, `cart_items` | `cart_items`, `budget_max`, `clear_cart` |
| `agent_n3` | `quote_result` | `quote_decision`, `rejection_reason` |
| `agent_n4` | `quote_result`, `rejection_reason`, `cart_items` | `rejection_reason`, `budget_max`, `clear_cart`, `cart_items` |
| `agent_n5` | `quote_result` | `payment_method`, `factura`, `billing_*` |
| `agent_main` | todo el contexto | `quote_summary`, `quote_customer_name`, `quote_customer_phone`, `quote_subject`, `quote_confirmed` |
| `agent_partial_credit` | resultado del chequeo de crédito | `partial_credit_accepted` |

`rejection_reason` debe ser exactamente uno de los labels de `route-rejection`:
`price_high`, `specs_wrong`, `quantity_change`, `modify_cart`, `clarify`,
`thinking`, `human`. `quote_decision` uno de `accepted`, `rejected`, `pending`.
`payment_method` uno de `contado`, `credito`.
