// The beer sommelier: Claude, called straight from the browser with the
// visitor's own API key, given tools that query the local relate graph.
// The graph is the agent's knowledge (2,300 beers) and its memory (the
// drinker's likes/dislikes and past questions, persisted in OPFS).

import Anthropic from '@anthropic-ai/sdk';
import { Q, TASTE_DIMENSIONS, type Envelope } from './beergraph';

export type Exec = (cypher: string, params?: Record<string, unknown>) => Promise<Envelope & { wallMs?: number }>;

// Haiku is the default: by far the cheapest ($0.10 / $0.50 per million tokens)
// and good at this kind of tool calling. The bigger models are opt-in.
export const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 · cheapest', fallback: false },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', fallback: true },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 · priciest', fallback: true },
] as const;

export interface ToolEvent {
  name: string; input: Record<string, unknown>; cypher?: string;
  ms?: number; rows?: number; error?: string;
}

const MAX_ROWS = 40;
// run_cypher is for reading. The agent changes the graph only through remember_preference.
const WRITE_CLAUSE = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV|IN\s+TRANSACTIONS|ALTER|GRANT)\b/i;

const SYSTEM = `You are a Belgian beer sommelier with a long memory, working inside a demo app.
Your knowledge of Belgian beers comes from a property graph built from the Dutch Wikipedia "Lijst van Belgische bieren", stored in relate, an embedded graph database that runs in the visitor's browser. Query it with Cypher 25 (openCypher). Don't rely on your own memory for facts about specific beers: look them up. If the graph lacks something (for example tasting notes), say so plainly and give general style knowledge clearly labelled as such.

Graph model:
(:Beer {id, name, abv, from, until, stillBrewed, breweryName, typeText, taste})   taste is a ${TASTE_DIMENSIONS}-dimension vector
(:Beer)-[:BREWED_BY]->(:Brewery {name})
(:Beer)-[:HAS_TYPE {inferred}]->(:BeerType {name})   type names are lowercase Dutch: blond, tripel, dubbel, bruin, amber, witbier, kriek, geuze, lambiek, saison, stout, trappist, abdijbier, fruitbier, kerstbier …
(:Beer)-[:HAS_ALCOHOLPERCENTAGE]->(:AlcoholPercentage {value})
(:Beer)-[:HAS_FERMENTATION]->(:Fermentation {name})   'hoge gisting' | 'lage gisting' | 'spontane gisting' | 'gemengde gisting'
(:Drinker {name})-[:LIKES|DISLIKES {at}]->(:Beer)
(:Drinker)-[:ASKED]->(:Question {text, at})-[:LOOKED_AT]->(:Beer)   earlier conversations
Indexes: FULLTEXT INDEX beer_search on Beer name/breweryName/typeText; VECTOR INDEX beer_taste on Beer.taste.
Vector search syntax: MATCH (o:Beer) SEARCH o IN (VECTOR INDEX beer_taste FOR b.taste WHERE o.stillBrewed = true LIMIT 10) SCORE AS score
Full-text syntax: MATCH (b:Beer) SEARCH b IN (FULLTEXT INDEX beer_search FOR 'westmalle~' LIMIT 10) SCORE AS score
Not available: APOC, GDS, BEGIN/COMMIT. Results are capped at ${MAX_ROWS} rows, so aggregate or use LIMIT.

How to work:
- Find beers by name with search_beers before you use their ids.
- Start with get_taste_profile so you know what this drinker already likes and dislikes.
- When the drinker says they like or dislike a specific beer, record it with remember_preference. That is how you remember them next time.
- Prefer beers that are still brewed, unless they ask about history.
- Reply in the visitor's language. Keep answers conversational and short: a few recommendations, each with a one-line reason grounded in the graph (shared type, same brewery, similar strength, vector similarity). Use plain text with simple "-" bullets; no tables or headings.`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'search_beers',
    description: 'Full-text search over beer names, breweries and types (accent-insensitive; supports fuzzy~ and wildcard*). Returns ids to use with the other tools.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'e.g. "westmalle tripel", "kriek", "chimay~"' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'recommend_similar',
    description: 'Beers similar to a given beer. method "graph" walks shared types, brewery and fermentation and scores by overlap and strength. method "vector" uses nearest neighbours in taste space.',
    input_schema: {
      type: 'object',
      properties: {
        beer_id: { type: 'integer' },
        method: { type: 'string', enum: ['graph', 'vector'] },
        only_still_brewed: { type: 'boolean' },
      },
      required: ['beer_id', 'method', 'only_still_brewed'], additionalProperties: false,
    },
  },
  {
    name: 'get_taste_profile',
    description: "The current drinker's recorded likes and dislikes, plus graph-based picks derived from them and their last few questions.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'remember_preference',
    description: 'Record that the current drinker likes or dislikes a beer (persists in the graph). Use "forget" to remove a rating.',
    input_schema: {
      type: 'object',
      properties: { beer_id: { type: 'integer' }, verdict: { type: 'string', enum: ['like', 'dislike', 'forget'] } },
      required: ['beer_id', 'verdict'], additionalProperties: false,
    },
  },
  {
    name: 'run_cypher',
    description: `Run a read-only Cypher query against the beer graph for anything the other tools do not cover (counts, strongest per type, breweries, history). Writes are rejected. Max ${MAX_ROWS} rows.`,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, params: { type: 'object', description: 'optional $parameters' } },
      required: ['query'], additionalProperties: false,
    },
  },
];

