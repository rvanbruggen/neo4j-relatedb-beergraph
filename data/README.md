# Saved relate store

`beergraph.relate` is a saved copy of the app's persistent relate store.

## Where the live store is

relate runs as WebAssembly in a Web Worker and opens its database with
`RelateDb.open('opfs://beergraph')` ([src/worker.ts](../src/worker.ts)). relate
keeps that database in the browser's Origin Private File System (OPFS) under
`relate/beergraph/`: one `catalog` file and 64 data slots (`slot-00` to
`slot-63`). The store survives reloads and browser restarts, but it lives
inside the browser profile, so it can't be committed directly.

## What this file is

`beergraph.relate` packs those exact OPFS files into one gzipped bundle. The
app writes this file from *Data & storage → Download database file*. It holds:

- the full beer graph: 2,321 beers, 339 breweries, 246 beer types, with the
  full-text and vector indexes
- a demo drinker, `demo`, who likes Westmalle Tripel, Duvel and Orval and
  dislikes Rodenbach Grand Cru, so *My taste* shows recommendations right away

It was made with app 1.3.1 on relate 1.2.0 (154 KB on disk, 1.8 MB unpacked).

## Load it

1. Open the [live demo](https://rvanbruggen.github.io/neo4j-relatedb-beergraph/)
   (or `npm run dev`) in Chrome.
2. Go to *Data & storage* → *Upload database file…* and pick
   `data/beergraph.relate`.
3. The page reloads on the restored store. On *My taste*, type `demo` as the
   drinker name to see the saved likes.

Uploads are checked first. If relate can't open the file, the app puts the
previous graph back.

## File format

The file is gzip. Unpacked, it starts with the 8 bytes `RELATEBG`, then a
4-byte big-endian header length, then a JSON header (app and relate version,
creation time, counts, and the list of store files with their sizes), then the
raw store files one after another, in the order the header lists them.
