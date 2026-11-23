# Belgian Beer Graph on relate

**Version:** 1.2.0 · [Changelog](CHANGELOG.md) · [Live demo](https://rvanbruggen.github.io/neo4j-relatedb-beergraph/)

A browser-only remake of the classic Neo4j Belgian beer graph demo, running on
[relate](https://relatedb.ai/), Neo4j's embedded graph database for agents,
compiled to WebAssembly. No server: the database runs in a Web Worker in your
browser and persists to OPFS.

The data comes from the Dutch Wikipedia page
[Lijst van Belgische bieren](https://nl.wikipedia.org/wiki/Lijst_van_Belgische_bieren)
(about 2,300 beers, 340 breweries).

Built for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) ("Context,
connected"). This is an independent project. It is not made, sponsored or
endorsed by Neo4j; "Neo4j" and "Relate" are trademarks of Neo4j, Inc. and are
used here only to name the product the project is built on.

## What's in it

- **Recommend**: pick a beer, and get recommendations two ways side by side.
  - *Graph walk*: shared types, brewery, fermentation and strength, scored in Cypher.
  - *Vector neighbours*: relate's built-in vector index over a small "taste vector".
  - A force-directed view of the beer's neighbourhood.
- **Sommelier**: an optional LLM agent. Paste your own Anthropic API key and
  Claude (Haiku 5.5 by default, the cheapest model) answers questions by calling
  tools that run Cypher on the local graph. It writes your likes and its
  conversations back into the graph, so it remembers you after a reload. Each
  tool call shows the Cypher it ran and how long relate took.
- **My taste**: likes and dislikes stored as `(:Drinker)-[:LIKES]->(:Beer)`,
  with graph-based, vector-based and "drinkers like you" recommendations.
- **Path finder**: the shortest path between two beers through breweries,
  types and alcohol percentages.
- **Cypher console**: run any query, with sample queries included.
- **Data & storage**: re-import live from Wikipedia (parsed in the browser),
  engine timings, and wiping the OPFS store.
- **About**: the story behind the BeerGraph, links to the original BeerGraph
  articles (2013-2021), the Monki Gras 2013 talk, and where to find the author.

## Graph model

```
(:Beer {id, name, abv, from, until, stillBrewed, taste})
(:Beer)-[:BREWED_BY]->(:Brewery {name})
(:Beer)-[:HAS_TYPE {inferred}]->(:BeerType {name})
(:Beer)-[:HAS_ALCOHOLPERCENTAGE]->(:AlcoholPercentage {value})
(:Beer)-[:HAS_FERMENTATION]->(:Fermentation {name})
(:Drinker {name})-[:LIKES|DISLIKES {at}]->(:Beer)
(:Drinker)-[:ASKED]->(:Question {text, at})-[:LOOKED_AT]->(:Beer)
```

## Running it

**Quickest:** open the [live demo](https://rvanbruggen.github.io/neo4j-relatedb-beergraph/)
in Chrome (or another Chromium-based browser). Nothing to install, no account
needed. The first visit imports the beer list into relate in under a second;
later visits reopen it from OPFS.

**Locally** you need [Node.js](https://nodejs.org/) 22.18 or later (24 LTS
recommended), npm, and Chrome.

```bash
git clone https://github.com/rvanbruggen/neo4j-relatedb-beergraph.git
cd neo4j-relatedb-beergraph
npm install
npm run dev        # open http://localhost:5173
```

Other commands:

```bash
npm test           # loads the data into relate (WASM, under Node) and runs every query the app uses
npm run build      # static site in dist/ (serve it with: npx vite preview)
npm run ingest     # re-fetch the Wikipedia list into public/beers.json (optional; a copy is committed)
```

**Trying it out:** on *Recommend*, search for a beer (try `westmalle`, `kriek`
or the typo `chimay blau~`), switch between *Graph walk* and *Vector
neighbours*, and click beers in the graph. Press *I like this* on a few beers,
then open *My taste*. On *Path finder*, connect two beers (for example *Duvel*
and *Orval*). Every panel has a *show Cypher* link with the exact query and how
many milliseconds relate took.

**The sommelier is optional.** It needs an Anthropic API key, which the visitor
pastes into the page (calls are billed to that key, and Haiku 5.5, the cheapest
model, is the default). Every other feature works without a key and without any
LLM.

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.

## Notes and limits

- relate's browser build is documented as tested in Chrome only. OPFS needs a
  dedicated worker, and only one tab can hold the store at a time. A second
  tab falls back to an in-memory copy.
- The sommelier calls `api.anthropic.com` directly from the browser with the
  visitor's key (`dangerouslyAllowBrowser`). The key stays in memory unless the
  visitor ticks "remember", which keeps it in localStorage. Calls are billed to
  the visitor's account.
- The taste vector is deliberately simple (style families, fermentation, ABV),
  so beers of the same style and strength tie at similarity 1.0.
- The Wikipedia table is hand-maintained, so parsing is heuristic. Style words
  that only appear in a beer's name ("Westmalle Tripel") are added as
  `inferred` types.

## What it uses (hackathon statement)

**Relate capabilities**

- The WebAssembly build (`@relate/relate-wasm` 1.2.0), embedded in a dedicated
  Web Worker: the database runs in process in the browser, with no server.
- Durable OPFS storage (`RelateDb.open('opfs://beergraph')`), with a fallback
  to an in-memory database when another tab holds the store.
- Cypher 25: batched `UNWIND`/`MERGE` loading, `CALL` subqueries, `COUNT {}`
  and `EXISTS {}` subqueries, list comprehensions, and `SHORTEST` paths over
  quantified relationship patterns (Path finder).
- A full-text index (`standard-folding` analyzer for accent-insensitive
  search, plus fuzzy and wildcard terms) for the search boxes and the agent's
  `search_beers` tool.
- A vector index (cosine, exact nearest neighbours) with an in-search filter on
  `stillBrewed`, for "vector neighbours", the "taste centre" recommendation and
  "closest living twin of a discontinued beer".
- The graph as agent memory: the sommelier reads and writes
  `(:Drinker)-[:LIKES|DISLIKES]->(:Beer)` and logs each conversation as
  `(:Drinker)-[:ASKED]->(:Question)-[:LOOKED_AT]->(:Beer)`, persisted in OPFS.
- The per-statement timings in relate's result envelope (`elapsed_ms`), shown
  next to every result.

**Third-party tools and data**

- Beer data: Dutch Wikipedia, *Lijst van Belgische bieren* (CC BY-SA 4.0),
  fetched through the MediaWiki API and parsed by `src/parse.js`.
- [Vite](https://vite.dev/) 8 and TypeScript 7 (build), [force-graph](https://github.com/vasturiano/force-graph)
  1.52 (MIT, graph drawing), the [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)
  1.13 (Apache-2.0, sommelier), GitHub Pages and GitHub Actions (hosting).

**AI tools**

- The project was built with [Claude Code](https://claude.com/claude-code)
  (Claude Opus 5.5) as a pair programmer: it wrote most of the code, the
  Wikipedia parser and the tests, directed and reviewed by the author, who
  chose the features, the design and the data model.
- In the app, the optional sommelier calls the Claude API (Claude Haiku 5.5 by
  default) with tools that query relate.

**Earlier work.** The idea is a remake of the author's own Belgian beer graph
demo for Neo4j, last published as a
[GraphGist](https://neo4j.com/graphgists/scraping-wikipedia-and-loading-into-a-graphgist/).
No code from that demo is reused: everything in this repository was written
from 2026-11-23 onwards, during the contest period.

## Version Tracking

The version follows `a.b.c` and is released with the `/bump` process
(`/bump major|minor|dot`), which commits, tags `v<version>` and pushes. The
version lives in these places:

- `package.json` and `package-lock.json` (`"version"`): the source of truth
- `README.md`: the **Version:** line at the top
- `CHANGELOG.md`: one row per release, newest first

The app footer shows the version too, but it reads it from `package.json` at
build time (`__APP_VERSION__` in `vite.config.ts`), so it needs no manual edit.
Every push to `main` redeploys GitHub Pages.

## License

The code in this repository is licensed under the [Apache License 2.0](LICENSE),
the same license as relate. See [NOTICE](NOTICE) for details.

The beer data in `public/beers.json` comes from Wikipedia and stays under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), by Wikipedia contributors.