const LOG_TURN = `
  MERGE (d:Drinker {name: $drinker})
  CREATE (d)-[:ASKED]->(q:Question {text: $text, at: $at, model: $model})
  WITH q
  UNWIND $beerIds AS id
  MATCH (b:Beer {id: id})
  MERGE (q)-[:LOOKED_AT]->(b)`;

const RECENT_QUESTIONS = `
  MATCH (:Drinker {name: $drinker})-[:ASKED]->(q:Question)
  RETURN q.text AS question, q.at AS at, COUNT { (q)-[:LOOKED_AT]->() } AS beersLookedAt
  ORDER BY q.at DESC LIMIT 5`;

export class Sommelier {
  private client: Anthropic | null = null;
  private history: Anthropic.Beta.BetaMessageParam[] = [];
  constructor(private exec: Exec, private drinker: () => string) {}

  setKey(apiKey: string) {
    // The key goes straight from this browser to api.anthropic.com; there is no backend.
    this.client = apiKey ? new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) : null;
  }
  get ready() { return this.client != null; }
  reset() { this.history = []; }

  private async tool(name: string, input: any, ev: ToolEvent, seen: Set<number>): Promise<unknown> {
    const run = async (cypher: string, params?: Record<string, unknown>) => {
      ev.cypher = cypher.trim();
      const r = await this.exec(cypher, params);
      ev.ms = r.elapsed_ms ?? r.wallMs; ev.rows = r.rows?.length ?? 0;
      if (r.error) { ev.error = r.error; throw new Error(r.error); }
      for (const row of r.rows) if (typeof row.id === 'number') seen.add(row.id);
      return r.rows.slice(0, MAX_ROWS);
    };
    const drinker = this.drinker();
    switch (name) {
      case 'search_beers': return run(Q.search, { q: String(input.query ?? '') });
      case 'recommend_similar': {
        const onlyBrewed = input.only_still_brewed !== false;
        return input.method === 'vector'
          ? run(Q.similarVector(onlyBrewed), { id: input.beer_id })
          : run(Q.similarGraph, { id: input.beer_id, onlyBrewed });
      }
      case 'get_taste_profile': {
        const ratings = await run(Q.ratings, { drinker });
        const picks = ratings.some((r: any) => r.verdict === 'LIKES') ? await run(Q.forMe, { drinker }) : [];
        const recent = await run(RECENT_QUESTIONS, { drinker });
        ev.cypher = `${Q.ratings.trim()}\n\n${Q.forMe.trim()}\n\n${RECENT_QUESTIONS.trim()}`;
        return { drinker, ratings, graphPicks: picks, recentQuestions: recent };
      }
      case 'remember_preference':
        if (input.verdict === 'forget') return run(Q.unrate, { drinker, id: input.beer_id }).then(() => ({ forgotten: input.beer_id }));
        return run(Q.rate, { drinker, id: input.beer_id, verdict: input.verdict, at: Date.now() });
      case 'run_cypher': {
        const query = String(input.query ?? '');
        if (WRITE_CLAUSE.test(query)) { ev.error = 'rejected: run_cypher is read-only'; throw new Error(ev.error); }
        return run(query, input.params ?? undefined);
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  /**
   * One user turn: loops while Claude asks for tools. `onEvent` gets each tool
   * call (and later its timing) and the text as it arrives, so the UI can show
   * the agent querying the graph.
   */
  async ask(text: string, model: string, on: {
    tool: (ev: ToolEvent) => void; text: (t: string) => void; status: (s: string) => void;
  }): Promise<void> {
    if (!this.client) throw new Error('Add an Anthropic API key first.');
    const m = MODELS.find((x) => x.id === model) ?? MODELS[0];
    const seen = new Set<number>();
    this.history.push({ role: 'user', content: text });

    for (let step = 0; step < 12; step++) {
      on.status(step === 0 ? 'thinking…' : 'reading the graph…');
      const response = await this.client.beta.messages.create({
        model: m.id,
        max_tokens: 16000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages: this.history,
        output_config: { effort: 'medium' },
        ...(m.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      // Keep the full content (thinking and tool_use blocks) so the next request is valid.
      this.history.push({ role: 'assistant', content: response.content });
      for (const block of response.content) if (block.type === 'text' && block.text.trim()) on.text(block.text);

      if (response.stop_reason === 'refusal') { on.text('(The model declined to answer this one.)'); break; }
      if (response.stop_reason === 'max_tokens') { on.text('(The answer was cut off.)'); break; }
      if (response.stop_reason !== 'tool_use') break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const ev: ToolEvent = { name: block.name, input: (block.input ?? {}) as Record<string, unknown> };
        on.tool(ev);
        try {
          const out = await this.tool(block.name, block.input, ev, seen);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: String((e as Error).message ?? e), is_error: true });
        }
        on.tool(ev);
      }
      // All tool results go back in one user message.
      this.history.push({ role: 'user', content: results });
    }
    on.status('');
    // The conversation itself becomes part of the graph.
    await this.exec(LOG_TURN, { drinker: this.drinker(), text, at: Date.now(), model: m.id, beerIds: [...seen].slice(0, 50) });
  }
}
