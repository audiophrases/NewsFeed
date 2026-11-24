// Reader view: the readable text of an article page, as plain paragraphs (never HTML, so
// nothing from the page can run in the app). A small heuristic, not a full Readability:
// it takes the <article> (or main/body) with the most paragraph text.
'use strict';

const { htmlToText, entities, attrOf, tags, absolute, parseDate } = require('./feeds');

const DROP = /<(script|style|noscript|svg|form|nav|header|footer|aside|iframe|template|button|select|figcaption)\b[\s\S]*?<\/\1>/gi;
const BOILERPLATE = /^(advertisement|sign up|subscribe|read more|related|share this|follow us|cookie|copyright|©)/i;

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
    out.push({ type, text });
  }
  // Headings and list items only count between real paragraphs.
  while (out.length && out[out.length - 1].type !== 'p' && out[out.length - 1].type !== 'quote') out.pop();
  return out;
}

const weight = bs => bs.reduce((n, b) => n + (b.type === 'p' ? b.text.length : 0), 0);

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

function extractArticle(html, url) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(DROP, '');
  let best = [];
  for (const c of candidates(clean)) {
    const bs = blocks(c);
    // The whole page beats an <article> only if the article was a teaser.
    if (weight(bs) > weight(best) * 1.3 || !best.length) best = bs;
  }
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
    words: best.reduce((n, b) => n + b.text.split(/\s+/).length, 0),
  };
}

module.exports = { extractArticle };
