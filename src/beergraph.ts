// Graph model, loader and recommendation queries for the Belgian beer graph.
// Engine-agnostic: everything goes through an `exec(cypher, params)` function,
// so the same code runs in the browser worker and in the Node test script.
//
// Model (same as the original Neo4j beer graph, plus a few extras):
//   (:Beer {id, name, abv, from, until, stillBrewed, taste (vector), tasteList})
//   (:Beer)-[:BREWED_BY]->(:Brewery {name})
//   (:Beer)-[:HAS_TYPE {inferred}]->(:BeerType {name})
//   (:Beer)-[:HAS_ALCOHOLPERCENTAGE]->(:AlcoholPercentage {value})
//   (:Beer)-[:HAS_FERMENTATION]->(:Fermentation {name})
//   (:Drinker {name})-[:LIKES|DISLIKES {at}]->(:Beer)       ← persisted taste memory

export interface Beer {
  name: string; types: string[]; inferredTypes: string[]; fermentation: string | null;
  abv: number | null; brewery: string | null; breweryDetail: string | null;
  from: number | null; until: number | null; stillBrewed: boolean;
}

export interface Envelope {
  columns: string[]; rows: Record<string, any>[]; error: string | null;
  elapsed_ms?: number; stats?: Record<string, number>;
}

export type Exec = (cypher: string, params?: Record<string, unknown>) => Envelope | Promise<Envelope>;

// ---- taste vectors -------------------------------------------------------
// A small, explainable "flavour space": style families, fermentation and ABV.
export const FAMILIES: [string, RegExp][] = [
  ['blond', /blond|goud/],
  ['tripel', /tripel|triple/],
  ['dubbel', /dubbel|double/],
  ['quadrupel', /quadrupel|quad/],
  ['bruin', /bruin|donker|brune|dark/],
  ['amber', /amber|ambr|rood|rouge|red/],
  ['wit', /wit|tarwe|blanche|weizen|wheat/],
  ['pils', /pils|lager|export/],
  ['saison', /saison|farm/],
  ['lambiek', /lambiek|lambic|geuze|gueuze|faro|spontaan/],
  ['fruit', /fruit|kriek|framboise|frambozen|perzik|cassis|kers/],
  ['stout', /stout|porter/],
  ['ipa', /ipa|india|hop/],
  ['abdij', /abdij|abbaye|trappist|abbey/],
  ['seizoen', /kerst|winter|noël|christmas|lente|paas/],
  ['zuur', /oud bruin|zuur|sour|flemish|vlaams rood/],
  ['speciaal', /speciaal|spéciale|regionaal|streek/],
  ['laag', /laag alcohol|alcoholvrij|tafelbier|0[,.]\d%/],
];
const FERMENTATIONS = ['hoge gisting', 'lage gisting', 'spontane gisting', 'gemengde gisting'];
export const TASTE_DIMENSIONS = FAMILIES.length + FERMENTATIONS.length + 1;

export function tasteVector(b: Beer): number[] {
  const text = [...b.types, ...b.inferredTypes, b.name].join(' ').toLowerCase();
  const v: number[] = FAMILIES.map(([, re]) => (re.test(text) ? 1 : 0));
  v.push(...FERMENTATIONS.map((f) => (b.fermentation === f ? 0.5 : 0)));
  // ABV, scaled so 0% → 0 and 12% → 1.5: strength matters as much as a style.
  v.push(b.abv == null ? 0.7 : Math.min(b.abv, 14) / 8);
  if (!v.some((x) => x !== 0)) v[0] = 0.01; // cosine needs a non-zero vector
  return v;
}

// ---- loading ---------------------------------------------------------------

