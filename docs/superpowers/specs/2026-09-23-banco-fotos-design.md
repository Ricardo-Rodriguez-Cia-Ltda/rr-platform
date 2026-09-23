# Diseño: banco de fotos de producto

**Fecha:** 2026-09-23
**Antecedente:** prueba de cobertura del 2026-09-22 (scripts desechables, fuera
del repo), resumida abajo.

## Problema

La tienda (`apps/tienda`) no tiene una sola foto. `TarjetaProducto` lo asume
("sin fotos, el dato es la imagen") y compensa leyendo el nombre del catálogo
como ficha técnica. Ningún catálogo que descargamos trae imágenes: los tres
`cache/catalog-*.json` tienen SKU, MPN, nombre, marca y categoría, nada más.

Conseguirlas a mano —entrar a cada portal, capturar, guardar— son días de
trabajo para 13 mil productos, y habría que repetirlo con cada producto nuevo.

## Lo que midió la prueba (2026-09-22)

Sobre la unión de los tres catálogos por MPN (13.055 productos):

| Fuente | Resultado |
|---|---|
| Intcomex `downloadextendedcatalog` (`format=json`) | Campo `Imagenes[]` con `url`, `isMainImage`, `ancho`, `alto`; alojadas en `intcomexpim.blob.core.windows.net`, mediana 640 px. Cubre **21%** (2.771). |
| Icecat abierto (`live.icecat.biz/api`, por marca + MPN) | Muestra aleatoria de 200 que Intcomex no cubre: **40%** con foto, 15% en marcas "Full Icecat" (403, de pago: HPE, Cisco, Microsoft, SanDisk…), 45% no encontrado. |
| Ingram `v6/catalog` y `v6/catalog/details/{id}` | Sin imágenes. |
| Tecnoglobal | Sin imágenes (su API no tiene el campo). |

Proyección: **~52% gratis**, ~65% pagando Icecat Full. Lo que no aparece:
part numbers latinoamericanos de HP (`#ABM`, `#AC8`; tampoco como `#ABA`),
marcas locales (Xiaomi, Nexxt, Klip Xtreme, Forza, Xtech) y MPN sucios de
Tecnoglobal (`27424 -K97603`).

## Decisiones tomadas

### Alcance: automático + lista de faltantes

Esta fase junta lo que las fuentes dan, lo guarda como propio y lo muestra en
la tienda. Lo que falte sale en una lista priorizada. La carga manual (subir o
corregir una foto desde el backoffice) es una fase posterior, y la lista de
faltantes es su insumo.

### Una sola foto por producto

La principal. ~7.000 fotos de ~40 KB son ~300 MB, dentro del GB gratis de
Supabase Storage, y la tienda no necesita visor de galería. Agregar galería más
adelante no rompe nada: es otra ruta en el bucket y otro campo en el índice.

### Las fotos se copian, no se enlazan

Se descargan y se suben a un bucket público nuestro. Enlazar directo a
Intcomex o Icecat deja la tienda a merced de que esas URLs sigan vivas, y no
deja lugar para las fotos propias de la fase manual.

### Enfoque A: recolector en la oficina, índice como archivo local

El recolector corre en la máquina de la oficina, junto a la `pricing-api`: ahí
ya viven las credenciales de Intcomex y Supabase, y el catálogo unificado. El
índice es un JSON en `cache/`, como el resto de los caches. La `pricing-api` lo
lee y agrega `foto` a cada producto; la tienda no hace ninguna llamada nueva.

Descartados: índice en una tabla de Supabase (una consulta más por búsqueda y
más piezas hoy; es a donde se muda el índice cuando llegue la carga manual) y
URL derivada de la clave sin índice (~48% de 404 en la tienda y sin registro de
la fuente).

## Diseño

### Clave

La misma que el comparador de precios: `unionKey` de
`packages/domain/src/product.ts` (`{mpn compactado}|{marca canónica}`). Un
producto sin clave (sin MPN o sin marca) queda fuera del banco, por la misma
razón que queda fuera del mejor precio: emparejar mal es mostrar la foto de
otro producto.

