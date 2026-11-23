// Parser for the wikitext of nl.wikipedia.org/wiki/Lijst_van_Belgische_bieren.
// Plain JS so the Node ingest script and the browser ("refresh from Wikipedia")
// share one implementation.

/**
 * @typedef {{ name: string, types: string[], inferredTypes: string[], fermentation: string | null,
 *   abv: number | null, brewery: string | null, breweryDetail: string | null,
 *   from: number | null, until: number | null, stillBrewed: boolean }} Beer
 */

const FERMENTATION = [
  [/spontane\s+gisting|spontaan/i, 'spontane gisting'],
  [/gemengde\s+gisting/i, 'gemengde gisting'],
  [/hoge\s+gisting|bovengisting/i, 'hoge gisting'],
  [/lage\s+gisting|ondergisting/i, 'lage gisting'],
];

/** Remove <ref>…</ref>, <ref …/>, comments and {{templates}} (nested). */
function stripMarkup(s) {
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<ref[^>]*\/>/gi, '');
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  let prev;
  do {
    prev = s;
    s = s.replace(/\{\{[^{}]*\}\}/g, '');
  } while (s !== prev);
  s = s.replace(/<br\s*\/?>/gi, ', ');
  s = s.replace(/<\/?[a-z][^>]*>/gi, '');
  return s;
}

/** [[target|label]] → label, [[target]] → target, [http://x label] → label. */
function unlink(s) {
  return s
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/\[https?:\/\/[^\]]*\]/g, '');
}

function clean(s) {
  return unlink(s.replace(/'{2,}/g, '')).replace(/"/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '').trim();
}

function parseAbv(s) {
  const nums = [...clean(s).matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) => parseFloat(m[1].replace(',', '.')));
  const valid = nums.filter((n) => n >= 0 && n <= 30);
  if (!valid.length) return null;
  const avg = valid.length > 1 && /[-–]/.test(s) ? (valid[0] + valid[1]) / 2 : valid[0];
  return Math.round(avg * 10) / 10;
}

function parseTypes(s) {
  const text = clean(s).toLowerCase();
  let fermentation = null;
  let rest = text;
  for (const [re, label] of FERMENTATION) {
    if (re.test(rest)) { fermentation ??= label; rest = rest.replace(new RegExp(re.source, 'gi'), ''); }
  }
  const types = rest
    .split(/,|\/|;| en (?=[a-z])/)
    .map((t) => t.replace(/\(.*?\)/g, '').trim())
    .filter((t) => t && t !== '?' && t.length < 40);
  return { types: [...new Set(types)], fermentation };
}

/** Brewery name = first link label if the cell starts with a link, else text up to the first comma / "voor". */
function parseBrewery(raw) {
  const s = stripMarkup(raw).trim();
  const first = s.match(/^\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/);
  const detail = clean(s) || null;
  let name = first ? first[1] : clean(s).split(/,| voor | in opdracht van |\(| - /)[0];
  name = (name || '').replace(/'{2,}/g, '').trim();
  if (!/[a-zà-ÿ]/i.test(name)) name = '';
  return { brewery: name || null, breweryDetail: detail && detail !== name ? detail : null };
}

function parsePeriod(s) {
  const text = clean(s).toLowerCase();
  const years = [...text.matchAll(/(1[5-9]\d\d|20\d\d)/g)].map((m) => +m[1]);
  const ongoing = /heden|nu\b|present/.test(text);
  return {
    from: years[0] ?? null,
    until: ongoing ? null : (years.length > 1 ? years[years.length - 1] : (years.length === 1 && /[-–]\s*\d/.test(text) ? years[0] : null)),
    ongoing,
    known: text.length > 0,
  };
}

// Style words that often only appear in the beer's name ("Westmalle Tripel").
const NAME_STYLES = ['tripel', 'dubbel', 'quadrupel', 'blond', 'bruin', 'amber', 'kriek', 'framboise', 'geuze', 'gueuze',
  'lambiek', 'wit', 'saison', 'stout', 'porter', 'ipa', 'pils', 'kerst', 'christmas', 'winter', 'rouge', 'triple', 'brune', 'blanche', 'blonde'];
const NAME_STYLE_MAP = { gueuze: 'geuze', triple: 'tripel', blonde: 'blond', brune: 'bruin', blanche: 'witbier', wit: 'witbier',
  rouge: 'roodbruin', kerst: 'kerstbier', christmas: 'kerstbier', winter: 'winterbier', framboise: 'fruitbier', kriek: 'kriek' };

function stylesFromName(name) {
  const words = name.toLowerCase().split(/[^a-zà-ÿ]+/);
  return [...new Set(words.filter((w) => NAME_STYLES.includes(w)).map((w) => NAME_STYLE_MAP[w] ?? w))];
}

/** @param {string} wikitext @returns {{ beers: Beer[], skipped: number }} */
export function parseWikitext(wikitext) {
  const beers = [];
  let skipped = 0;
  const seen = new Set();
  const breweryNames = new Map();
  // Every table section starts with {{Tabelkop lijst van bieren}} and ends with |}
  const sections = wikitext.split(/\{\{Tabelkop lijst van bieren\}\}/).slice(1);
  for (const section of sections) {
    const body = section.split(/\n\|\}/)[0];
    for (const chunk of body.split(/\n\|-[^\n]*/)) {
      const row = chunk.trim();
      if (!row.startsWith('|')) continue;
      // Cells are separated by "||" or by a new line that starts with "|".
      const cells = row.replace(/^\|/, '').split(/\|\||\n\|/).map((c) => c.trim());
      if (cells.length < 4) { skipped++; continue; }
      const nameRaw = stripMarkup(cells[0]);
      const name = clean(nameRaw);
      if (!name) { skipped++; continue; }
      const italic = /^\s*''/.test(nameRaw);
      const { types, fermentation } = parseTypes(stripMarkup(cells[1]));
      const { brewery, breweryDetail } = parseBrewery(cells[3]);
      const period = parsePeriod(stripMarkup(cells[4] ?? ''));
      const stillBrewed = !italic && (period.ongoing || (!period.known) || period.until == null);
      const inferredTypes = stylesFromName(name).filter((t) => !types.includes(t));
      const breweryKey = brewery ? brewery.toLowerCase() : null;
      const breweryName = breweryKey ? (breweryNames.get(breweryKey) ?? breweryNames.set(breweryKey, brewery).get(breweryKey)) : null;
      const key = `${name}|${breweryKey}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      beers.push({
        name, types, inferredTypes, fermentation,
        abv: parseAbv(stripMarkup(cells[2])),
        brewery: breweryName, breweryDetail,
        from: period.from, until: period.until,
        stillBrewed,
      });
    }
  }
  return { beers, skipped };
}