export const SCHEMA = [
  'CREATE INDEX beer_id IF NOT EXISTS FOR (b:Beer) ON (b.id)',
  'CREATE INDEX brewery_name IF NOT EXISTS FOR (b:Brewery) ON (b.name)',
  'CREATE INDEX type_name IF NOT EXISTS FOR (t:BeerType) ON (t.name)',
  `CREATE VECTOR INDEX beer_taste IF NOT EXISTS FOR (b:Beer) ON (b.taste) WITH [b.stillBrewed]
     OPTIONS {indexConfig: {\`vector.dimensions\`: ${TASTE_DIMENSIONS}, \`vector.similarity_function\`: 'cosine'}}`,
  `CREATE FULLTEXT INDEX beer_search IF NOT EXISTS FOR (b:Beer) ON EACH [b.name, b.breweryName, b.typeText]
     OPTIONS {indexConfig: {\`fulltext.analyzer\`: 'standard-folding'}}`,
];

const LOAD_BATCH = `
UNWIND $rows AS r
CREATE (b:Beer {id: r.id, name: r.name, abv: r.abv, from: r.from, until: r.until,
                stillBrewed: r.stillBrewed, breweryName: r.brewery, breweryDetail: r.breweryDetail,
                typeText: r.typeText, tasteList: r.taste, taste: vector(r.taste, ${TASTE_DIMENSIONS}, FLOAT32)})
WITH b, r
CALL (b, r) {
  WITH b, r WHERE r.brewery IS NOT NULL
  MERGE (br:Brewery {name: r.brewery})
  CREATE (b)-[:BREWED_BY]->(br)
}
CALL (b, r) {
  WITH b, r WHERE r.abv IS NOT NULL
  MERGE (a:AlcoholPercentage {value: r.abv})
  CREATE (b)-[:HAS_ALCOHOLPERCENTAGE]->(a)
}
CALL (b, r) {
  WITH b, r WHERE r.fermentation IS NOT NULL
  MERGE (f:Fermentation {name: r.fermentation})
  CREATE (b)-[:HAS_FERMENTATION]->(f)
}
CALL (b, r) {
  UNWIND r.typeList AS t
  MERGE (bt:BeerType {name: t.name})
  CREATE (b)-[:HAS_TYPE {inferred: t.inferred}]->(bt)
}`;

export async function loadBeers(exec: Exec, beers: Beer[], meta: Record<string, unknown>, onProgress?: (done: number) => void) {
  for (const s of SCHEMA) check(await exec(s));
  const rows = beers.map((b, id) => ({
    id, name: b.name, abv: b.abv, from: b.from, until: b.until, stillBrewed: b.stillBrewed,
    brewery: b.brewery, breweryDetail: b.breweryDetail, fermentation: b.fermentation,
    typeText: [...b.types, ...b.inferredTypes].join(' '),
    typeList: [...b.types.map((name) => ({ name, inferred: false })), ...b.inferredTypes.map((name) => ({ name, inferred: true }))],
    taste: tasteVector(b),
  }));
  const size = 250;
  for (let i = 0; i < rows.length; i += size) {
    check(await exec(LOAD_BATCH, { rows: rows.slice(i, i + size) }));
    onProgress?.(Math.min(i + size, rows.length));
  }
  check(await exec('MERGE (m:Meta {key: "dataset"}) SET m += $meta', { meta: { ...meta, beers: beers.length } }));
}

function check(e: Envelope) {
  if (e.error) throw new Error(e.error);
  return e;
}

// ---- queries ---------------------------------------------------------------
// Each query is a plain string so the UI can show exactly what ran.

