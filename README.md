# Belgian Beer Graph on relate

A browser-only remake of the classic Neo4j Belgian beer graph demo, running on
[relate](https://relatedb.ai/), Neo4j's embedded graph database for agents,
compiled to WebAssembly. No server: the database runs in a Web Worker in your
browser and persists to OPFS.

The data comes from the Dutch Wikipedia page
[Lijst van Belgische bieren](https://nl.wikipedia.org/wiki/Lijst_van_Belgische_bieren)
(about 2,300 beers, 340 breweries).

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

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # loads the data into relate (WASM, under Node) and runs every query
npm run ingest     # re-fetch Wikipedia into public/beers.json
npm run build      # static site in dist/
```

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

## License

The code in this repository is licensed under the [Apache License 2.0](LICENSE),
the same license as relate. See [NOTICE](NOTICE) for details.

The beer data in `public/beers.json` comes from Wikipedia and stays under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), by Wikipedia contributors.
