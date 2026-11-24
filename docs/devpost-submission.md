# Devpost submission draft: Relate by Neo4j Hackathon

Deadline: **Friday 11 December 2026, 6:00 PM PST** (Saturday 12 December, 03:00 in Belgium).
Each section below maps to one item of "A complete submission" in Section 4 of the official rules.

---

## Project title

Belgian Beer Graph: connected context in a browser tab

## Tagline (short description)

2,300 Belgian beers from Wikipedia in a graph database that runs inside your browser: graph and vector recommendations, a path finder, and a sommelier agent that remembers you. All on relate, with no server.

## What it does and why it is useful

Belgium's beer culture is on UNESCO's list of intangible cultural heritage, and the Dutch Wikipedia keeps a hand-maintained list of more than 2,300 Belgian beers, with their style, strength, brewery and the years they were brewed. As a flat table it is hard to explore. As a graph it starts answering questions: what is like this beer, how are two beers related, what replaced a beer that is no longer brewed?

Belgian Beer Graph loads that list into relate, running as WebAssembly in a Web Worker, and keeps it in the browser's private file storage (OPFS). There is nothing to install and no server: the first visit imports the data in well under a second, and later visits reopen the stored graph in about 250 ms.

- **Recommend:** pick a beer and compare two kinds of "similar". *Graph walk* follows shared types, brewery and fermentation and scores by overlap and strength, in plain Cypher. *Vector neighbours* uses relate's vector index over a small taste vector. A live graph view shows the neighbourhood and highlights the top picks of whichever list is active, with vector similarity drawn as dashed links because it is computed rather than stored.
- **My taste:** likes and dislikes become `(:Drinker)-[:LIKES]->(:Beer)` relationships, which drive "because you liked…", a vector "taste centre" and "drinkers like you" recommendations.
- **Path finder:** the shortest path between any two beers through breweries, types and alcohol percentages.
- **Sommelier (optional):** a Claude agent called straight from the page with the visitor's own API key. Its tools query relate, so its answers are grounded in the graph, and it writes what it learns about you, and each conversation, back into the graph as memory that survives a reload. Every tool call shows the Cypher it ran and how many milliseconds relate took.
- **Cypher console and live re-import:** run any query, or fetch the current Wikipedia page and rebuild the graph in the browser.
- **Take your graph with you:** download relate's own store (the graph, your likes and the sommelier's memory) as one small `.relate` file of about 340 KB, and upload it again in another browser or after clearing site data to carry on where you left off. Uploads are checked, and if relate can't open the file, the previous graph is put back.
- **About:** the story behind the BeerGraph, from my 2013 Monki Gras talk (embedded) to the blog posts that followed, with links to the originals.

The point is the theme of the hackathon: context, connected. The same small graph serves a person browsing, classic graph recommendations, vector retrieval and an agent's long-term memory, all in one process in one browser tab.

## Public GitHub repository

https://github.com/rvanbruggen/neo4j-relatedb-beergraph
(public, Apache-2.0, topics `relate` and `relate-neo4j-hackathon`)

## Which Relate mode does your project use?

Directory: a durable OPFS store in the browser (`opfs://beergraph`, kept as the directory `relate/beergraph/`), with an in-memory fallback only when another tab already holds it.

## Why did you choose this mode?

The app runs entirely in the browser with no server, so a durable OPFS directory is the only way for the graph, the drinker's likes and the sommelier's memory to survive reloads and restarts. It also reopens in about 250 ms instead of importing again. An in-memory database would forget the agent's memory every time the page reloads.

## Path to the persistent store in your repo

`data/beergraph.relate` (see `data/README.md`)

relate runs as WebAssembly in the browser and persists to OPFS (`RelateDb.open('opfs://beergraph')`, which relate stores as `relate/beergraph/`: a catalog plus 64 data slots). That store survives reloads and browser restarts, but it lives in the browser profile. `data/beergraph.relate` is a snapshot of those exact store files, exported with *Data & storage → Download database file*. It holds the full graph (2,321 beers, 339 breweries, 246 types, with the full-text and vector indexes) plus a `demo` drinker with saved likes. Load it in the live demo with *Upload database file…*. The demo video also shows the graph reopening from OPFS after a reload.

## Setup instructions

See "Running it" in the README. In short: open the live demo in Chrome, or `npm install && npm run dev` with Node.js 22.18 or later. `npm test` loads the data into relate and runs every query the app uses.

## Demo

- Working demo: https://rvanbruggen.github.io/neo4j-relatedb-beergraph/
- Video (up to 2 minutes, no login needed to watch): *to record*. A suggested script is below.
- Screenshots: Recommend (graph walk and vector), My taste, Path finder, a sommelier conversation with its tool calls, Data & storage with the backup buttons.

## Statement of capabilities, third-party tools and AI tools

Relate capabilities: the WebAssembly build (`@relate/relate-wasm` 1.2.0) embedded in a Web Worker; OPFS persistence, including backup and restore of the store files as one download; Cypher 25 (UNWIND/MERGE loading, CALL, COUNT and EXISTS subqueries, SHORTEST paths); a full-text index with accent folding and fuzzy matching; a vector index with in-search filtering; the graph as agent memory; per-statement timings.

Third-party: Dutch Wikipedia data (CC BY-SA 4.0) via the MediaWiki API; Vite, TypeScript, force-graph (MIT); Anthropic TypeScript SDK (Apache-2.0); GitHub Pages and Actions.

AI tools: built with Claude Code (Claude Opus 5.5) as pair programmer. It wrote most of the code, the Wikipedia parser and the tests, directed and reviewed by me; I chose the features, the design and the data model. In the app, the optional sommelier uses the Claude API (Claude Haiku 5.5 by default).

Earlier work: a remake of my own Belgian beer graph demo for Neo4j (GraphGist: https://neo4j.com/graphgists/scraping-wikipedia-and-loading-into-a-graphgist/). No code from it is reused; all code was written from 23 November 2026, during the contest period.

---

## Video script (about 1:50)

1. **0:00–0:15** Open the live demo. "A graph database, starting in your browser tab": point at the "relate ready in … ms · OPFS" badge.
2. **0:15–0:45** Search `westmalle`, pick Westmalle Tripel. Graph walk list and the graph view. Switch to Vector neighbours: the red outlines move, dashed similarity links appear. Open "show Cypher".
3. **0:45–1:05** Like two beers, open My taste: "because you liked", taste centre.
4. **1:05–1:20** Path finder: Duvel to Orval.
5. **1:20–1:40** Sommelier: "I love Westmalle Tripel and Duvel, what next?" Show the tool calls with their Cypher and timings, then "What do you remember about my taste?" after a page reload.
6. **1:40–1:50** Data & storage: "Download database file", the whole graph with your memory in one 340 KB file. Close on the repo URL and "runs on relate, no server".

Before recording: check that any music or images in the video are your own or licensed (Section 4).
