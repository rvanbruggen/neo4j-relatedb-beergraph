// Loads public/beers.json into an in-memory relate database (WASM, run under
// Node) and runs every query the app uses. `npm test`.
import { readFileSync } from 'node:fs';
import * as relate from '@relate/relate-wasm';
import { loadBeers, Q, SAMPLE_QUERIES, type Envelope } from '../src/beergraph.ts';

relate.initSync({ module: readFileSync(new URL('../node_modules/@relate/relate-wasm/relate_bg.wasm', import.meta.url)) });
const db = new relate.RelateDb();
let failures = 0;
const exec = (q: string, p?: Record<string, unknown>): Envelope => JSON.parse(db.execute(q, p ? JSON.stringify(p) : null));
const run = (label: string, q: string, p?: Record<string, unknown>) => {
  const t = performance.now();
  const r = exec(q, p);
  const ms = (performance.now() - t).toFixed(1);
  if (r.error) { failures++; console.log(`✗ ${label}: ${r.error}`); return r; }
  console.log(`✓ ${label} (${ms} ms, ${r.rows.length} rows)`, JSON.stringify(r.rows.slice(0, 3)).slice(0, 300));
  return r;
};

const data = JSON.parse(readFileSync(new URL('../public/beers.json', import.meta.url), 'utf8'));
const t0 = performance.now();
await loadBeers(exec, data.beers, { source: data.source, revision: data.revision, fetched: data.fetched });
console.log(`loaded ${data.beers.length} beers in ${(performance.now() - t0).toFixed(0)} ms`);

run('counts', Q.counts);
run('meta', Q.meta);
const hit = run('search', Q.search, { q: 'westmalle tripel' });
const westmalle = hit.rows[0]?.id;
const duvel = run('search accent/fuzzy', Q.search, { q: 'duvel' }).rows[0]?.id;
run('beer', Q.beer, { id: westmalle });
run('similarGraph', Q.similarGraph, { id: westmalle, onlyBrewed: true });
run('similarVector', Q.similarVector(true), { id: westmalle });
run('similarVector all', Q.similarVector(false), { id: westmalle });
run('path', Q.path, { from: duvel, to: westmalle });
run('neighbourhood', Q.neighbourhood, { id: duvel });
run('rate like', Q.rate, { drinker: 'me', id: westmalle, verdict: 'like', at: 1 });
run('rate like 2', Q.rate, { drinker: 'me', id: duvel, verdict: 'like', at: 2 });
run('rate dislike', Q.rate, { drinker: 'me', id: 0, verdict: 'dislike', at: 3 });
run('rate flip', Q.rate, { drinker: 'me', id: 0, verdict: 'like', at: 4 });
run('unrate', Q.unrate, { drinker: 'me', id: 0 });
run('ratings', Q.ratings, { drinker: 'me' });
run('forMe', Q.forMe, { drinker: 'me' });
run('forMeVector', Q.forMeVector, { drinker: 'me' });
run('rate other drinker', Q.rate, { drinker: 'Anna', id: westmalle, verdict: 'like', at: 5 });
run('rate other drinker 2', Q.rate, { drinker: 'Anna', id: 1728, verdict: 'like', at: 6 });
run('peers', Q.peers, { drinker: 'me' });
run('drinkers', Q.drinkers);
for (const s of SAMPLE_QUERIES) run(s.title, s.cypher);
process.exit(failures ? 1 : 0);
