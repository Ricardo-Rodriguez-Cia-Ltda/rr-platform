# Conectar la API con el agente de Kapso

Paso a paso para que el LLM de WhatsApp pueda buscar productos y cotizarlos **sin ver nunca el precio de costo**.

## Arquitectura

```
Cliente (WhatsApp)
   ↓
Agente LLM en Kapso
   ↓ tool call
Kapso Function  ←── aqui vive el margen; el costo muere aqui
   ↓ HTTP + x-api-key
https://api.pyxis-latam.cl/rr/captador-precios
```

Las Kapso Functions son JavaScript sobre Cloudflare Workers. Son el nodo determinista: el costo entra a la función, sale precio de venta. Como el LLM nunca recibe el costo, no hay forma de que lo filtre aunque manipulen la conversación.

---

## Paso 1 — Crear los secretos

En Kapso → **Functions → Secrets**, crear:

| Secreto | Valor |
|---|---|
| `API_PRECIOS_KEY` | El `API_SECRET_KEY` de `.env.local` (el mismo del header `x-api-key`) |
| `MARGEN` | El margen como decimal. `0.30` = 30% sobre el costo |

Opcional: `API_PRECIOS_URL` si algún día cambia el dominio (por defecto usa el de producción).

> El margen vive aquí, no en el código: para cambiarlo se edita el secreto y no hay que redeployar nada.

## Paso 2 — Crear la Function `buscar_productos`

Kapso → **Functions → New**, nombre `buscar_productos`, y pegar el contenido de [`buscar-productos.js`](buscar-productos.js). Deploy.

## Paso 3 — Crear la Function `detalle_producto`

Igual que la anterior, con [`detalle-producto.js`](detalle-producto.js).

## Paso 4 — Adjuntar ambas como tools del Agent node

En el **Agent node** → Function tools, agregar las dos funciones con estos esquemas:

### `buscar_productos`

```json
{
  "type": "object",
  "properties": {
    "q": {
      "type": "string",
      "description": "Lo que busca el cliente, en palabras. Ej: 'notebook 14 pulgadas', 'impresora laser', 'teclado inalambrico'."
    },
    "marca": {
      "type": "string",
      "description": "Marca exacta del catalogo. Solo si el cliente la menciono o la eligio de las opciones ofrecidas."
    },
    "categoria": {
      "type": "string",
      "description": "Categoria exacta del catalogo. Solo si el cliente la eligio de las opciones ofrecidas."
    },
    "precio_max": {
      "type": "number",
      "description": "Presupuesto maximo del cliente en dolares (precio de venta)."
    },
    "limite": {
      "type": "integer",
      "description": "Cuantos productos traer. Por defecto 5; no pidas mas de 8 para no abrumar en WhatsApp."
    }
  },
  "required": ["q"]
}
```

### `detalle_producto`

```json
{
  "type": "object",
  "properties": {
    "sku": {
      "type": "string",
      "description": "SKU exacto tal como lo devolvio buscar_productos."
    }
  },
  "required": ["sku"]
}
```

## Paso 5 — Instrucciones en el system prompt

Agregar al prompt del agente:

```
## Busqueda de productos

Tienes dos herramientas: `buscar_productos` (encuentra productos con precio y
disponibilidad) y `detalle_producto` (ficha completa de un SKU que ya apareció
en una busqueda).

Reglas:

1. Nunca inventes precios, modelos ni disponibilidad. Si no lo devolvio una
   herramienta, no existe.
2. Los precios que recibes ya son precio final de venta al cliente, en dolares.
   Entregalos tal cual.
3. Si `buscar_productos` responde `estado: "demasiado_amplio"`, NO muestres
   productos. Usa las `opciones.marcas` y `opciones.categorias` para hacer UNA
   pregunta concreta al cliente, y vuelve a buscar con `marca` o `categoria`.
   Ejemplo: "Tengo varias opciones. ¿Buscas Lenovo o HP?"
4. Al pasar `marca` o `categoria`, usa exactamente uno de los valores que te
   devolvio la herramienta. No traduzcas ni inventes ("Hewlett-Packard" no
   existe en el catalogo; es "HP").
5. Muestra como maximo 3 o 4 productos por mensaje, con nombre y precio. Es
   WhatsApp: mensajes cortos.
6. Si `estado` es `no_disponible` o `error`, dile al cliente que hay un problema
   temporal y ofrece continuar en unos minutos. No inventes un catalogo.
7. Si un producto tiene `disponible: false`, no lo ofrezcas como disponible
   inmediato.

8. Si `buscar_productos` devuelve `estado: "sin_resultados_con_filtros"`,
   significa que SI hay productos que calzan, pero ninguno cumple lo que pidio
   el cliente. NO vuelvas a buscar. Cuentale la situacion y ofrecele la
   `alternativa` que viene en la respuesta:
   - `motivo: "sin_stock"` -> "No tengo ese producto disponible para entrega
     inmediata. Lo mas parecido que si tengo es X a $Y."
   - `motivo: "sobre_presupuesto"` -> "En ese presupuesto no tengo opciones. La
     mas economica disponible es X a $Y. Te sirve o prefieres ver otra marca?"

9. NUNCA repitas la misma busqueda con otras palabras esperando otro resultado.
   Si una busqueda vuelve vacia o no es lo que esperabas, habla con el cliente:
   pregunta o propone alternativas. Reintentar solo hace esperar al cliente.

10. En `q` usa pocas palabras clave del producto, no la frase completa del
    cliente. Bien: "notebook 14". Mal: "quiero un notebook hp de 14 pulgadas
    para la oficina". La marca va en `marca`, no repetida dentro de `q`.

11. El presupuesto (`precio_max`) va SIEMPRE en dolares. Si el cliente da un
    monto sin aclarar la moneda o habla en pesos chilenos, preguntale a cuanto
    equivale en dolares antes de buscar. No adivines el tipo de cambio.
```

