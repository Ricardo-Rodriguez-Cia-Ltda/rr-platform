import { describe, expect, it } from 'vitest';
import { search, computeFacets, normalize, tokenize } from '@rr/domain/search';
import type { NormalizedProduct } from '@rr/domain/product';

function producto(
  sku: string,
  mpn: string,
  nombre: string,
  marca: string,
  categoria = 'Computadores',
  subcategorias: string[] = [],
): NormalizedProduct {
  return { sku, mpn, nombre, marca, categoria, subcategorias, tipo: null };
}

const CATALOGO: NormalizedProduct[] = [
  producto('MT027DEL20', 'P2725HE', 'Dell P2725HE - 27" - 1920 x 1080 - IPS - USB-C', 'Dell', 'Monitores'),
  producto('NT016HPQ53', '2N6G5LT#ABM', 'HP ProBook 640 G8 - Notebook - 14" - Intel Core i7', 'HP'),
  producto('100016385', '4P5H8AA', 'HyperX CloudX Gaming - Auricular - tamaño completo - cableado', 'HyperX', 'Audio'),
  producto('ID020LOG11', '920-008813', 'Logitech K380 - Teclado - inalámbrico - Bluetooth', 'Logitech', 'Accesorios'),
  // Decoy: su MPN contiene "27" como fragmento, igual que un termino comun
  // de consulta ("monitor dell 27"). No debe hijackear el ranking del monitor.
  producto('CB027KIN01', '27-ABC12', 'Kingston USB-C Cable - 2m - Carga rapida', 'Kingston', 'Accesorios'),
];

describe('normalize', () => {
  it('pasa a minúsculas y quita tildes', () => {
    expect(normalize('Inalámbrico ÑOÑO')).toBe('inalambrico nono');
  });
});

describe('tokenize', () => {
  it('parte en palabras completas descartando puntuación', () => {
    expect(tokenize('HP ProBook 640 G8 - 14"')).toEqual(['hp', 'probook', '640', 'g8', '14']);
  });
});

