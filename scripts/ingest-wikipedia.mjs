// Fetches nl.wikipedia.org/wiki/Lijst_van_Belgische_bieren and turns its tables
// into public/beers.json for the browser demo.
//
//   npm run ingest              fetch live from Wikipedia
//   npm run ingest -- file.json  parse a saved MediaWiki "parse" API response
//
// Table rows look like:  | name || type(s) || 7,1% || brewery ... || 2002-heden
// Italic names ('' ... '') are beers no longer brewed under that name.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseWikitext } from '../src/parse.js';

const PAGE = 'Lijst_van_Belgische_bieren';
const API = `https://nl.wikipedia.org/w/api.php?action=parse&page=${PAGE}&prop=wikitext|revid&format=json&formatversion=2`;

async function load() {
  const file = process.argv[2];
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(API, { headers: { 'User-Agent': 'relatedb-beergraph-demo/0.1' } });
  if (!res.ok) throw new Error(`Wikipedia answered ${res.status}`);
  return res.json();
}

const json = await load();
const { beers, skipped } = parseWikitext(json.parse.wikitext);
const out = {
  source: `https://nl.wikipedia.org/wiki/${PAGE}`,
  revision: json.parse.revid ?? null,
  license: 'CC BY-SA 4.0',
  fetched: new Date().toISOString(),
  beers,
};
writeFileSync('public/beers.json', JSON.stringify(out));

const breweries = new Set(beers.map((b) => b.brewery).filter(Boolean));
const types = new Set(beers.flatMap((b) => b.types));
console.log(`${beers.length} beers, ${breweries.size} breweries, ${types.size} types, ${skipped} rows skipped`);
console.log(`no ABV: ${beers.filter((b) => b.abv == null).length}, no brewery: ${beers.filter((b) => !b.brewery).length}, discontinued: ${beers.filter((b) => !b.stillBrewed).length}`);
