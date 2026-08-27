import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// La documentacion de docs/api/ la lee un LLM y decide en base a ella: un dato
// viejo ahi no es un detalle cosmetico, es el consumidor tomando una decision
// equivocada. Estos tests no verifican prosa; verifican que los hechos duros
// (rutas, codigos de error, status, nombres de campo, constantes) sigan
// coincidiendo con el codigo. Si fallan, hay que actualizar docs/api/.

const README = readFileSync('docs/api/README.md', 'utf8');
const OPENAPI = readFileSync('docs/api/openapi.yaml', 'utf8');
const DOCS = `${README}\n${OPENAPI}`;

// apps/pricing-api/src/app.ts es la fuente de verdad de que endpoints existen:
// de ahi salen tanto las rutas a verificar como los archivos de api/ que hay
// que leer, asi que un endpoint nuevo entra solo a todas las comprobaciones
// de abajo.
const CODIGO_SERVIDOR = readFileSync('apps/pricing-api/src/app.ts', 'utf8');
const RUTAS = [
  ...(/const nombres = \[([^\]]+)\]/.exec(CODIGO_SERVIDOR)?.[1] ?? '').matchAll(/'([a-z/-]+)'/g),
].map((m) => m[1]);

// Los archivos de api/ son envoltorios de pocas lineas; la logica que la doc
// tiene que reflejar vive en las fabricas de apps/pricing-api/src/handlers/.
const IMPLEMENTACION: Record<string, string> = {
  search: 'apps/pricing-api/src/handlers/search.ts',
  product: 'apps/pricing-api/src/handlers/product.ts',
  facetas: 'apps/pricing-api/src/handlers/facets.ts',
  'mejor-precio': 'apps/pricing-api/src/handlers/best-price.ts',
};

const FUENTES_API = RUTAS.map((n) => ({
  nombre: n,
  codigo: readFileSync(IMPLEMENTACION[n] ?? `apps/pricing-api/api/${n}.ts`, 'utf8'),
}));

// Solo la seccion paths: components tiene sus propias claves 'responses' y
// no describe endpoints.
const PATHS_OPENAPI = OPENAPI.split('\ncomponents:')[0];

function seccionDeRuta(ruta: string): string {
  const inicio = PATHS_OPENAPI.indexOf(`\n  /${ruta}:`);
  if (inicio === -1) return '';
  const resto = PATHS_OPENAPI.slice(inicio + 1);
  const siguiente = resto.search(/\n {2}\/[a-z]/);
  return siguiente === -1 ? resto : resto.slice(0, siguiente);
}

function bloqueDeInterfaz(codigo: string, nombre: string): string {
  const inicio = codigo.indexOf(`interface ${nombre} {`);
  if (inicio === -1) throw new Error(`No existe la interfaz ${nombre}`);
  const cierre = codigo.indexOf('\n}', inicio);
  return codigo.slice(inicio, cierre);
}