describe('search', () => {
  it('no devuelve HyperX al buscar hp (palabras completas, no subcadenas)', () => {
    const skus = search(CATALOGO, { q: 'hp' }).map((r) => r.product.sku);
    expect(skus).toContain('NT016HPQ53');
    expect(skus).not.toContain('100016385');
  });

  it('encuentra el monitor Dell aunque su descripción no diga "monitor"', () => {
    const skus = search(CATALOGO, { q: 'monitor dell 27' }).map((r) => r.product.sku);
    expect(skus[0]).toBe('MT027DEL20');
  });

  it('encuentra "inalámbrico" buscando sin tilde', () => {
    const skus = search(CATALOGO, { q: 'teclado logitech inalambrico' }).map((r) => r.product.sku);
    expect(skus[0]).toBe('ID020LOG11');
  });

  it('da la máxima prioridad a una coincidencia exacta de MPN', () => {
    const resultados = search(CATALOGO, { q: 'P2725HE' });
    expect(resultados[0].product.sku).toBe('MT027DEL20');
    expect(resultados[0].score).toBeGreaterThanOrEqual(100);
  });

  it('ordena por cantidad de términos coincidentes', () => {
    const resultados = search(CATALOGO, { q: 'hp probook notebook' });
    expect(resultados[0].product.sku).toBe('NT016HPQ53');
  });

  it('filtra por marca sin considerarla en el puntaje de texto', () => {
    const skus = search(CATALOGO, { q: 'notebook', marca: 'HP' }).map((r) => r.product.sku);
    expect(skus).toEqual(['NT016HPQ53']);
  });

  it('filtra por categoría', () => {
    const skus = search(CATALOGO, { q: 'dell', categoria: 'Monitores' }).map((r) => r.product.sku);
    expect(skus).toEqual(['MT027DEL20']);
  });

  it('devuelve vacío cuando ningún término calza', () => {
    expect(search(CATALOGO, { q: 'tractor agricola' })).toEqual([]);
  });

  it('MPN exacto con puntuación recibe el bonus exactamente una vez', () => {
    const resultados = search(CATALOGO, { q: '2N6G5LT#ABM' });
    // Score: MPN bonus 100 (no brand ni descripción calzan con tokens ['2n6g5lt','abm'])
    expect(resultados[0].product.sku).toBe('NT016HPQ53');
    expect(resultados[0].score).toBe(100);
  });

  it('producto sin MPN coincidente no recibe bonus MPN', () => {
    // Buscar 'notebook' coincide con la descripción del ProBook pero no con su MPN
    const resultados = search(CATALOGO, { q: 'notebook' });
    const probook = resultados.find((r) => r.product.sku === 'NT016HPQ53');
    expect(probook).toBeDefined();
    expect(probook!.score).toBe(3); // Solo descripción, sin bonus MPN
  });

  it('MPN de un token y dos tokens reciben el mismo bonus base cuando se buscan exactamente', () => {
    // P2725HE es un token, 2N6G5LT#ABM son dos tokens
    const result1 = search(CATALOGO, { q: 'P2725HE' });
    const result2 = search(CATALOGO, { q: '2N6G5LT#ABM' });
    // result1: 100 (MPN exacto) + 3 (el termino "p2725he" tambien esta en la
    // descripcion del propio producto). result2: 100 (MPN exacto), ninguno
    // de sus dos tokens ("2n6g5lt", "abm") aparece en marca ni descripcion.
    expect(result1[0].score).toBe(103);
    expect(result2[0].score).toBe(100);
  });

  it('un fragmento de MPN que calza con un termino de la consulta no otorga el bonus (evita hijack de ranking)', () => {
    const resultados = search(CATALOGO, { q: 'monitor dell 27' });
    expect(resultados[0].product.sku).toBe('MT027DEL20');
    expect(resultados[0].score).toBe(16); // 10 marca + 3 "dell" + 3 "27" en descripcion, sin bonus MPN

    const decoy = resultados.find((r) => r.product.sku === 'CB027KIN01');
    // El decoy (MPN "27-ABC12") no matchea ni marca ni descripcion con estos
    // terminos, asi que ni siquiera aparece en los resultados (score 0).
    expect(decoy).toBeUndefined();
  });

  it('MPN con guion calza completo cuando la consulta trae el mismo guion', () => {
    const resultados = search(CATALOGO, { q: '920-008813' });
    expect(resultados[0].product.sku).toBe('ID020LOG11');
    expect(resultados[0].score).toBe(100);
  });

  it('el mismo MPN escrito sin el guion tambien recibe el bonus', () => {
    const resultados = search(CATALOGO, { q: '920008813' });
    expect(resultados[0].product.sku).toBe('ID020LOG11');
    expect(resultados[0].score).toBe(100);
  });
});

describe('computeFacets', () => {
  it('cuenta marcas y categorías presentes, ordenadas por frecuencia', () => {
    const facetas = computeFacets([CATALOGO[1], CATALOGO[1], CATALOGO[0]]);
    expect(facetas.marca[0]).toEqual({ valor: 'HP', n: 2 });
    expect(facetas.marca).toContainEqual({ valor: 'Dell', n: 1 });
    expect(facetas.categoria[0]).toEqual({ valor: 'Computadores', n: 2 });
  });
});

