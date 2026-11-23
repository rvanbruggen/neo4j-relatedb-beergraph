/// <reference lib="webworker" />
// The worker owns the relate database. OPFS (durable storage) only works in a
// dedicated worker, and running here keeps long statements off the UI thread.

import init, { RelateDb } from '@relate/relate-wasm';
import { isWasmTrap } from '@relate/relate-wasm/trap.js';
import wasmUrl from '@relate/relate-wasm/relate_bg.wasm?url';
import { loadBeers, Q, type Beer, type Envelope } from './beergraph';

const STORE = 'opfs://beergraph';

export type Request =
  | { id: number; op: 'init' }
  | { id: number; op: 'exec'; cypher: string; params?: Record<string, unknown> }
  | { id: number; op: 'import'; beers: Beer[]; meta: Record<string, unknown> }
  | { id: number; op: 'reset' };

export interface InitInfo {
  persistent: boolean; storageError: string | null;
  wasmMs: number; openMs: number; beers: number; drinkerRatings: number;
}

let db: RelateDb;
let persistent = false;

const exec = (cypher: string, params?: Record<string, unknown>): Envelope =>
  JSON.parse(db.execute(cypher, params ? JSON.stringify(params) : null));

async function open(): Promise<InitInfo> {
  const t0 = performance.now();
  await init({ module_or_path: wasmUrl });
  const t1 = performance.now();
  let storageError: string | null = null;
  try {
    db = await RelateDb.open(STORE);
    persistent = true;
  } catch (e) {
    // Another tab holds the store, or the browser has no OPFS: fall back to memory.
    storageError = String((e as Error)?.message ?? e);
    db = new RelateDb();
    persistent = false;
  }
  const t2 = performance.now();
  const beers = exec('MATCH (b:Beer) RETURN count(b) AS n').rows[0]?.n ?? 0;
  const drinkerRatings = exec(`MATCH (:Drinker)-[r:LIKES|DISLIKES]->() RETURN count(r) AS n`).rows[0]?.n ?? 0;
  return { persistent, storageError, wasmMs: t1 - t0, openMs: t2 - t1, beers, drinkerRatings };
}

async function handle(msg: Request): Promise<unknown> {
  switch (msg.op) {
    case 'init':
      return open();
    case 'exec': {
      const t = performance.now();
      const env = exec(msg.cypher, msg.params);
      return { ...env, wallMs: performance.now() - t };
    }
    case 'import': {
      const t = performance.now();
      // Keep the drinker's taste memory across a data refresh.
      const ratings = exec(`MATCH (d:Drinker)-[r:LIKES|DISLIKES]->(b:Beer)
                            RETURN d.name AS drinker, type(r) AS verdict, r.at AS at, b.name AS name, b.breweryName AS brewery`).rows;
      exec('MATCH (n) DETACH DELETE n');
      await loadBeers(exec, msg.beers, msg.meta, (done) => self.postMessage({ progress: done, total: msg.beers.length }));
      exec(`UNWIND $ratings AS r
            MATCH (b:Beer {name: r.name}) WHERE b.breweryName = r.brewery OR (b.breweryName IS NULL AND r.brewery IS NULL)
            MERGE (d:Drinker {name: r.drinker})
            WITH d, b, r
            CALL (d, b, r) { WITH d, b, r WHERE r.verdict = 'LIKES' CREATE (d)-[:LIKES {at: r.at}]->(b) }
            CALL (d, b, r) { WITH d, b, r WHERE r.verdict = 'DISLIKES' CREATE (d)-[:DISLIKES {at: r.at}]->(b) }`, { ratings });
      return { ms: performance.now() - t, counts: exec(Q.counts).rows };
    }
    case 'reset':
      db.reset();
      return { ok: true };
  }
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id } = e.data;
  try {
    self.postMessage({ id, result: await handle(e.data) });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err), trap: isWasmTrap(err) });
  }
};
