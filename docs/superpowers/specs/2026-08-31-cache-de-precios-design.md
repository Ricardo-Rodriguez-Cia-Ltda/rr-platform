# Diseño: caché de precios para la búsqueda

**Fecha:** 2026-08-31
**Estado:** Aprobado

## Problema

Cada búsqueda con filtros cotiza precios y stock **en vivo** contra Intcomex,
por lotes de hasta 100 SKUs. El 2026-08-31 Intcomex pasó el día lento (~7s por
lote, lo normal es ~2,5s) y además botando conexiones sueltas, y cada uno de
esos problemas llegó hasta el cliente de WhatsApp: esperas que mataban la
conversación, un "está fallando el sistema", un "es un problema técnico de mi
lado". Ese día ya se mitigó con tres cambios (ronda paralela, reintento de red,
presupuesto de tiempo), pero la dependencia estructural sigue: **si Intcomex no
responde, el bot no tiene nada que mostrar**, aunque haya cotizado esos mismos
productos hace diez minutos.

El usuario definió la tolerancia: lo que se muestra en la búsqueda puede
envejecer **minutos**. Y el flujo ya contiene el riesgo de esa vejez: la
cotización formal re-verifica en vivo SKU por SKU, y `emitir-ordenes-compra`
tiene su guard de vigencia — un precio viejo de la búsqueda no puede llegar a
una orden de compra.

## Alcance

**Incluido:**

- `packages/providers/src/price-cache.ts`: caché de precios por proveedor+SKU,
  en memoria con respaldo en disco.
- El handler de `/search` consulta el caché antes de cotizar en vivo, alimenta
  el caché con lo que vuelve, y cae al caché utilizable cuando un lote en vivo
  falla.
- El campo `precios_de_hace_min` en la respuesta de `/search`, propagado por
  `buscar-productos-v2` y con regla en el prompt del agente de descubrimiento.
- Pruebas de todo lo anterior.

**Fuera de alcance:**

- **Buscar en los catálogos de Tecnoglobal e Ingram.** Hoy la búsqueda solo ve
  el catálogo de Intcomex; los otros dos entran recién en `/mejor-precio`. Es
  el proyecto natural siguiente — ataca la misma dependencia por
  diversificación — pero tiene preguntas propias (fusionar productos con el
  mismo MPN entre mayoristas, la cuota de Tecnoglobal) y se decidió
  explícitamente dejarlo fuera.
- **Calentamiento de fondo** (re-cotizar categorías calientes cada N minutos).
  Serían ~30 llamadas/ciclo permanentes para ahorrar ~7s una vez por tema de
  conversación. Se puede agregar después sin rediseñar nada.
- **Cachear `/mejor-precio` o cualquier parte de la cotización.** No es un
  recorte por tiempo: es un principio del diseño (ver abajo).

## El principio: conversar sobre caché, comprometerse en vivo

La búsqueda es conversación: mostrar opciones, comparar, iterar. Ahí un precio
de hace minutos es perfectamente útil, y uno de hace una hora sigue siendo
mejor que "está fallando el sistema".

La cotización es compromiso: congela precio de venta con margen y vigencia de
3 horas, y de ella salen órdenes de compra reales. `/mejor-precio` — lo que
llama `generar-cotizacion-v2` — sigue **100% en vivo, sin excepciones**.
Congelar una cotización sobre un precio cacheado es riesgo de plata real que no
vale los ~2 segundos que ahorra.

## Diseño

### `packages/providers/src/price-cache.ts`

Por proveedor+SKU guarda `{ precio, moneda, stock, cotizado_en }`, y también el
resultado negativo ("este SKU no devolvió precio") para no re-cotizar productos
muertos en cada búsqueda. En memoria, con respaldo en un archivo bajo `cache/`
por proveedor — el mismo patrón del catálogo — para que un reinicio de la API
no parta de cero.

Dos umbrales, y el nombre de cada uno es su contrato:

| Estado | Edad | Uso |
|---|---|---|
| **fresco** | ≤ 15 min | Se usa siempre, sin consultar a nadie |
| **utilizable** | ≤ 24 h | Solo como fallback cuando el lote en vivo falló |
| vencido | > 24 h | Se descarta |

Interfaz (la forma exacta la fija el plan): `get(proveedor, skus)` devuelve lo
fresco y lo utilizable por separado; `put(proveedor, resultados)` guarda lo que
volvió de una cotización en vivo, incluidos los SKUs sin precio.

### El flujo de `/search`

El mecanismo actual (sonda + ronda paralela + presupuesto de 20s) se conserva.
Cambia qué entra a él:

1. Se separan los candidatos: los que tienen precio **fresco** se resuelven del
   caché; solo los restantes van a Intcomex, en los mismos lotes de hoy.