// "32GB" pegado (un solo token tras tokenizar) no calzaba con "32 GB" separado
// en el nombre del catalogo (dos tokens): el cliente escribe specs pegadas, el
// catalogo las separa. Medido en vivo el 2026-09-01: "no hay notebooks con
// 32GB" era falso, habia 157.
describe('matching consciente de specs', () => {
  const CATALOGO_SPECS: NormalizedProduct[] = [
    producto('NB032HP01', 'MPN-NB032', 'HP - Notebook - 32 GB - DDR5', 'HP'),
    producto('NB016HP02', 'MPN-NB016', 'HP - Notebook - 16 GB - DDR5', 'HP'),
    producto('SD001KIN01', 'MPN-SD001', 'Kingston SSD1TB NVMe M.2', 'Kingston', 'Almacenamiento'),
    producto('CP001INT01', 'MPN-CP001', 'Intel Core i5 - Procesador', 'Intel'),
    // Falso positivo confirmado en vivo (ronda de arreglo 1, 2026-09-01): "16"
    // viene de "16 pulgadas" y "gb" viene de "8 GB", campos distintos. El
    // bono de "16gb" NO debe otorgarse aqui: membresia plana en un Set no
    // exige que las dos partes vengan del mismo lugar del nombre.
    producto('NB016PUL01', 'MPN-NB016PUL', 'Notebook 16 pulgadas - 8 GB RAM - SSD', 'Generico'),
  ];

  it('q="notebook 32GB" encuentra el notebook de 32 GB separado en el nombre, y lo puntua mas arriba', () => {
    const resultados = search(CATALOGO_SPECS, { q: 'notebook 32GB' });
    const skus = resultados.map((r) => r.product.sku);
    expect(skus).toContain('NB032HP01');
    // El de 32GB matchea "notebook" + spec "32"+"gb"; el de 16GB solo "notebook".
    const de32 = resultados.find((r) => r.product.sku === 'NB032HP01')!;
    const de16 = resultados.find((r) => r.product.sku === 'NB016HP02')!;
    expect(de32.score).toBeGreaterThan(de16.score);
  });

  it('q="1TB" encuentra "SSD1TB" pegado, partiendo en frontera digito-letra', () => {
    const skus = search(CATALOGO_SPECS, { q: '1TB' }).map((r) => r.product.sku);
    expect(skus).toContain('SD001KIN01');
  });

  it('el bonus de spec se otorga una sola vez (no dobla PESO_DESCRIPCION)', () => {
    // "32gb" matchea via el camino spec (32 + gb), nunca directo (no existe
    // el token "32gb" en el nombre). Si sumara dos veces el score subiria a 6.
    const resultado = search(CATALOGO_SPECS, { q: '32GB' }).find((r) => r.product.sku === 'NB032HP01');
    expect(resultado?.score).toBe(3);
  });

  it('el bono de spec exige adyacencia real: "16gb" no matchea "16 pulgadas ... 8 GB" (campos distintos)', () => {
    const resultados = search(CATALOGO_SPECS, { q: 'notebook 16GB' });
    const falsoPositivo = resultados.find((r) => r.product.sku === 'NB016PUL01');
    expect(falsoPositivo).toBeDefined();
    // Solo "notebook" matchea (descripcion, +3). Si el bono de spec se diera
    // por membresia plana, subiria a 6.
    expect(falsoPositivo!.score).toBe(3);
  });

  it('un termino que no es spec (no calza el patron numero+letras) no cambia su comportamiento', () => {
    // "notebook" no matchea el patron /^(\d+(?:\.\d+)?)([a-z]+)$/, asi que su
    // scoring sigue siendo el de siempre: exige coincidencia directa de token.
    const skus = search(CATALOGO_SPECS, { q: 'notebook' }).map((r) => r.product.sku);
    expect(skus).toEqual(expect.arrayContaining(['NB032HP01', 'NB016HP02']));
    expect(skus).not.toContain('CP001INT01');
  });

  it('el MPN escrito pegado sigue calzando compactedMpn (camino de match protegido, no tocado)', () => {
    const resultados = search(CATALOGO, { q: '920008813' });
    expect(resultados[0].product.sku).toBe('ID020LOG11');
    expect(resultados[0].score).toBe(100);
  });

  it('normalizedQuery === normalizedMpn sigue dando el bonus completo de MPN', () => {
    const resultados = search(CATALOGO, { q: 'P2725HE' });
    expect(resultados[0].product.sku).toBe('MT027DEL20');
    expect(resultados[0].score).toBeGreaterThanOrEqual(100);
  });
});

// Cuando se filtra por marca o categoria, esos terminos ya no deben puntuar:
// si lo hacen, ahogan al termino que de verdad discrimina. Medido en vivo:
// q="notebook HP" + marca=HP devolvia mochilas, mouses y monitores HP, porque
// "hp" sumaba 13 puntos en los 804 productos de la marca y "notebook" solo 3.
describe('buscar — el termino del filtro no puntua', () => {
  const CATALOGO_HP: NormalizedProduct[] = [
    producto('NT1', 'MPN-NT1', 'HP ProBook 640 - Notebook - 14"', 'HP'),
    producto('MO1', 'MPN-MO1', 'HP - Mouse - Wired - 265A9UT', 'HP', 'Perifericos'),
    producto('MT1', 'MPN-MT1', 'HP - LED-backlit LCD monitor - 27"', 'HP', 'Monitores'),
  ];

  it('con marca=HP, "notebook HP" solo trae el notebook', () => {
    const skus = search(CATALOGO_HP, { q: 'notebook HP', marca: 'HP' }).map((r) => r.product.sku);
    expect(skus).toEqual(['NT1']);
  });

  it('con categoria, el nombre de la categoria tampoco puntua', () => {
    const skus = search(CATALOGO_HP, { q: 'mouse perifericos', categoria: 'Perifericos' }).map(
      (r) => r.product.sku,
    );
    expect(skus).toEqual(['MO1']);
  });

  it('si la consulta era solo la marca, sigue devolviendo todo lo de esa marca', () => {
    const skus = search(CATALOGO_HP, { q: 'HP', marca: 'HP' }).map((r) => r.product.sku);
    expect(skus).toHaveLength(3);
  });

  it('sin filtro de marca, la marca sigue puntuando como antes', () => {
    const resultados = search(CATALOGO_HP, { q: 'HP mouse' });
    expect(resultados[0].product.sku).toBe('MO1');
    expect(resultados).toHaveLength(3);
  });
});

