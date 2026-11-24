/// <reference lib="webworker" />
// The worker owns the relate database. OPFS (durable storage) only works in a
// dedicated worker, and running here keeps long statements off the UI thread.

import init, { RelateDb } from '@relate/relate-wasm';
import { isWasmTrap } from '@relate/relate-wasm/trap.js';
import wasmUrl from '@relate/relate-wasm/relate_bg.wasm?url';
import { loadBeers, Q, type Beer, type Envelope } from './beergraph';

const STORE_NAME = 'beergraph';
const STORE = `opfs://${STORE_NAME}`;

export type Request =
  | { id: number; op: 'init' }
  | { id: number; op: 'exec'; cypher: string; params?: Record<string, unknown> }
  | { id: number; op: 'import'; beers: Beer[]; meta: Record<string, unknown> }
  | { id: number; op: 'reset' }
  | { id: number; op: 'snapshot' }
  | { id: number; op: 'restore'; bytes: ArrayBuffer };

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

// ---------------------------------------------------------------------------
// Snapshot and restore: copy relate's own store files (relate/beergraph/ in
// OPFS: a catalog and 64 slots) into one gzipped bundle, and back. relate holds
// exclusive handles on those files, so the database is closed while copying.

const MAGIC = 'RELATEBG';

export interface SnapshotHeader {
  format: 1; app: 'beergraph'; appVersion: string; relateVersion: string;
  created: string; beers: number; drinkerRatings: number;
  files: { name: string; size: number }[];
}

async function storeDir() {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle('relate', { create: true });
  return base.getDirectoryHandle(STORE_NAME, { create: true });
}

async function readStore(): Promise<{ name: string; data: Uint8Array }[]> {
  const dir = await storeDir();
  const out: { name: string; data: Uint8Array }[] = [];
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind !== 'file') continue;
    out.push({ name, data: new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer()) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function writeStore(files: { name: string; data: Uint8Array }[]) {
  const dir = await storeDir();
  const keep = new Set(files.map((f) => f.name));
  for await (const [name] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (!keep.has(name)) await dir.removeEntry(name);
  }
  for (const f of files) {
    const h = await (await dir.getFileHandle(f.name, { create: true })).createSyncAccessHandle();
    try {
      h.truncate(0);
      h.write(f.data, { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
  }
}

async function gzip(data: Uint8Array, mode: 'gzip' | 'gunzip'): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream()
    .pipeThrough(mode === 'gzip' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function counts() {
  return {
    beers: exec('MATCH (b:Beer) RETURN count(b) AS n').rows[0]?.n ?? 0,
    drinkerRatings: exec(`MATCH (:Drinker)-[r:LIKES|DISLIKES]->() RETURN count(r) AS n`).rows[0]?.n ?? 0,
  };
}

/** Close relate, run `fn` on the bare store files, then reopen it. */
async function withStoreClosed<T>(fn: () => Promise<T>): Promise<T> {
  db.free();
  try {
    return await fn();
  } finally {
    db = await RelateDb.open(STORE);
  }
}

async function snapshot(): Promise<{ bytes: ArrayBuffer; header: SnapshotHeader }> {
  if (!persistent) throw new Error('This tab runs on an in-memory copy (another tab holds the store), so there is no store file to download. Close the other tab and reload.');
  const c = counts();
  const files = await withStoreClosed(readStore);
  const header: SnapshotHeader = {
    format: 1, app: 'beergraph', appVersion: __APP_VERSION__, relateVersion: __RELATE_VERSION__,
    created: new Date().toISOString(), ...c, files: files.map((f) => ({ name: f.name, size: f.data.length })),
  };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const total = 8 + 4 + head.length + files.reduce((s, f) => s + f.data.length, 0);
  const raw = new Uint8Array(total);
  raw.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(raw.buffer).setUint32(8, head.length);
  raw.set(head, 12);
  let at = 12 + head.length;
  for (const f of files) { raw.set(f.data, at); at += f.data.length; }
  const packed = await gzip(raw, 'gzip');
  return { bytes: packed.buffer as ArrayBuffer, header };
}

async function restore(bytes: ArrayBuffer): Promise<SnapshotHeader & { restoredBeers: number; restoredRatings: number }> {
  if (!persistent) throw new Error('This tab runs on an in-memory copy (another tab holds the store). Close the other tab, reload, and try again.');
  let raw: Uint8Array;
  try { raw = await gzip(new Uint8Array(bytes), 'gunzip'); } catch { throw new Error('Not a Belgian Beer Graph database file.'); }
  if (new TextDecoder().decode(raw.subarray(0, 8)) !== MAGIC) throw new Error('Not a Belgian Beer Graph database file.');
  const len = new DataView(raw.buffer, raw.byteOffset).getUint32(8);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(12, 12 + len))) as SnapshotHeader;
  if (header.format !== 1 || header.app !== 'beergraph') throw new Error('Unknown database file format.');
  let at = 12 + len;
  const files = header.files.map((f) => {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(f.name)) throw new Error(`Unexpected file name in bundle: ${f.name}`);
    const data = raw.subarray(at, at + f.size);
    at += f.size;
    return { name: f.name, data };
  });
  if (at !== raw.length) throw new Error('The database file is truncated or damaged.');

  // Keep the current store, and put it back if relate cannot open the upload.
  let backup: { name: string; data: Uint8Array }[] = [];
  db.free();
  try {
    backup = await readStore();
    await writeStore(files);
    db = await RelateDb.open(STORE);
    const c = counts();
    if (!c.beers) throw new Error('The uploaded database holds no beers.');
    return { ...header, restoredBeers: c.beers, restoredRatings: c.drinkerRatings };
  } catch (e) {
    try { db.free(); } catch { /* not open */ }
    await writeStore(backup);
    db = await RelateDb.open(STORE);
    throw new Error(`Restore failed, your previous graph is back: ${(e as Error)?.message ?? e}`);
  }
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
    case 'snapshot':
      return snapshot();
    case 'restore':
      return restore(msg.bytes);
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
