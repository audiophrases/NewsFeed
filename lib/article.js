// Reader view: the readable text of an article page, as plain paragraphs (never HTML, so
// nothing from the page can run in the app). A small heuristic, not a full Readability:
// it takes the <article> (or main/body) with the most paragraph text.
//
// It also says how complete that text is. Many news pages describe themselves for search
// engines (JSON-LD): how many words the article has, its whole text, and whether it is for
// subscribers only. Comparing that with what was extracted tells a whole article from the
// opening of a subscriber one; without it, completeness is unknown and said so.
'use strict';

const { htmlToText, entities, attrOf, tags, absolute, parseDate } = require('./feeds');

const DROP = /<(script|style|noscript|svg|form|nav|header|footer|aside|iframe|template|button|select|figcaption)\b[\s\S]*?<\/\1>/gi;
const BOILERPLATE = /^(advertisement|sign up|subscribe|read more|related|share this|follow us|cookie|copyright|©)/i;

/** Page furniture that turns up inside articles, in the languages of the built-in sources. */
const FURNITURE = new RegExp([
  'leggilo quando vuoi', 'a favorits', 'font informativa preferida', 'considerem que acceptes',
  'what questions do you have', 'share your experiences', 'notifica[çc][õo]es', 'subscribe today',
].join('|'), 'i');

/** Also furniture when it is the first or last thing in the text (elsewhere it may be news). */
const EDGE_FURNITURE = new RegExp([
  // (\b only knows ASCII letters, so after "ó" the colon or space is matched instead)
  'cookies?\\b', 'galetes', 'get in touch', '^(actualitzaci[óo]|actualizaci[óo]n|updated|aktualisiert)[:\\s]',
  '\\b(follow|segueix|s[ií]guenos|suivez|folgen sie|seguici|siga)\\b.{0,80}\\b(facebook|instagram|twitter|telegram|whatsapp|tiktok|youtube|sounds)\\b',
  '\\b(subscri(be|u|pci)|suscr[ií]b|abonnez|abonnier|abbona|assine|assinatura)', 'newsletter|butllet[ií]|bolet[ií]n',
].join('|'), 'i');

const furniture = (b, edge) => b.text.length <= 300 && (FURNITURE.test(b.text) || (edge && EDGE_FURNITURE.test(b.text)));