// El catalogo trae subcategorias (Portatiles, Todo-en-Uno, Computadores de
// Mesa, Servidores, Tableta) y la busqueda no filtraba por ellas: un cliente
// que pidio notebook recibio un All-in-One (conversacion real, 2026-09-01).
describe('filtro por subcategoria', () => {
  const CATALOGO_COMPUTADORES: NormalizedProduct[] = [
    producto('NB1', 'MPN-NB1', 'HP ProBook 640 - Notebook - 14"', 'HP', 'Computadores', ['Portátiles']),
    producto('AIO1', 'MPN-AIO1', 'HP - All-in-One 24 - PC todo en uno', 'HP', 'Computadores', ['Todo-en-Uno']),
    producto('DT1', 'MPN-DT1', 'HP - EliteDesk 800 - Torre', 'HP', 'Computadores', ['Computadores de Mesa']),
  ];

  it('filtra por subcategoria exacta', () => {
    const skus = search(CATALOGO_COMPUTADORES, { q: 'HP', subcategoria: 'Portátiles' }).map((r) => r.product.sku);
    expect(skus).toEqual(['NB1']);
  });

  it('compara normalizado (sin tildes, sin mayusculas) contra CUALQUIERA de las subcategorias del producto', () => {
    const multi = producto('SV1', 'MPN-SV1', 'HP - ProLiant - Servidor Torre', 'HP', 'Computadores', [
      'Servidores',
      'Computadores de Mesa',
    ]);
    const skus = search([...CATALOGO_COMPUTADORES, multi], { q: 'HP', subcategoria: 'servidores' }).map(
      (r) => r.product.sku,
    );
    expect(skus).toEqual(['SV1']);
  });

  it('los tokens de la subcategoria de filtro no puntuan en el texto', () => {
    // "todo en uno" no debe sumar puntaje aparte del match de subcategoria.
    const resultados = search(CATALOGO_COMPUTADORES, { q: 'todo en uno hp', subcategoria: 'Todo-en-Uno' });
    expect(resultados.map((r) => r.product.sku)).toEqual(['AIO1']);
  });

  it('sin filtro de subcategoria, se comporta como antes (todas las subcategorias)', () => {
    const skus = search(CATALOGO_COMPUTADORES, { q: 'HP' }).map((r) => r.product.sku);
    expect(skus).toHaveLength(3);
  });
});

describe('computeFacets — subcategoria', () => {
  it('cuenta subcategorias, con el mismo formato que marca y categoria', () => {
    const productos: NormalizedProduct[] = [
      producto('NB1', 'MPN-NB1', 'HP Notebook', 'HP', 'Computadores', ['Portátiles']),
      producto('NB2', 'MPN-NB2', 'Dell Notebook', 'Dell', 'Computadores', ['Portátiles']),
      producto('AIO1', 'MPN-AIO1', 'HP All-in-One', 'HP', 'Computadores', ['Todo-en-Uno']),
    ];
    const facetas = computeFacets(productos);
    expect(facetas.subcategoria).toContainEqual({ valor: 'Portátiles', n: 2 });
    expect(facetas.subcategoria).toContainEqual({ valor: 'Todo-en-Uno', n: 1 });
  });

  it('un producto con varias subcategorias cuenta en cada una', () => {
    const productos: NormalizedProduct[] = [
      producto('SV1', 'MPN-SV1', 'HP ProLiant', 'HP', 'Computadores', ['Servidores', 'Computadores de Mesa']),
    ];
    const facetas = computeFacets(productos);
    expect(facetas.subcategoria).toContainEqual({ valor: 'Servidores', n: 1 });
    expect(facetas.subcategoria).toContainEqual({ valor: 'Computadores de Mesa', n: 1 });
  });
});