2. Todo lo que vuelve de Intcomex alimenta el caché (aciertos y negativos).
3. Si un lote en vivo falla — con el reintento de red ya agotado — sus
   candidatos se resuelven contra el caché **utilizable** si existe. Solo los
   candidatos sin vivo ni utilizable quedan sin cotizar, y ahí aplica lo de
   hoy: `parcial: true` y motivo `busqueda_incompleta`.

Consecuencia esperada: la primera búsqueda de un tema cuesta lo de hoy (~7s);
las siguientes de la misma conversación — que iteran sobre los mismos
candidatos: "¿y en 15?", "¿y más barato?" — se resuelven mayormente de caché en
menos de un segundo.

### La edad se declara, no se esconde

Si la respuesta usó datos no-vivos, trae `precios_de_hace_min: <entero>` con la
edad del dato **más viejo** que participó. Datos frescos de caché también
cuentan (hasta 15), porque el contrato del campo es "qué tan viejo puede ser lo
que estás viendo", no "hubo un problema".

`buscar-productos-v2` propaga el campo tal cual. El prompt del agente de
descubrimiento gana una regla: si `precios_de_hace_min` supera ~60, agregar
"precios por confirmar" al mostrar los productos — sin presentarlo como falla
ni mencionar sistemas. La cotización después dirá el precio firme, como
siempre.

### Manejo de errores

| Situación | Comportamiento |
|---|---|
| Intcomex lento pero vivo | Igual que hoy (paralelo + presupuesto), con menos lotes porque el caché fresco descuenta candidatos |
| Un lote falla, hay caché utilizable | Se sirve el utilizable, `precios_de_hace_min` lo declara |
| Un lote falla, no hay caché | `parcial: true`, `busqueda_incompleta` — lo de hoy |
| El archivo de caché está corrupto o ilegible | Se ignora y se parte con caché vacío; jamás es fatal |
| Reloj: entrada con `cotizado_en` en el futuro | Se trata como vencida |

### Qué no cambia

- `/mejor-precio`, `generar-cotizacion-v2`, `emitir-ordenes-compra`: intactos.
- La forma de la respuesta de `/search` solo **gana** un campo opcional; nada
  existente cambia de nombre ni de tipo.
- El mecanismo de sonda + ronda paralela y sus umbrales.

## Testing

- **`price-cache`**: fresco/utilizable/vencido por edad; negativo cacheado;
  persistencia a disco y recuperación tras "reinicio" (nueva instancia leyendo
  el archivo); archivo corrupto → caché vacío sin error; `cotizado_en` futuro →
  vencido.
- **`/search` con caché**: mezcla fresco+vivo (solo va a Intcomex lo que
  falta); lote caído con utilizable → responde con edad declarada y sin
  `parcial`; lote caído sin nada → `parcial` como hoy; los aciertos en vivo
  alimentan el caché (la segunda búsqueda no llama a Intcomex).
- **La prueba que protege el principio**: `/mejor-precio` no toca el caché —
  se verifica que con el caché lleno igual va en vivo.
- Las 729 pruebas existentes siguen verdes sin modificarse, salvo las de
  `/search` que afirmen el número exacto de llamadas a `getPrices` (ganan un
  caché vacío explícito en su setup).

## Verificación de punta a punta

1. Buscar dos veces lo mismo contra la API real: la segunda debe responder
   <1s y sin llamadas a Intcomex (visible en el conteo de lotes).
2. Simular la caída (bloquear la salida a Intcomex o apuntar
   `INTCOMEX_BASE_URL` a un puerto muerto) con caché poblado: la búsqueda
   responde con `precios_de_hace_min` en vez de fallar.
3. Con caché poblado, `/mejor-precio` sigue yendo en vivo.
4. La conversación completa por WhatsApp: buscar, iterar, cotizar, y que la
   cotización salga con precio vivo.

## Riesgos conocidos

- **Stock viejo mostrado como disponible.** Acotado a 15 min en operación
  normal y a 24 h solo durante una caída de Intcomex; y la cotización lo
  corrige antes de comprometer nada (`producto_no_disponible` ya existe y el
  agente ya sabe manejarlo).
- **El archivo de caché crece.** Tope natural: ~10.5k SKUs por proveedor con
  ~5 campos chicos — menos de 2 MB. Se poda lo vencido al escribir.
- **Dos procesos escribiendo el archivo** (la API de producción y un `serve`
  de prueba en otro puerto). La escritura va vía archivo temporal + rename —
  ojo: esto es **nuevo**, el caché de catálogo escribe directo con
  `writeFileSync` y no sirve de plantilla aquí. Con eso el peor caso es perder
  una escritura, nunca corromper; y si igual apareciera un archivo corrupto,
  el diseño ya lo trata como caché vacío.
