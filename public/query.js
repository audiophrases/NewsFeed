// Search words, as typed in the search box or a topic: climate -sport "north sea", with OR between
// alternatives (housing OR vivienda OR habitatge). The page loads this as a plain script, so these
// are globals there; the tests load it as a module.
'use strict';

/** Lower case without accents, so "Barça" finds "barca" and "habitatge" finds "Habitatge". */
const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * 'climate OR clima -sport "north sea"' -> include [[climate, clima], [north sea]], exclude [sport]:
 * every group of include must match (any one of its words), no exclude may. terms: all include words.
 */
function parseQuery(q) {
  const include = [], exclude = [];
  let lastIncluded = false, orNext = false;
  for (const m of (q || '').matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const quoted = m[2] !== undefined;
    const raw = quoted ? m[2] : m[4];
    if (!quoted && /^(or|\|)$/i.test(raw)) {
      orNext = lastIncluded; // "a OR b" joins b to a's group; a leading OR is ignored
      continue;
    }
    const term = fold(raw);
    const operator = !quoted && /^and$/.test(term);
    const excluded = Boolean(m[1] || m[3]);
    if (term && !operator && !/^(when|site|intitle|source):/.test(term)) {
      if (excluded) exclude.push(term);
      else if (orNext) include[include.length - 1].push(term);
      else include.push([term]);
    }
    lastIncluded = Boolean(term) && !operator && !excluded && !/^(when|site|intitle|source):/.test(term);
    orNext = false;
  }
  return { include, exclude, terms: include.flat() };
}

const haystack = a => fold([a.title, a.summary, a.author, a.sourceName, ...(a.categories || [])].join(' \n '));

function matches(a, query) {
  if (!query.include.length && !query.exclude.length) return true;
  const text = haystack(a);
  return query.include.every(group => group.some(t => text.includes(t))) && !query.exclude.some(t => text.includes(t));
}

/** Best match: a word in the title counts three times as much as one elsewhere. */
function score(a, query) {
  const title = fold(a.title), rest = haystack(a);
  return query.terms.reduce((n, t) => n + (title.includes(t) ? 3 : 0) + (rest.includes(t) ? 1 : 0), 0);
}

if (typeof module === 'object' && module.exports) module.exports = { fold, parseQuery, matches, score };