## Paso 6 — Vocabulario del catálogo para el prompt

Para que el agente traduzca lo que pide el cliente a filtros reales, incluir esta lista en el prompt (obtenida de `GET /facetas`, actualizada al 2026-08-07):

**Categorías (32):** Computadores, Redes, Consumibles y Media, Celulares, Audio y Video, Periféricos, Vigilancia de Video, Accesorios para Computadores, Monitores, Almacenamiento, Componentes Informáticos, Protección de Poder, Memorias, Impresoras y Escáneres, Puntos de Venta, Maletines, Incendio, Control de Acceso, Electrodomésticos, Proyectores, Videojuegos, Seguridad y Automatización, Tecnología Portátil, Intrusión, Comunicaciones, Muebles, Cámaras & Videocámaras, Software, Accesorios, Juguetes, Transportación, Monitores & Proyectores.

**Marcas principales (144 en total):** Lenovo, HP, Hikvision, Xiaomi, Epson, Logitech, HPE, Brother, Klip Xtreme, StarTech.com, Xtech, Samsung, Panduit, ASUS, Ubiquiti, Kensington, TP-Link, Eaton, Nexxt Solutions Infrastructure, Motorola, APC, Viewsonic, Notifier, MSI, JBL.

Para regenerar la lista completa:

```bash
curl -H "x-api-key: <API_SECRET_KEY>" https://api.pyxis-latam.cl/rr/captador-precios/facetas
```

## Paso 7 — Probar antes de soltarlo a clientes

Conversaciones de prueba y qué debe pasar:

| Lo que dice el cliente | Comportamiento esperado |
|---|---|
| "busco un notebook" | El agente repregunta por marca (749 coincidencias → 409), no muestra productos |
| "un notebook HP" | Muestra 3-4 HP con precio de venta |
| "algo HP hasta 1500 dolares" | Filtra por presupuesto (convertido a costo internamente) |
| "cuentame mas del primero" | Llama `detalle_producto` con el SKU, no reinventa la ficha |
| "cuanto les cuesta a ustedes?" | No puede responder: nunca recibió el costo |

**Verificación clave:** en la última pregunta, revisa el historial de la ejecución en Kapso y confirma que en el payload que recibió el modelo no aparece ningún precio de costo. Si aparece, algo está mal conectado.

---

## Decisiones tomadas y cómo cambiarlas

- **Solo productos con stock.** Por defecto la función pide `solo_con_stock=true`: no tiene sentido cotizar lo que no se puede entregar. Para permitir sin stock, el agente puede mandar `incluir_sin_stock: true` (habría que agregarlo al esquema).
- **No se expone el stock exacto**, solo `disponible: true/false`. Si prefieres que el bot diga "quedan 3", cambia `disponible` por `stock: p.stock` en las funciones.
- **Precios en USD.** El catálogo de Intcomex cotiza en dólares y las funciones los entregan tal cual. Si quieres pesos chilenos, hay que agregar la conversión (y decidir de dónde sale el tipo de cambio, porque fijarlo a mano envejece mal).
- **Tope de presupuesto.** Si el cliente dice "hasta $500", eso es precio de venta; la función lo convierte a costo antes de filtrar. Si no se hiciera, el filtro dejaría fuera productos que sí caben en su presupuesto.