### Componentes

Todo el recolector vive en `packages/providers/src/fotos/`, un archivo por
responsabilidad:

- **`intcomex.ts`** — `fotosIntcomex(): Promise<Map<string, string>>`. Descarga
  el catálogo extendido una vez por corrida con `fetchIws`, arma clave → URL
  de la imagen con `isMainImage: true` (la primera si ninguna lo es). Construye
  la clave con `unionKey` a partir de `mpn` y `DescripcionMarca`.
- **`icecat.ts`** — `fotoIcecat(mpn, marca): Promise<ResultadoIcecat>`, donde
  el resultado es `{ url }`, `{ motivo: 'no_encontrado' }` (404) o
  `{ motivo: 'icecat_full' }` (403). Usa `Image.Pic500x500` —tamaño uniforme,
  sin redimensionar— y cae a `Image.HighPic` si no viene. El MPN va sin el
  sufijo regional (`#ABM`) y la marca es la primera palabra de la del catálogo.
  Solo se activa con `ICECAT_USER` definido: sin cuenta propia la fuente queda
  apagada y el recolector sigue con Intcomex. Concurrencia 4, como la prueba.
- **`storage.ts`** — `subirFoto(ruta, bytes, contentType): Promise<string>`
  contra la API de Storage de Supabase (`SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY`), con `upsert`. Devuelve la URL pública. Bucket
  `fotos-productos`, público de lectura; ruta `{marca}/{mpn}.{ext}` con las dos
  partes de la clave.
- **`indice.ts`** — lee y escribe `cache/fotos.json` con escritura atómica
  (archivo temporal + rename, como `price-cache.ts`).
- **`banco.ts`** — `actualizarBancoFotos(deps)`: el orquestador. Recibe fuentes,
  storage, índice y catálogos como dependencias para poder probarlo sin red.

Punto de entrada: `apps/pricing-api/scripts/banco-fotos.ts`, expuesto como
`npm run fotos`, para la primera corrida masiva (varias horas por Icecat) y
para correrlo a mano. Después, `server.ts` lo dispara en segundo plano al
terminar cada refresco diario de catálogos, sin bloquear el refresco y con un
candado para que nunca corran dos a la vez.

### Flujo de una corrida

1. Toma las claves únicas de los tres catálogos cargados.
2. Descarta las que ya tienen foto en el índice, y las marcadas sin foto hace
   menos de 30 días.
3. Descarga el catálogo extendido de Intcomex. Si falla, la corrida sigue solo
   con Icecat y lo anota.
4. Por cada clave pendiente: Intcomex primero; si no tiene, Icecat.
5. Descarga la imagen y la valida: `content-type` de imagen (jpeg, png o
   webp) y entre 2 KB y 5 MB. Lo que no pasa cuenta como descarga fallida.
6. La sube al bucket y registra en el índice URL, fuente y fecha.
7. Guarda el índice cada 200 productos, así una corrida cortada no pierde lo
   hecho, y otra vez al final.
8. Escribe la lista de faltantes y un resumen en el log: nuevas por fuente,
   fallidas y sin foto por motivo.

### Índice: `cache/fotos.json`

```json
{
  "actualizadoEn": "2026-09-23T12:00:00.000Z",
  "fotos": {
    "ce310a|hp": { "url": "https://…/fotos-productos/hp/ce310a.jpg", "fuente": "intcomex", "obtenidaEn": "…" }
  },
  "sinFoto": {
    "153n9ltac8|hp": { "motivo": "no_encontrado", "intentadoEn": "…" },
    "lr604|eaton":   { "motivo": "icecat_full",   "intentadoEn": "…" }
  }
}
```

`motivo` es `no_encontrado`, `icecat_full` o `descarga_fallida`. Contar los
`icecat_full` es la respuesta a si conviene pagar Icecat.