/** A paragraph that doesn't end like a sentence: at the end of a text, a list of headlines. */
const unfinished = b => b.type === 'p' && !/[.!?:;…»”"'’)\]]$/.test(b.text);

function meta(html, ...names) {
  for (const t of tags(html, 'meta')) {
    const key = (attrOf(t, 'property') || attrOf(t, 'name') || attrOf(t, 'itemprop') || '').toLowerCase();
    if (names.includes(key)) {
      const value = attrOf(t, 'content');
      if (value && value.trim()) return entities(value.trim());
    }
  }
  return null;
}

const countWords = s => (s.match(/[\p{L}\p{N}]+(?:['’.,-][\p{L}\p{N}]+)*/gu) || []).length;

/** Text blocks (paragraphs, headings, quotes, list items) of an HTML fragment, in order. */
function blocks(fragment) {
  const out = [];
  for (const m of fragment.matchAll(/<(p|h[2-4]|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (!text || BOILERPLATE.test(text)) continue;
    const type = tag[0] === 'h' ? 'h' : tag === 'blockquote' ? 'quote' : tag === 'li' ? 'li' : 'p';
    if (type === 'p' && text.length < 30 && !/[.!?:»”"]$/.test(text)) continue; // captions, bylines
    if (type === 'li' && text.length < 40) continue; // menus
    if (out.length && out[out.length - 1].text === text) continue;
    if (furniture({ text }, false)) continue;
    out.push({ type, text });
  }
  return trimEdges(out);
}

/**
 * Drops furniture from both ends, and headings, lists and headline links from the end (headline
 * links only while a finished paragraph comes before them, so a text is never emptied by it).
 */
function trimEdges(out, keep = () => false) {
  while (out.length && !keep(out[0]) && furniture(out[0], true)) out.shift();
  for (;;) {
    const last = out[out.length - 1];
    if (!last || keep(last)) break;
    const headlines = unfinished(last) && out.slice(0, -1).some(b => b.type === 'p' && !unfinished(b));
    if ((last.type !== 'p' && last.type !== 'quote') || furniture(last, true) || headlines) out.pop();
    else break;
  }
  return out;
}

const weight = bs => bs.reduce((n, b) => n + (b.type === 'p' ? b.text.length : 0), 0);

/** A run of text with only inline markup and line breaks in it (no block elements), from a tag's end. */
const INLINE_RUN = /(?<=>)(?:[^<]+|<\/?(?:br|b|i|em|strong|a|span|u|sup|sub|small|mark|abbr|cite|q|time|font)\b[^>]*>)+/gi;

/**
 * For pages that write articles without <p>, as text split by <br> line breaks (some local
 * outlets' sites): the longest such run, a paragraph per break.
 */
function lineBreakBlocks(html) {
  let best = [];
  for (const m of html.matchAll(INLINE_RUN)) {
    if (!/<br\b/i.test(m[0])) continue;
    const paras = m[0].split(/<br\b[^>]*>/i).map(t => htmlToText(t).replace(/\s+/g, ' ').trim())
        .filter(t => t.length >= 30 || (t.length > 0 && /[.!?:»”"]$/.test(t)));
    const bs = paras.filter(t => !furniture({ text: t }, false)).map(text => ({ type: 'p', text }));
    if (weight(bs) > weight(best)) best = bs;
  }
  return best;
}

/** Candidate containers, largest first: every <article>, <main>, an itemprop=articleBody, the body. */
function candidates(html) {
  const found = [];
  for (const tag of ['article', 'main']) {
    for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))) found.push(m[1]);
  }
  const body = /itemprop=["']articleBody["'][^>]*>([\s\S]*)/i.exec(html);
  if (body) found.push(body[1]);
  found.push(html);
  return found;
}

const ARTICLE_TYPES = /(^|,)\s*(\w*Article|Report|BlogPosting|LiveBlogPosting|SocialMediaPosting)\s*(,|$)/i;

/** true, false or null from JSON-LD's isAccessibleForFree ("False" and "false" occur too). */
const yesNo = v => (v === true || /^true$/i.test(v) ? true : v === false || /^false$/i.test(v) ? false : null);

/**
 * What the page says about its article in JSON-LD: word count, whole text, whether it is free.
 * Also Open Graph's article:content_tier ("locked" or "metered" for subscribers).
 */
function described(html) {
  const out = { wordCount: null, body: null, free: null };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch (e) {
      continue;
    }
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (ARTICLE_TYPES.test([].concat(node['@type'] || []).join(','))) {
        if (!out.wordCount && Number(node.wordCount) > 0) out.wordCount = Number(node.wordCount);
        if (!out.body && typeof node.articleBody === 'string' && node.articleBody.trim()) out.body = node.articleBody;
        if (out.free === null) out.free = yesNo(node.isAccessibleForFree);
        // Paywalled parts may be described on their own: hasPart: { isAccessibleForFree: false }.
        for (const part of [].concat(node.hasPart || [])) {
          if (part && yesNo(part.isAccessibleForFree) === false) out.free = false;
        }
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
    };
    visit(data);
  }
  if (out.free === null && /^(locked|metered)$/i.test(meta(html, 'article:content_tier') || '')) out.free = false;
  return out;
}

/** The page's own article text as paragraphs; one long run is cut every few sentences. */
function bodyBlocks(body) {
  const paras = htmlToText(entities(body).replace(/\r/g, '')).split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  const out = [];
  for (const p of paras) {
    if (p.length < 1500) {
      out.push({ type: 'p', text: p });
      continue;
    }
    const sentences = p.split(/(?<=[.!?»”"])\s+(?=[\p{Lu}«“"¿¡])/u);
    for (let i = 0; i < sentences.length; i += 4) out.push({ type: 'p', text: sentences.slice(i, i + 4).join(' ') });
  }
  return out;
}

const letters = s => s.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * How complete the text is: "full" when it has about as many words as the page says the article
 * has; "partial" when it has clearly fewer, or when a subscriber article doesn't say how long it is
 * (then what's readable is usually its opening); "unknown" when the page says nothing.
 */
function completeness(words, about) {
  const subscriber = about.free === false;
  const bodyWords = about.body ? countWords(htmlToText(about.body)) : 0;
  // A subscriber page's articleBody can be just its teaser, so only a long one counts as a measure.
  const expected = about.wordCount || (bodyWords >= (subscriber ? 250 : 50) ? bodyWords : null);
  if (expected) return { status: words >= expected * 0.85 ? 'full' : 'partial', expected, subscriber };
  return { status: subscriber ? 'partial' : 'unknown', expected: null, subscriber };
}

function extractArticle(html, url) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(DROP, '');
  let best = [];
  for (const c of candidates(clean)) {
    const bs = blocks(c);
    // The whole page beats an <article> only if the article was a teaser.
    if (weight(bs) > weight(best) * 1.3 || !best.length) best = bs;
  }
  // Practically no paragraphs: the article may be text with line breaks instead. (Not when there
  // is a teaser: then a longer line-broken run is more likely a notice than the article.)
  if (weight(best) < 150) {
    const lines = trimEdges(lineBreakBlocks(clean));
    if (lines.length >= 2 && weight(lines) > weight(best) * 1.5) best = lines;
  }
  const about = described(html);
  let from = 'page';
  if (about.body) {
    const own = bodyBlocks(about.body);
    const ownText = letters(own.map(b => b.text).join(' '));
    const inOwn = b => ownText.includes(letters(b.text).slice(0, 80));
    const ownWords = own.reduce((n, b) => n + countWords(b.text), 0);
    const bestWords = best.reduce((n, b) => n + countWords(b.text), 0);
    if (ownWords >= 50 && ownWords > bestWords * 1.15) {
      // The page holds more of the article than it shows (or than we found): use its own text.
      best = own;
      from = 'page-data';
    } else if (best.filter(b => b.type === 'p').filter(inOwn).length >= best.filter(b => b.type === 'p').length * 0.6) {
      // Most of what we found is the article: anything at either end that isn't, is furniture
      // (except a long heading at the top, which is usually the standfirst).
      while (best.length && !inOwn(best[0]) && !(best[0].type === 'h' && best[0].text.length >= 40)) best.shift();
      while (best.length && !inOwn(best[best.length - 1])) best.pop();
      best = trimEdges(best, inOwn);
    }
  }
  const words = best.reduce((n, b) => n + countWords(b.text), 0);
  const title = meta(html, 'og:title', 'twitter:title')
      || htmlToText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '') || null;
  return {
    url,
    title,
    site: meta(html, 'og:site_name', 'application-name') || new URL(url).hostname.replace(/^www\./, ''),
    author: meta(html, 'author', 'article:author', 'parsely-author', 'sailthru.author'),
    image: absolute(meta(html, 'og:image', 'twitter:image', 'twitter:image:src'), url),
    publishedAt: parseDate(meta(html, 'article:published_time', 'datepublished', 'date', 'pubdate', 'parsely-pub-date')),
    description: meta(html, 'og:description', 'description', 'twitter:description'),
    blocks: best,
    words,
    from,
    completeness: completeness(words, about),
  };
}

module.exports = { extractArticle };
