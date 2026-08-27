# Cómo se organiza este repositorio

## Dónde va cada cosa

**Una app es algo que se despliega. Un paquete es algo que se importa.**
Si tiene un destino de despliegue propio, va en `apps/`. Si lo consume otra
cosa del repositorio, va en `packages/`.

**No se extrae un paquete con un solo consumidor.** El segundo consumidor es
el que justifica la extracción; antes de eso es adivinar.

## Nombres

**Inglés adentro, contratos externos intactos.** Archivos e identificadores
en inglés. No se tocan — cada uno de estos es un contrato con algo fuera del
repositorio, y renombrarlo rompe a un consumidor que no está en este código:

- Las rutas HTTP y los nombres de archivo bajo `apps/pricing-api/api/` que
  las producen (Vercel deriva la ruta del nombre del archivo).
- Las claves JSON de las respuestas y los parámetros de query.
- Los valores de enum que viajan en una respuesta.
- Los nombres de las variables de entorno.
- Los archivos `.js` bajo `apps/kapso-agent/functions/`: cada nombre es el
  de una function ya desplegada en una cuenta de Kapso real. Renombrar el
  archivo no renombra la function remota; solo rompe el script de deploy que
  la busca por nombre.
- El texto de los prompts.

**Donde la convención se ha aplicado:** `apps/pricing-api/src/`, `packages/domain/src/`
y `packages/providers/src/` ya tienen identifiers en inglés. Terminarla en el
resto del repositorio — especialmente en los tests — es trabajo pendiente, no
una regla que nadie sigue. Es una invitación: renombrar a inglés lo que queda
es su propio cambio, y hay que revisar qué tests dependen de cada nombre para
no dejarlos en verde sin haber verificado nada.

**Nueve excepciones que siguen en español dentro del código.** No son un
descuido, son deliberadas:

- `Cotizado`, `UMBRAL_AMBIGUEDAD`, `LIMITE_POR_DEFECTO`,
  `MAX_CANDIDATOS_SIN_FILTROS`, `MAX_CANDIDATOS_CON_FILTROS`,
  `PESO_MPN_EXACTO`, `PESO_MARCA`, `PESO_DESCRIPCION` — `tests/docs.test.ts`
  busca estos nombres **por string literal** para verificar que la
  documentación cite sus valores reales, y `docs/api/README.md` los cita por
  ese mismo nombre. Renombrar uno hace que el test no encuentre nada y pase
  en verde sin haber verificado nada.
- `descargadoEn`, `obtenidaEn`, `productos` — las claves que se serializan en
  el caché de catálogo en disco (`cache/catalog-<proveedor>.json`,
  `cache/tecnoglobal-precios.json`). Son un contrato como cualquier clave de
  respuesta, salvo que el consumidor es un archivo propio en vez de un
  cliente HTTP: renombrar una invalida todo caché ya escrito en disco (local
  y en el PC de oficina), y el próximo arranque no puede leerlo.
- `nombres` — el array que declara `apps/pricing-api/src/app.ts` con la lista
  de rutas. `tests/docs.test.ts` lo busca por regex (`/const nombres = \[/`)
  para verificar que las rutas documentadas existan. Renombrarlo hace que el
  test no encuentre nada y pase en verde sin haber revisado la documentación
  contra el código.

**Prosa en español.** Prompts, documentación, mensajes al cliente y
comentarios. El negocio se piensa en español chileno.

## `tests/docs.test.ts` es peligroso de una forma no obvia

No es un test común: lee archivos de código fuente **por ruta** y busca
interfaces y constantes **por nombre**, todo al cargar el módulo (no dentro
de un `it`). Si movés un archivo o renombrás algo que este test busca, hay
dos formas de fallar y una de ellas no se nota:

- Si la ruta ya no existe, `readFileSync` explota al importar el archivo y
  **toda la suite de tests se cae**, no solo este archivo.
- Si la ruta existe pero el nombre ya no está adentro, el test que lo busca
  con `.each(algoQueAhoraEstaVacio)` **no genera ningún caso** y queda en
  verde sin haber comprobado nada.

Si vas a mover o renombrar algo bajo `apps/pricing-api/`, `packages/domain/`
o `packages/providers/`, revisá `tests/docs.test.ts` antes: ahí está la
lista completa de rutas e identificadores de los que depende.

## Historial

El refactor de agosto 2026 movió y renombró casi todo. `git blame` sobre esos
archivos muestra ese commit; usa `git log --follow <archivo>` para el
historial real.