### Lista de faltantes: `cache/fotos-faltantes.csv`

Columnas: clave, MPN, marca, nombre, proveedores, con stock, motivo. Orden:
primero lo que tiene stock según los `prices-{proveedor}.json` del cache de
precios, después lo que venden más mayoristas, después el resto.

### La API

La `pricing-api` carga `cache/fotos.json` al arrancar y lo recarga cuando
cambia su fecha de modificación (se revisa como mucho una vez por minuto). Los
handlers de búsqueda y de producto agregan `foto: string | null` a cada
producto, resuelto por `unionKey`. Un índice ausente o corrupto no rompe nada:
toda foto sale `null` y queda un error en el log.

### La tienda

- `ProductoTienda` suma `foto: string | null`; `catalogo.ts` la copia de la
  respuesta solo si es una URL `https:`.
- `TarjetaProducto` muestra la foto arriba de la ficha, en una caja de
  proporción fija (1:1, `object-fit: contain`, fondo blanco, porque las fotos
  de catálogo vienen sobre blanco), con `<img loading="lazy">` y `alt` con el
  nombre del producto. Se usa `<img>` y no `next/image` para no depender de la
  optimización de imágenes de Vercel ni configurar dominios remotos.
- Sin foto, la tarjeta queda exactamente como hoy. El comentario de
  `ficha.ts` y el de `TarjetaProducto` se actualizan: la ficha pasa a ser el
  respaldo de la foto, no su reemplazo.

El bot de WhatsApp no cambia en esta fase.

## Errores

- **Fuente caída:** esa corrida sigue con la otra. Intcomex caído no marca
  nada como `no_encontrado`, así no se castiga 30 días a productos que sí tienen
  foto.
- **Una falla nunca reemplaza una foto buena:** lo que ya tiene foto no se
  vuelve a tocar en esta fase.
- **Storage caído o sin credenciales:** la corrida termina de inmediato con
  un error claro, sin tocar el índice.
- **Icecat con cuota o 5xx:** la clave queda pendiente para la próxima corrida,
  no como `no_encontrado`.

## Pruebas

- `intcomex.ts` e `icecat.ts`: parseo contra fixtures reales recortados (con
  imagen, sin imagen, 404, 403, respuesta sin `Pic500x500`).
- `banco.ts` con fuentes, storage e índice falsos: salta lo que ya tiene foto;
  reintenta `sinFoto` recién después de 30 días; Intcomex caído no genera
  `no_encontrado`; una descarga inválida queda como `descarga_fallida`; el
  índice se guarda por lotes.
- `pricing-api`: búsqueda y producto devuelven `foto` para una clave del
  índice y `null` para el resto; un índice corrupto da todo `null` sin caer.
- `tienda`: la tarjeta muestra la imagen cuando hay `foto` y la ficha sola
  cuando no; `catalogo.ts` descarta una `foto` que no sea `https:`.
- Verificación real: corrida sobre una muestra de 200 claves, revisando el
  bucket y la tienda local, antes de lanzar la masiva.

## Dependencias externas (las resuelve el usuario)

1. **Cuenta de Icecat Open** (gratis) y su usuario en `ICECAT_USER` del
   `.env.local` de la oficina. Sin ella, el banco funciona solo con Intcomex
   (~21%).
2. **Condiciones de uso de Icecat Open** para uso comercial y atribución. Si
   exigen atribución visible, se agrega en el pie de la tienda.
3. **Bucket `fotos-productos`** en el proyecto Supabase existente: lo crea el
   script si no existe, con la service key; solo requiere visto bueno.

## Fuera de alcance

- Carga y corrección manual de fotos (fase 2, con el índice movido a una tabla).
- Galería de varias fotos por producto.
- Fotos en las respuestas del bot de WhatsApp.
- Icecat Full (de pago): se decide con los números de `icecat_full`.
- Scraping de sitios de fabricantes para el ~45% restante.
