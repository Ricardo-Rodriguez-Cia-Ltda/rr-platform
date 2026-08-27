// Regenera docs/api/vocabulario.md desde la API en vivo.
//
// El vocabulario del catalogo es lo unico de la documentacion que puede
// mantenerse solo: marcas y categorias cambian cuando Intcomex mueve su
// surtido, no cuando cambia el codigo. Un LLM que filtra por "Hewlett-Packard"
// no encuentra nada; esta lista existe para que el prompt sepa que es "HP".
//
//   npm run docs:vocabulario                       # contra produccion
//   API_BASE=http://127.0.0.1:3000/api npm run docs:vocabulario

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.API_BASE ?? 'https://api.pyxis-latam.cl/rr/captador-precios').replace(
  /\/+$/,
  '',
);
// Absoluta: el script corre con el directorio de trabajo en apps/pricing-api.
const DESTINO = fileURLToPath(new URL('../../../docs/api/vocabulario.md', import.meta.url));

const apiKey = process.env.API_SECRET_KEY;
if (!apiKey) {
  console.error('Falta API_SECRET_KEY (usa .env.local)');
  process.exit(1);
}

interface Count {
  valor: string;
  n: number;
}

interface FacetsResponse {
  total_productos: number;
  marca: Count[];
  categoria: Count[];
}

const response = await fetch(`${BASE}/facetas`, { headers: { 'x-api-key': apiKey } });
if (!response.ok) {
  const body = await response.text().catch(() => '');
  console.error(`GET ${BASE}/facetas respondio HTTP ${response.status}`, body.slice(0, 300));
  process.exit(1);
}

const facets = (await response.json()) as FacetsResponse;
if (!facets.marca?.length || !facets.categoria?.length) {
  console.error('La respuesta de /facetas vino sin marcas o sin categorias; no se sobrescribe nada');
  process.exit(1);
}

function table(items: Count[]): string {
  return ['| Valor | Productos |', '|---|---:|', ...items.map((i) => `| ${i.valor} | ${i.n} |`)].join(
    '\n',
  );
}

const generatedAt = new Date().toISOString().slice(0, 10);

const content = `# Vocabulario del catálogo

> **Archivo generado.** No editar a mano: se sobrescribe con
> \`npm run docs:vocabulario\`.
>
> Generado el ${generatedAt} desde \`${BASE}/facetas\` · ${facets.total_productos} productos
> · ${facets.marca.length} marcas · ${facets.categoria.length} categorías.

Los parámetros \`marca\` y \`categoria\` de \`GET /search\` son filtros **exactos**
(la comparación ignora tildes y mayúsculas, nada más). Solo los valores de estas
tablas producen resultados; cualquier variante —traducción, nombre comercial
largo, singular por plural— devuelve vacío.

Esta lista está pensada para inyectarse en el system prompt de un agente, para
que sepa traducir lo que pide el cliente al vocabulario real del catálogo.

## Categorías (${facets.categoria.length})

${table(facets.categoria)}

## Marcas (${facets.marca.length})

${table(facets.marca)}
`;

writeFileSync(DESTINO, content);
console.log(
  `${DESTINO} actualizado: ${facets.categoria.length} categorías, ${facets.marca.length} marcas, ${facets.total_productos} productos.`,
);