function camposDeInterfaz(codigo: string, nombre: string): string[] {
  return [...bloqueDeInterfaz(codigo, nombre).matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

/** Claves de primer nivel del objeto literal que sigue a `marca`. */
function clavesDelLiteral(codigo: string, marca: string): string[] {
  const inicio = codigo.indexOf(marca);
  if (inicio === -1) throw new Error(`No se encontro '${marca}'`);
  let profundidad = 0;
  let fin = inicio;
  for (let i = inicio + marca.length - 1; i < codigo.length; i += 1) {
    if (codigo[i] === '{') profundidad += 1;
    if (codigo[i] === '}') {
      profundidad -= 1;
      if (profundidad === 0) {
        fin = i;
        break;
      }
    }
  }
  const cuerpo = codigo.slice(inicio, fin);
  // La sangria no es fija: el mismo literal vive dos espacios mas adentro
  // cuando el handler pasa a ser una fabrica. Hardcodearla hace que el test
  // deje de cubrir campos sin que nadie se entere.
  const sangria = /\n( +)\w+:/.exec(cuerpo)?.[1];
  if (!sangria) throw new Error(`El literal que sigue a '${marca}' no tiene claves`);
  return [...cuerpo.matchAll(new RegExp(`^${sangria}(\\w+):`, 'gm'))].map((m) => m[1]);
}

describe('docs/api sigue el codigo: rutas', () => {
  it('apps/pricing-api/src/app.ts declara las rutas de forma reconocible', () => {
    expect(RUTAS.length).toBeGreaterThan(3);
  });

  it.each(RUTAS)('la ruta /%s esta documentada en openapi.yaml', (ruta) => {
    expect(seccionDeRuta(ruta)).not.toBe('');
  });

  it.each(RUTAS)('la ruta /%s esta documentada en README.md', (ruta) => {
    expect(README).toContain(`/${ruta}`);
  });

  it('openapi.yaml no documenta rutas que ya no existen', () => {
    const documentadas = [...PATHS_OPENAPI.matchAll(/^ {2}\/([a-z/-]+):$/gm)].map((m) => m[1]);
    expect(documentadas.sort()).toEqual([...RUTAS].sort());
  });
});

describe('docs/api sigue el codigo: codigos de error', () => {
  const fuentes = [...FUENTES_API, { nombre: 'server', codigo: CODIGO_SERVIDOR }];
  const codigos = [
    ...new Set(fuentes.flatMap(({ codigo }) => [...codigo.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]))),
  ];

  it('se encontraron codigos de error en el codigo fuente', () => {
    expect(codigos.length).toBeGreaterThan(4);
  });

  it.each(codigos)("el codigo de error '%s' esta en README.md", (codigo) => {
    expect(README).toContain(codigo);
  });

  it.each(codigos)("el codigo de error '%s' esta en el enum de openapi.yaml", (codigo) => {
    const enumeracion = /enum:\n((?: {12}- \w+\n)+)/.exec(OPENAPI)?.[1] ?? '';
    expect(enumeracion).toContain(`- ${codigo}\n`);
  });
});

describe('docs/api sigue el codigo: status HTTP por endpoint', () => {
  for (const { nombre, codigo } of FUENTES_API) {
    const status = [...new Set([...codigo.matchAll(/status\((\d{3})\)/g)].map((m) => m[1]))];

    it.each(status)(`/${nombre} documenta el status %s`, (code) => {
      expect(seccionDeRuta(nombre)).toContain(`'${code}':`);
    });
  }
});

describe('docs/api sigue el codigo: nombres de campo de las respuestas', () => {
  const codigoSearch = FUENTES_API.find((f) => f.nombre === 'search')!.codigo;
  const codigoProduct = FUENTES_API.find((f) => f.nombre === 'product')!.codigo;

  // /search y /product usan nombres en espanol; /price los usa en ingles.
  // Documentar el nombre equivocado hace que el consumidor lea undefined.
  it.each(camposDeInterfaz(codigoSearch, 'Cotizado'))(
    "el campo '%s' de un producto de /search esta documentado",
    (campo) => {
      expect(README).toContain(`\`${campo}\``);
      expect(OPENAPI).toContain(`\n        ${campo}:`);
    },
  );

  it.each(clavesDelLiteral(codigoProduct, 'res.status(200).json({'))(
    "el campo '%s' de /product esta documentado",
    (campo) => {
      expect(DOCS).toContain(campo);
    },
  );

  it.each(
    clavesDelLiteral(
      FUENTES_API.find((f) => f.nombre === 'mejor-precio')!.codigo,
      'res.status(200).json({',
    ),
  )("el campo '%s' de /mejor-precio esta documentado", (campo) => {
    expect(DOCS).toContain(campo);
  });

  it.each(camposDeInterfaz(readFileSync('packages/domain/src/types.ts', 'utf8'), 'PriceResult'))(
    "el campo '%s' de /price esta documentado",
    (campo) => {
      expect(README).toContain(`\`${campo}\``);
      expect(OPENAPI).toContain(`\n        ${campo}:`);
    },
  );

  it.each(camposDeInterfaz(readFileSync('packages/domain/src/search.ts', 'utf8'), 'Facets'))(
    "la faceta '%s' esta documentada",
    (campo) => {
      expect(DOCS).toContain(campo);
    },
  );

  it("los motivos de 'sin_resultados' documentados son los que emite el codigo", () => {
    const motivos = [...codigoSearch.matchAll(/motivo: '(\w+)'/g)].map((m) => m[1]);
    expect(motivos.length).toBeGreaterThan(0);
    for (const motivo of motivos) {
      expect(README).toContain(motivo);
      expect(OPENAPI).toContain(motivo);
    }
  });
});

describe('docs/api sigue el codigo: constantes citadas', () => {
  const codigoSearch = FUENTES_API.find((f) => f.nombre === 'search')!.codigo;
  const codigoIntcomex = readFileSync('packages/providers/src/intcomex.ts', 'utf8');

  function constante(codigo: string, nombre: string): string {
    const valor = new RegExp(`const ${nombre} = (\\d+)`).exec(codigo)?.[1];
    if (!valor) throw new Error(`No se pudo leer la constante ${nombre}`);
    return valor;
  }

  const citadas: [string, string][] = [
    ['UMBRAL_AMBIGUEDAD', constante(codigoSearch, 'UMBRAL_AMBIGUEDAD')],
    ['LIMITE_POR_DEFECTO', constante(codigoSearch, 'LIMITE_POR_DEFECTO')],
    ['MAX_CANDIDATOS_SIN_FILTROS', constante(codigoSearch, 'MAX_CANDIDATOS_SIN_FILTROS')],
    ['MAX_CANDIDATOS_CON_FILTROS', constante(codigoSearch, 'MAX_CANDIDATOS_CON_FILTROS')],
    ['MAX_SKUS_PER_CALL', constante(codigoIntcomex, 'MAX_SKUS_PER_CALL')],
  ];

  // Se exige que el numero aparezca destacado (negrita o codigo), no suelto en
  // medio de un parrafo: asi un 25 que sea parte de otra frase no da un falso
  // aprobado.
  function citaDestacada(valor: string): RegExp {
    return new RegExp(`\\*\\*[^*]*\\b${valor}\\b[^*]*\\*\\*|\`[^\`]*\\b${valor}\\b[^\`]*\``);
  }

  it.each(citadas)('README.md cita el valor real de %s (%s)', (_nombre, valor) => {
    expect(README).toMatch(citaDestacada(valor));
  });

  it('openapi.yaml declara el default real de limite', () => {
    expect(OPENAPI).toContain(`default: ${constante(codigoSearch, 'LIMITE_POR_DEFECTO')}`);
  });

  it('README.md cita los pesos reales del ranking', () => {
    const codigoRanking = readFileSync('packages/domain/src/search.ts', 'utf8');
    for (const nombre of ['PESO_MPN_EXACTO', 'PESO_MARCA', 'PESO_DESCRIPCION']) {
      const valor = new RegExp(`const ${nombre} = (\\d+)`).exec(codigoRanking)?.[1];
      expect(valor, `falta ${nombre}`).toBeTruthy();
      expect(README).toContain(`| ${valor} |`);
    }
  });

  it('README.md cita la vigencia del catalogo y el reintento', () => {
    const codigoCatalogo = readFileSync('packages/providers/src/catalog.ts', 'utf8');
    expect(codigoCatalogo).toContain('24 * 60 * 60 * 1000');
    expect(README).toContain('**24 horas**');

    const codigoArranque = readFileSync('apps/pricing-api/server.ts', 'utf8');
    expect(codigoArranque).toContain('5 * 60 * 1000');
    expect(README).toContain('**5 minutos**');
  });
});

describe('openapi.yaml es internamente consistente', () => {
  // Un $ref a un schema que no existe no rompe ningun test de texto, pero
  // deja la especificacion sin poder generar cliente ni renderizarse.
  it('todos los $ref apuntan a algo definido', () => {
    const refs = [...OPENAPI.matchAll(/\$ref: '#\/([^']+)'/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);

    const huerfanos = [...new Set(refs)].filter(
      (ref) => !new RegExp(`^    ${ref.split('/').pop()}:`, 'm').test(OPENAPI),
    );
    expect(huerfanos).toEqual([]);
  });

  // Las rutas con proveedor comparten el parametro de path: si el enum se
  // queda atras del registro, la doc promete proveedores que no existen (o
  // esconde los que si). No alcanza con mirar un solo lugar: /mejor-precio
  // trae su propio enum de proveedor en query, y si se desincroniza del de
  // path esta suite queda en verde con el agente sin poder usar el proveedor
  // nuevo en el endpoint del precio oficial.
  it('todos los enum inline de proveedores coinciden con el registro', async () => {
    const { PROVIDERS } = await import('@rr/providers');
    const registro = Object.keys(PROVIDERS).sort();

    // Cualquier enum inline de 2+ valores que sean todos proveedores reales
    // es, por definicion, una lista de "los proveedores": tiene que
    // coincidir exacto con el registro. (Los enums de un solo proveedor,
    // como el de /price, son una restriccion aparte, no un listado de
    // proveedores, y quedan afuera.)
    const listasDeProveedores = [...OPENAPI.matchAll(/enum: \[([^\]]+)\]/g)]
      .map((m) => m[1].split(',').map((s) => s.trim()))
      .filter((valores) => valores.length > 1 && valores.every((v) => registro.includes(v)));

    expect(listasDeProveedores.length).toBeGreaterThan(0);
    for (const lista of listasDeProveedores) {
      expect([...lista].sort()).toEqual(registro);
    }
  });
});