export const Q = {
  counts: `
    MATCH (n) WITH labels(n)[0] AS label, count(*) AS n
    RETURN label, n ORDER BY n DESC`,

  meta: `MATCH (m:Meta {key: "dataset"}) RETURN m.source AS source, m.revision AS revision, m.fetched AS fetched, m.beers AS beers`,

  search: `
    MATCH (b:Beer)
    SEARCH b IN (FULLTEXT INDEX beer_search FOR $q LIMIT 12) SCORE AS score
    RETURN b.id AS id, b.name AS name, b.breweryName AS brewery, b.abv AS abv, b.stillBrewed AS stillBrewed, score
    ORDER BY score DESC`,

  beer: `
    MATCH (b:Beer {id: $id})
    OPTIONAL MATCH (b)-[ht:HAS_TYPE]->(t:BeerType)
    WITH b, collect(t.name) AS types
    OPTIONAL MATCH (b)-[:HAS_FERMENTATION]->(f)
    RETURN b.id AS id, b.name AS name, b.breweryName AS brewery, b.breweryDetail AS breweryDetail,
           b.abv AS abv, b.from AS from, b.until AS until, b.stillBrewed AS stillBrewed,
           types, f.name AS fermentation`,

  // The classic graph recommendation: walk from the beer through the things it
  // is connected to (types, brewery, fermentation, alcohol percentage) and
  // score every beer that is reached by how many paths lead to it.
  similarGraph: `
    MATCH (b:Beer {id: $id})
    MATCH (b)-[:HAS_TYPE|BREWED_BY|HAS_FERMENTATION]->(shared)<-[:HAS_TYPE|BREWED_BY|HAS_FERMENTATION]-(o:Beer)
    WHERE o <> b AND ($onlyBrewed = false OR o.stillBrewed)
    WITH b, o, collect(DISTINCT shared) AS via
    WITH b, o, via,
         size([x IN via WHERE x:BeerType]) AS sharedTypes,
         size([x IN via WHERE x:Brewery]) AS sameBrewery,
         size([x IN via WHERE x:Fermentation]) AS sameFermentation,
         CASE WHEN b.abv IS NULL OR o.abv IS NULL THEN 2.0 ELSE abs(b.abv - o.abv) END AS abvGap
    WHERE sharedTypes > 0 OR (sameBrewery > 0 AND abvGap <= 1.0)
    WITH o, sharedTypes, sameBrewery, sameFermentation, abvGap,
         3.0 * sharedTypes + 1.5 * sameBrewery + 0.5 * sameFermentation + CASE WHEN abvGap < 2.5 THEN 2.5 - abvGap ELSE 0 END AS score
    RETURN o.id AS id, o.name AS name, o.breweryName AS brewery, o.abv AS abv, o.stillBrewed AS stillBrewed,
           round(score, 2) AS score,
           [x IN [CASE WHEN sharedTypes > 0 THEN toString(sharedTypes) + ' shared type(s)' END,
                  CASE WHEN sameBrewery > 0 THEN 'same brewery' END,
                  CASE WHEN abvGap <= 0.5 THEN 'same strength' WHEN abvGap <= 1.5 THEN 'similar strength' END] WHERE x IS NOT NULL] AS why
    ORDER BY score DESC, name
    LIMIT 10`,

  // Same question answered by the vector index: nearest neighbours in taste space.
  // (A vector search filter must be a plain predicate, hence two variants.)
  similarVector: (onlyBrewed: boolean) => `
    MATCH (b:Beer {id: $id})
    MATCH (o:Beer)
    SEARCH o IN (VECTOR INDEX beer_taste FOR b.taste${onlyBrewed ? ' WHERE o.stillBrewed = true' : ''} LIMIT 11) SCORE AS score
    WITH o, score WHERE o.id <> $id
    RETURN o.id AS id, o.name AS name, o.breweryName AS brewery, o.abv AS abv, o.stillBrewed AS stillBrewed,
           round(score, 3) AS score
    ORDER BY score DESC, name
    LIMIT 10`,

  // Shortest path between two beers through breweries, types and percentages:
  // the "how is Duvel related to Westvleteren?" query from the original demo.
  path: `
    MATCH (a:Beer {id: $from}), (b:Beer {id: $to})
    MATCH p = SHORTEST 1 (a)-[:HAS_TYPE|BREWED_BY|HAS_ALCOHOLPERCENTAGE]-{1,10}(b)
    RETURN [n IN nodes(p) | {label: labels(n)[0], name: coalesce(n.name, toString(n.value) + '%'), id: n.id}] AS hops`,

  neighbourhood: `
    MATCH (b:Beer {id: $id})-[r]->(x)
    OPTIONAL MATCH (x)<-[r2]-(o:Beer) WHERE o <> b AND NOT x:AlcoholPercentage
    WITH b, r, x, collect(o)[0..8] AS others
    RETURN b.id AS bid, b.name AS bname, type(r) AS rel, labels(x)[0] AS xlabel, coalesce(x.name, toString(x.value) + '%') AS xname,
           [o IN others | {id: o.id, name: o.name}] AS others`,

  // ---- taste memory (persisted in OPFS) ----
  rate: `
    MERGE (d:Drinker {name: $drinker})
    WITH d MATCH (b:Beer {id: $id})
    OPTIONAL MATCH (d)-[old:LIKES|DISLIKES]->(b)
    DELETE old
    WITH d, b
    CALL (d, b) { WITH d, b WHERE $verdict = 'like' CREATE (d)-[:LIKES {at: $at}]->(b) }
    CALL (d, b) { WITH d, b WHERE $verdict = 'dislike' CREATE (d)-[:DISLIKES {at: $at}]->(b) }
    RETURN b.name AS name`,

  unrate: `MATCH (:Drinker {name: $drinker})-[r:LIKES|DISLIKES]->(:Beer {id: $id}) DELETE r`,

  ratings: `
    MATCH (:Drinker {name: $drinker})-[r:LIKES|DISLIKES]->(b:Beer)
    RETURN b.id AS id, b.name AS name, b.breweryName AS brewery, b.abv AS abv, type(r) AS verdict, r.at AS at
    ORDER BY r.at DESC`,

  // Personal recommendations: beers that share types and brewery with what you
  // liked, penalised for what they share with what you disliked.
  forMe: `
    MATCH (d:Drinker {name: $drinker})-[:LIKES]->(liked:Beer)
    MATCH (liked)-[:HAS_TYPE|BREWED_BY]->(x)<-[:HAS_TYPE|BREWED_BY]-(o:Beer)
    WHERE o.stillBrewed AND NOT EXISTS { (d)-[:LIKES|DISLIKES]->(o) }
    WITH d, o, count(*) AS likePaths, collect(DISTINCT liked.name)[0..3] AS because
    OPTIONAL MATCH (d)-[:DISLIKES]->(:Beer)-[:HAS_TYPE|BREWED_BY]->(y)<-[:HAS_TYPE|BREWED_BY]-(o)
    WITH o, likePaths, because, count(y) AS dislikePaths
    WITH o, because, likePaths - 1.5 * dislikePaths AS score WHERE score > 0
    RETURN o.id AS id, o.name AS name, o.breweryName AS brewery, o.abv AS abv, score, because
    ORDER BY score DESC, name LIMIT 12`,

  // The vector flavour: average the taste vectors of everything you liked.
  forMeVector: `
    MATCH (d:Drinker {name: $drinker})-[:LIKES]->(liked:Beer)
    WITH d, collect(liked.tasteList) AS tastes
    WITH d, [i IN range(0, ${TASTE_DIMENSIONS - 1}) | reduce(s = 0.0, t IN tastes | s + t[i]) / size(tastes)] AS centre
    MATCH (o:Beer)
    SEARCH o IN (VECTOR INDEX beer_taste FOR vector(centre, ${TASTE_DIMENSIONS}, FLOAT32) WHERE o.stillBrewed = true LIMIT 40) SCORE AS score
    WITH d, o, score WHERE NOT EXISTS { (d)-[:LIKES|DISLIKES]->(o) }
    RETURN o.id AS id, o.name AS name, o.breweryName AS brewery, o.abv AS abv, round(score, 3) AS score
    ORDER BY score DESC, name LIMIT 12`,

  // "Drinkers like you": collaborative filtering over the Drinker nodes.
  peers: `
    MATCH (me:Drinker {name: $drinker})-[:LIKES]->(b:Beer)<-[:LIKES]-(peer:Drinker)
    WITH me, peer, count(b) AS overlap
    MATCH (peer)-[:LIKES]->(o:Beer)
    WHERE NOT EXISTS { (me)-[:LIKES|DISLIKES]->(o) }
    RETURN o.id AS id, o.name AS name, o.breweryName AS brewery, o.abv AS abv,
           sum(overlap) AS score, collect(DISTINCT peer.name)[0..3] AS because
    ORDER BY score DESC, name LIMIT 10`,

  drinkers: `
    MATCH (d:Drinker)
    RETURN d.name AS name, COUNT { (d)-[:LIKES]->() } AS likes, COUNT { (d)-[:DISLIKES]->() } AS dislikes
    ORDER BY name`,
};

