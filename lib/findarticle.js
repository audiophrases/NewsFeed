// Finding an article on its own site from its headline, for when Google News won't say where a
// link leads (it may refuse servers in data centres): the site's feeds, the links on its home
// page, its WordPress search feed, and its sitemaps, which news sites publish for search engines
// (Google News sitemaps name each article's headline). All public. These are the parts that
// don't fetch.
'use strict';

const { entities } = require('./feeds');

const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The same headline, punctuation, accents and case aside (a long one may have a few words more). */
function sameHeadline(a, b) {
  const x = fold(a), y = fold(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) > 30 && (x.includes(y) || y.includes(x)));
}

/**
 * How many of a headline's words (three letters or more) an address's slug has, 0 to 1. Words are
 * looked for inside the slug: slugs glue elided words on ("s'adhereix" → "sadhereix").
 */
function slugMatch(url, title) {
  let path;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch (e) {
    return 0;
  }
  const slug = fold(path).replace(/ /g, '');
  const words = fold(title).split(' ').filter(w => w.length >= 3);
  return words.length ? words.filter(w => slug.includes(w)).length / words.length : 0;
}

/** The sitemaps a robots.txt names. */
const sitemapsInRobots = text => [...(text || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]);

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
};

/** From a sitemap index, the ones worth reading for a recent article: news sitemaps, then the newest. */
function pickSitemaps(xml, n = 2) {
  const maps = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)]
      .map(m => ({ url: tag(m[1], 'loc'), at: Date.parse(tag(m[1], 'lastmod') || '') || 0 }))
      .filter(m => m.url);
  const news = maps.filter(m => /news/i.test(m.url));
  const newest = maps.filter(m => !news.includes(m)).sort((a, b) => b.at - a.at);
  return [...news, ...newest].slice(0, n).map(m => m.url);
}

/**
 * The article in a sitemap (a urlset) with this headline: by its <news:title>, else the address
 * whose slug has the most of the headline's words (at least 70% of them). Null if none.
 */
function findInSitemap(xml, title) {
  let best = null;
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const url = tag(m[1], 'loc');
    if (!url) continue;
    const named = tag(m[1], 'news:title');
    if (named && sameHeadline(named, title)) return url;
    const score = slugMatch(url, title);
    if (score >= 0.7 && (!best || score > best.score)) best = { url, score };
  }
  return best ? best.url : null;
}

/** A page's links to other pages of its own site, with their text: [{ url, text }], at most 2000. */
function siteLinks(html, pageUrl) {
  const host = u => u.hostname.replace(/^www\./, '');
  const page = new URL(pageUrl);
  const out = [];
  for (const m of (html || '').matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try {
      url = new URL(entities(m[1]).trim(), page);
    } catch (e) {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || host(url) !== host(page) || url.pathname === '/') continue;
    out.push({ url: url.href, text: entities(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() });
    if (out.length >= 2000) break;
  }
  return out;
}

/**
 * Of a page's links, the article with this headline: the link whose text is the headline, else
 * the one whose address's slug has the most of its words (at least 70% of them). Null if none.
 */
function findInLinks(links, title) {
  let best = null;
  for (const { url, text } of links) {
    if (text && sameHeadline(text, title)) return url;
    const score = slugMatch(url, title);
    if (score >= 0.7 && (!best || score > best.score)) best = { url, score };
  }
  return best ? best.url : null;
}

module.exports = { sameHeadline, slugMatch, sitemapsInRobots, pickSitemaps, findInSitemap, siteLinks, findInLinks };