export const SAMPLE_QUERIES: { title: string; cypher: string }[] = [
  { title: 'Strongest beer per type', cypher: `MATCH (b:Beer)-[:HAS_TYPE]->(t:BeerType)
WHERE b.abv IS NOT NULL
WITH t, b ORDER BY b.abv DESC
WITH t, collect(b)[0] AS strongest, count(b) AS beers
WHERE beers >= 10
RETURN t.name AS type, beers, strongest.name AS strongest, strongest.abv AS abv
ORDER BY beers DESC` },
  { title: 'Breweries with the widest range', cypher: `MATCH (br:Brewery)<-[:BREWED_BY]-(b:Beer)
OPTIONAL MATCH (b)-[:HAS_TYPE]->(t:BeerType)
RETURN br.name AS brewery, count(DISTINCT b) AS beers, count(DISTINCT t) AS types,
       round(avg(b.abv), 1) AS avgAbv
ORDER BY types DESC, beers DESC LIMIT 15` },
  { title: 'Most common alcohol percentages', cypher: `MATCH (a:AlcoholPercentage)<-[:HAS_ALCOHOLPERCENTAGE]-(b:Beer)
RETURN a.value AS abv, count(b) AS beers
ORDER BY beers DESC LIMIT 10` },
  { title: 'Discontinued beers and their closest living twin', cypher: `MATCH (gone:Beer) WHERE NOT gone.stillBrewed
WITH gone LIMIT 15
CALL (gone) {
  MATCH (o:Beer)
  SEARCH o IN (VECTOR INDEX beer_taste FOR gone.taste WHERE o.stillBrewed = true LIMIT 1) SCORE AS s
  RETURN o.name AS twin, round(s, 3) AS similarity
}
RETURN gone.name AS discontinued, gone.until AS until, twin, similarity` },
  { title: 'Beer types that are always brewed together', cypher: `MATCH (t1:BeerType)<-[:HAS_TYPE]-(:Beer)-[:BREWED_BY]->(br:Brewery)<-[:BREWED_BY]-(:Beer)-[:HAS_TYPE]->(t2:BeerType)
WHERE t1.name < t2.name
WITH t1, t2, count(DISTINCT br) AS breweries
RETURN t1.name AS type, t2.name AS alsoBrews, breweries
ORDER BY breweries DESC LIMIT 15` },
  { title: 'Data quality: beers without ABV or type', cypher: `MATCH (b:Beer)
WHERE b.abv IS NULL OR NOT EXISTS { (b)-[:HAS_TYPE]->() }
RETURN b.name AS beer, b.breweryName AS brewery, b.abv AS abv,
       EXISTS { (b)-[:HAS_TYPE]->() } AS hasType
ORDER BY brewery LIMIT 25` },
  { title: 'Oldest beers still brewed', cypher: `MATCH (b:Beer) WHERE b.stillBrewed AND b.from IS NOT NULL
RETURN b.name AS beer, b.breweryName AS brewery, b.from AS since
ORDER BY since LIMIT 15` },
];
