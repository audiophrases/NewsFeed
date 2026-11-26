// NewsFeed: a news reader for the sources and topics you follow. Serves the reader page and,
// because most news sites don't let browsers read their feeds directly, fetches feeds, news
// searches and article pages for it. Built from Play the News' web server.
//
//   node server.js      then open the address it prints, on this PC or a phone on the same Wi-Fi
//
// No dependencies beyond Node 18+.
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { getText, getBytes, postText, reason, FetchError } = require('./lib/fetch');
const { parseFeed, feedLinks, looksLikeFeed, tags, attrOf, absolute, entities, htmlToText } = require('./lib/feeds');
const { articleTitle, extractArticle, withoutDialogs } = require('./lib/article');
const { candidateSites, feedBelongs, feedKey } = require('./lib/sources');
const { iconCandidates, imageType, ICON_MAX_BYTES } = require('./lib/icons');
const googleLinks = require('./lib/googlenews');
const onSite = require('./lib/findarticle');
const { confirmedPublisherLink, foldHeadline, publisherSearchTerm } = require('./public/publisher');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 8091;
// All interfaces, so phones on the same Wi-Fi can connect; HOST=127.0.0.1 keeps it to this PC.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DIRECTORY = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const FEED_CACHE_MS = 5 * 60 * 1000;
const ARTICLE_CACHE_MS = 60 * 60 * 1000;
const ICON_CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 500;
/** A bound on one search's editions against misuse, not a choice: there are fewer languages. */
const MAX_EDITIONS = 25;
/** News searches running at once, across everyone using this server. */
const SEARCH_SLOTS = 3;
// Where news and feed searches go; the tests point these at a local site.
const googleNews = () => process.env.GOOGLE_NEWS_URL || 'https://news.google.com/rss/search';
const bingNews = () => process.env.BING_NEWS_URL || 'https://www.bing.com/news/search';
const feedSearch = () => process.env.FEED_SEARCH_URL || 'https://cloud.feedly.com/v3/search/feeds';
const googleNewsSite = () => process.env.GOOGLE_NEWS_SITE || 'https://news.google.com';
/** The sync service (sync/worker.mjs) the page signs in to, if this server has one: SYNC_URL. */
const syncUrl = () => (/^https?:\/\/[^\s]+$/i.test(process.env.SYNC_URL || '') ? process.env.SYNC_URL.replace(/\/+$/, '') : null);
/** Where Google News links lead, remembered for a month: an article's address doesn't change. */
const LINK_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
/** After Google refuses a lookup, how long to leave it alone. */
const GOOGLE_PAUSE_MS = 30 * 60 * 1000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

// ---- cache (as in Play the News: a promise per key, dropped on failure) ------------------

const cache = new Map();

function cached(key, ms, make) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.promise;
  const promise = make();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return promise;
}

// ---- feeds, searches, articles -----------------------------------------------------------

async function readFeed(url) {
  const { text, url: finalUrl } = await getText(url);
  return { ...parseFeed(text, finalUrl), url: finalUrl };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A runner that does at most n pieces of work at once; the rest wait their turn. */
function slots(n) {
  let running = 0;
  const waiting = [];
  return work => {
    const run = async () => {
      try {
        return await work();
      } finally {
        const next = waiting.shift();
        if (next) next(); // hand the slot straight on
        else running--;
      }
    };
    if (running < n) {
      running++;
      return run();
    }
    return new Promise(resolve => waiting.push(resolve)).then(run);
  };
}

/** News searches wait for one of a few slots, so Google isn't sent a burst at once. */
const inSearchSlot = slots(SEARCH_SLOTS);
/** Icon lookups too: a list of new sources shouldn't set off dozens of home page fetches at once. */
const inIconSlot = slots(4);

/** News about a topic from Google News (no key needed), tried twice; Bing News if Google fails. */
async function searchNews(q, lang, country) {
  const hl = `${lang}-${country}`;
  const google = googleNews() + '?q=' + encodeURIComponent(q) + `&hl=${hl}&gl=${country}&ceid=${country}:${lang}`;
  try {
    return await inSearchSlot(() => readFeed(google));
  } catch (e) {
    // Google now and then refuses one search among many; a second try a moment later works.
    await pause(1000);
    try {
      return await inSearchSlot(() => readFeed(google));
    } catch (e2) {
      const bing = bingNews() + '?format=rss&q=' + encodeURIComponent(q)
          + `&setlang=${lang}&cc=${country}`;
      return inSearchSlot(() => readFeed(bing));
    }
  }
}

const newsSearch = (q, lang, country) =>
  cached(`search|${lang}|${country}|${q}`, FEED_CACHE_MS, () => searchNews(q, lang, country));

/**
 * A topic searched in one or more editions, merged in the order asked; every article keeps its
 * edition's language. They are asked for together and the search slots pace them, so many
 * languages don't take one search time each. Editions that fail are listed; it fails only if
 * all of them do.
 */
async function searchEditions(q, editions) {
  const results = await Promise.all(editions.map(([lang, country]) => newsSearch(q, lang, country)
      .then(feed => ({ items: feed.items.map(item => ({ ...item, lang })) }),
          error => ({ error, edition: `${lang}-${country}` }))));
  const failed = results.filter(r => r.error);
  if (failed.length === editions.length) throw failed[failed.length - 1].error;
  return {
    title: q, language: editions[0][0], items: results.flatMap(r => r.items || []),
    failed: failed.map(r => ({ edition: r.edition, error: reason(r.error) })),
  };
}

/** The editions asked for: editions=ca-ES,en-US, or the older lang=ca&country=ES. */
function editionsOf(u) {
  const list = [];
  const asked = u.searchParams.get('editions')
      || `${u.searchParams.get('lang') || 'en'}-${u.searchParams.get('country') || 'US'}`;
  for (const code of asked.split(',')) {
    const m = /^([a-z]{2})-([A-Z]{2})$/.exec(code.trim());
    if (m && !list.some(([l, c]) => l === m[1] && c === m[2])) list.push([m[1], m[2]]);
  }
  return list.length ? list.slice(0, MAX_EDITIONS) : [['en', 'US']];
}

/** A feed as the "add" dialog lists it, with its newest headline to tell similar ones apart. */
const describeFeed = (url, feed, title) => ({
  url, title: title || feed.title, siteUrl: feed.siteUrl, language: feed.language,
  count: feed.items.length, sample: feed.items[0] ? feed.items[0].title : null,
});

/** WordPress and friends offer a feed of reader comments next to the news one. */
const isCommentsFeed = l => /\/comments\/(feed|rss)|[?&]feed=comments/i.test(l.url)
    || /\b(comments?|comentaris|comentarios|commentaires|kommentare|commenti)\b/i.test(l.title || '');

/** A web page's site name: Open Graph's og:site_name, else its host. */
function siteNameOf(html, url) {
  for (const t of tags(html, 'meta')) {
    if ((attrOf(t, 'property') || attrOf(t, 'name') || '').toLowerCase() !== 'og:site_name') continue;
    const name = entities(attrOf(t, 'content') || '').trim();
    if (name) return name;
  }
  return new URL(url).hostname.replace(/^www\./, '');
}

/**
 * Feeds for an address: itself if it is a feed, else those the page links to or common paths.
 * Each says which site it is on, so a section feed called "Europe" can be named after its site.
 */
async function discover(url) {
  const page = await getText(url);
  if (looksLikeFeed(page.text)) return [describeFeed(page.url, parseFeed(page.text, page.url))];
  const site = siteNameOf(page.text, page.url);
  let links = feedLinks(page.text, page.url).filter(l => !isCommentsFeed(l));
  if (!links.length) {
    const origin = new URL(page.url).origin;
    links = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'].map(p => ({ url: origin + p }));
  }
  const checked = await Promise.all(links.slice(0, 8).map(async l => {
    try {
      const feed = await cached('feed|' + l.url, FEED_CACHE_MS, () => readFeed(l.url));
      return { ...describeFeed(l.url, feed, l.title), site };
    } catch (e) {
      return null;
    }
  }));
  return checked.filter(f => f && !isCommentsFeed(f));
}

/** A feed that works, described for the "add" dialog (at the address it ends up at). */
async function checkFeed(url) {
  const feed = await cached('feed|' + url, FEED_CACHE_MS, () => readFeed(url));
  return describeFeed(feed.url || url, feed);
}

/**
 * Sources for a name such as "El Nacional": the outlets Google News knows by that name (with the
 * feeds their sites offer) and the feeds Feedly lists for it, each checked to work.
 */
async function findSources(q, lang, country) {
  const [news, feedly] = await Promise.all([
    newsSearch(q, lang, country).catch(() => ({ items: [] })),
    getText(`${feedSearch()}?query=${encodeURIComponent(q)}&count=20&locale=${lang}`, { Accept: 'application/json' })
        .then(r => JSON.parse(r.text)).catch(() => ({})),
  ]);
  const sites = candidateSites(q, news.items, Array.isArray(feedly.results) ? feedly.results : []);
  const seen = new Set();
  const resolved = await Promise.all(sites.map(async site => {
    let error = null;
    const failed = e => {
      error = error || reason(e);
      return null;
    };
    const fromSite = site.home
      ? await cached('discover|' + site.home, FEED_CACHE_MS, () => discover(site.home)).catch(failed) || []
      : [];
    const listed = await Promise.all(site.feedUrls.map(url => checkFeed(url).catch(failed)));
    const feeds = [...fromSite, ...listed.filter(f => f && feedBelongs(site, f) && !isCommentsFeed(f))];
    return { site, feeds, error };
  }));
  const out = [];
  for (const { site, feeds, error } of resolved) {
    // The same feed under two addresses (/feed and /rss) has the same name, size and newest story.
    const unique = feeds.filter(f => {
      const keys = [feedKey(f.url), f.sample ? `${f.title}|${f.count}|${f.sample}` : null].filter(Boolean);
      if (keys.some(k => seen.has(k))) return false;
      for (const k of keys) seen.add(k);
      return true;
    }).slice(0, 8).map(({ url, title, language, count, sample }) => ({ url, title, language, count, sample }));
    // An outlet without a feed is still worth showing (so you know why); a stray index entry isn't.
    if (unique.length || site.home) {
      out.push({ name: site.name, host: site.host, home: site.home, feeds: unique, error: unique.length ? null : error });
    }
  }
  return { sites: out };
}

/** A site's icon, as { type, bytes }, or null when it has none we can use (remembered too). */
async function siteIcon(origin) {
  let candidates;
  try {
    // The icon links are in the page's <head>: no need to read a whole home page for them.
    const page = await getText(origin + '/', {}, 512 * 1024);
    candidates = iconCandidates(page.text, page.url);
  } catch (e) {
    candidates = iconCandidates('', origin + '/');
  }
  for (const c of candidates.slice(0, 4)) {
    try {
      const got = await getBytes(c.url, { Accept: 'image/*,*/*;q=0.5' }, ICON_MAX_BYTES);
      const type = got && imageType(got.bytes);
      if (type) return { type, bytes: got.bytes };
    } catch (e) {
      // try the next one
    }
  }
  return null;
}

/** A Google News article link (on Google News, or on the stand-in the tests use). */
function isGoogleNewsLink(url) {
  const u = new URL(url);
  const own = u.hostname === 'news.google.com' || u.origin === new URL(googleNewsSite()).origin;
  return own && Boolean(googleLinks.articleId(url));
}

/** Lookups go one at a time, and stop for a while after Google refuses one. */
const inLookupSlot = slots(1);
let googlePausedUntil = 0;

/**
 * Where a Google News article link leads: asked of Google the way its own article page asks in
 * a browser (the page carries a signature for it). Only for an article someone opens.
 */
async function articleAddress(link, site) {
  const id = googleLinks.articleId(link);
  const inside = googleLinks.addressInside(id);
  if (inside) return inside;
  return inLookupSlot(async () => {
    if (Date.now() < googlePausedUntil) throw new FetchError('Google News isn’t answering NewsFeed’s lookups just now');
    try {
      const page = await getText(`${googleNewsSite()}/rss/articles/${id}`, {}, 1024 * 1024);
      if (new URL(page.url).origin !== new URL(googleNewsSite()).origin && onSite.publisherAddress(page.url, site)) return page.url;
      const signature = googleLinks.signatureOf(page.text);
      if (!signature) throw new FetchError('Google News didn’t say where this article is');
      const answer = await postText(`${googleNewsSite()}/_/DotsSplashUi/data/batchexecute`, googleLinks.lookupBody(id, signature));
      const address = googleLinks.addressFromLookup(answer);
      if (!address) throw new FetchError('Google News didn’t say where this article is');
      return address;
    } catch (e) {
      // Refused, or sent elsewhere instead of answered (a check for unusual traffic, a consent
      // page): leave Google alone for a while rather than insist.
      if (e.requestUrl && new URL(e.requestUrl).origin !== new URL(googleNewsSite()).origin &&
          onSite.publisherAddress(e.requestUrl, site)) return e.requestUrl;
      if (/HTTP (30[1-8]|403|429)/.test(e.message)) {
        googlePausedUntil = Date.now() + GOOGLE_PAUSE_MS;
        console.warn(`Google News refused a lookup (${e.message}); pausing lookups for ${GOOGLE_PAUSE_MS / 60000} min`);
        throw new FetchError('Google News isn’t answering NewsFeed’s lookups just now');
      }
      throw e;
    }
  });
}

/** A sitemap's text (they may be gzipped), at most 20 MB. */
async function readSitemap(url) {
  const got = await getBytes(url, {}, 20 * 1024 * 1024);
  if (!got) return '';
  const bytes = got.bytes[0] === 0x1f && got.bytes[1] === 0x8b ? zlib.gunzipSync(got.bytes) : got.bytes;
  return bytes.toString('utf8');
}

/** The sitemaps worth reading on a site, for recent articles (remembered for half an hour). */
const sitemapsOf = origin => cached('sitemaps|' + origin, 30 * 60 * 1000, async () => {
  let named = [];
  try {
    named = onSite.sitemapsInRobots((await getText(origin + '/robots.txt', {}, 256 * 1024)).text);
  } catch (e) {
    // no robots.txt
  }
  const out = [];
  for (const url of (named.length ? named : [origin + '/sitemap.xml']).slice(0, 4)) {
    try {
      const xml = await readSitemap(url);
      if (/<sitemapindex/i.test(xml)) out.push(...onSite.pickSitemaps(xml, 2));
      else if (/<urlset/i.test(xml)) out.push(url);
    } catch (e) {
      // try the next
    }
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
});

/** A site's home page, for finding its articles: its own feeds, and its links (remembered for half an hour). */
const homeOf = origin => cached('home|' + origin, 30 * 60 * 1000, async () => {
  const page = await getText(origin + '/', {}, 1024 * 1024);
  const feeds = feedLinks(page.text, page.url).filter(l => !isCommentsFeed(l)).map(l => l.url);
  const publisherHome = new URL(page.url).host.replace(/^www\./, '') === new URL(origin).host.replace(/^www\./, '');
  return { feeds: [...feeds.slice(0, 3), new URL('/feed/', page.url).href], links: onSite.siteLinks(page.text, page.url),
    searchForm: publisherHome ? onSite.siteSearchForm(page.text, page.url) : null };
});

/**
 * An article's address found on its own site from its headline: in its feeds, on its home page
 * (some sites' feeds are years out of date), its WordPress search feed, or its sitemaps. Null if
 * it isn't there.
 */
async function findOnSite(site, title) {
  const origin = new URL(site).origin;
  const alternatives = [];
  // Only fetch a couple of plausible pages to verify abbreviated slugs. Never accept a
  // weaker URL match by itself, as several stories can cover the same incident.
  function consider(url, score) {
    if (score < 0.5 || (alternatives.length === 2 && score <= alternatives[1].score)) return;
    if (!onSite.publisherAddress(url, origin) || alternatives.some(candidate => candidate.url === url)) return;
    alternatives.push({ url, score });
    alternatives.sort((a, b) => b.score - a.score);
    if (alternatives.length > 2) alternatives.pop();
  }
  const home = await homeOf(origin).catch(() => ({ feeds: [], links: [] }));
  for (const url of [...new Set(home.feeds)]) {
    const feed = await cached('feed|' + url, FEED_CACHE_MS, () => readFeed(url)).catch(() => null);
    const hit = feed && feed.items.find(i => i.link && onSite.sameHeadline(i.title, title));
    if (hit) return hit.link;
  }
  const linked = onSite.findInLinks(home.links, title, consider);
  if (linked) return linked;
  const search = `${origin}/?s=${encodeURIComponent(title.slice(0, 100))}&feed=rss2`;
  const found = await readFeed(search).catch(() => null);
  const hit = found && found.items.find(i => i.link && onSite.sameHeadline(i.title, title));
  if (hit) return hit.link;
  // A shorter query tolerates punctuation and small edits. Compare the full result title.
  const terms = publisherSearchTerm(title);
  const wp = new URL('/wp-json/wp/v2/search', origin);
  wp.search = new URLSearchParams({ search: terms, type: 'post', per_page: '20' });
  const results = await getText(wp.href, { Accept: 'application/json' }, 128 * 1024)
      .then(page => JSON.parse(page.text)).catch(() => null);
  const post = Array.isArray(results) && onSite.publisherResult(results, title, origin);
  if (post) return post;
  const searches = new Set();
  if (home.searchForm) {
    const native = new URL(home.searchForm.url);
    native.searchParams.set(home.searchForm.name, terms);
    native.hash = '';
    searches.add(native.href);
  }
  searches.add(origin + '/?' + new URLSearchParams({ s: terms }));
  for (const url of searches) {
    const searchPage = await getText(url, PAGE_HEADERS, 1024 * 1024).catch(() => null);
    if (!searchPage) continue;
    const links = onSite.siteLinks(searchPage.text, searchPage.url);
    const match = links.find(l => onSite.sameHeadline(l.text, title) && onSite.publisherAddress(l.url, origin));
    if (match) return match.url;
    for (const link of links) consider(link.url, onSite.slugMatch(link.url, title));
  }
  for (const url of await sitemapsOf(origin).catch(() => [])) {
    const address = onSite.findInSitemap(await readSitemap(url).catch(() => ''), title, consider);
    if (address) return address;
  }
  for (const candidate of alternatives) {
    const page = await fetchPage(candidate.url).catch(() => null);
    if (!page || !onSite.publisherAddress(page.url, origin)) continue;
    const heading = htmlToText((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(page.text) || [])[1] || '');
    if ([heading, articleTitle(page.text)].some(t => t && foldHeadline(t) === foldHeadline(title))) return page.url;
  }
  // Some publishers have neither WordPress nor a usable sitemap. Bing News also indexes
  // publisher links, sometimes wrapped in its own click-through URL.
  const query = new URLSearchParams({ format: 'rss', q: `site:${new URL(origin).hostname} ${title}` });
  const news = await inSearchSlot(() => readFeed(`${bingNews()}?${query}`)).catch(() => null);
  const candidates = (news?.items || []).map(item => {
    let url = item.link;
    if (url && /^(?:https?:\/\/)(?:[\w-]+\.)*bing\.com\//i.test(url)) url = new URL(url).searchParams.get('url');
    return { title: item.title, url };
  });
  return onSite.publisherResult(candidates, title, origin);
}

/**
 * Where a topic's article is: asked of Google News, or, when Google won't say, looked for on the
 * article's own site by its headline.
 */
async function locate(link, title, site) {
  try {
    return await articleAddress(link, site);
  } catch (e) {
    if (!title || !site) throw e;
    const found = await findOnSite(site, title).catch(() => null);
    if (found) return found;
    throw new FetchError(`${e.message}. NewsFeed couldn’t find a matching article on ${new URL(site).hostname.replace(/^www\./, '')}`);
  }
}

// ---- article pages -----------------------------------------------------------------------
//
// An article page is fetched once for both of its uses: the text NewsFeed extracts itself
// (/api/article) and, when that falls short, the page for the browser to make a reading view of
// (/api/page). Pages are large, so only the last few are kept, briefly.

const PAGE_CACHE_MS = 10 * 60 * 1000;
const PAGE_CACHE_SIZE = 20;
/** What a browser asks for when it opens a page; some sites turn away requests that don't. */
const PAGE_HEADERS = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
/** Most of a page the browser is sent for its reading view (scripts and styles are left out first). */
const PAGE_MAX_CHARS = 3 * 1024 * 1024;
const pages = new Map();

function fetchPage(url) {
  const hit = pages.get(url);
  if (hit && Date.now() - hit.at < PAGE_CACHE_MS) return hit.promise;
  const promise = getText(url, PAGE_HEADERS).then(page => {
    if (!/html/i.test(page.type) && !/<html|<body|<p[\s>]/i.test(page.text.slice(0, 5000))) {
      throw new Error('Not a web page');
    }
    return page;
  }).catch(error => {
    if (error.requestUrl) error.articleUrl = url;
    throw error;
  });
  pages.delete(url);
  pages.set(url, { at: Date.now(), promise });
  promise.catch(() => { if (pages.get(url)?.promise === promise) pages.delete(url); });
  if (pages.size > PAGE_CACHE_SIZE) pages.delete(pages.keys().next().value);
  return promise;
}

/** The public WordPress post representation advertised by the page, or named by a numeric permalink. */
async function readPublicPost(url, html = '') {
  const article = new URL(url);
  let endpoint;
  for (const tag of tags(html, 'link')) {
    if (attrOf(tag, 'type') !== 'application/json' || attrOf(tag, 'rel') !== 'alternate') continue;
    const href = absolute(attrOf(tag, 'href'), url);
    if (!href) continue;
    const api = new URL(href);
    if (api.origin === article.origin && /\/wp-json\/wp\/v2\/posts\/\d+\/?$/.test(api.pathname)) {
      endpoint = api;
      break;
    }
  }
  if (!endpoint) {
    const id = article.searchParams.get('p') || /[-/](\d+)\/?$/.exec(article.pathname)?.[1];
    if (!/^\d{1,12}$/.test(id || '')) return null;
    endpoint = new URL('/wp-json/wp/v2/posts/' + id, article);
  }
  endpoint.search = new URLSearchParams({ context: 'view', _fields: 'id,status,link,content' });
  const response = await getText(endpoint.href, { Accept: 'application/json' }, 2 * 1024 * 1024);
  if (new URL(response.url).origin !== article.origin) return null;
  const post = JSON.parse(response.text);
  if (post?.status !== 'publish' || String(post.id) !== endpoint.pathname.split('/').filter(Boolean).pop() ||
      post.content?.protected !== false || typeof post.content.rendered !== 'string') return null;
  const permalink = new URL(post.link);
  if (permalink.origin !== article.origin) return null;
  const samePath = article.pathname !== '/' && permalink.pathname.replace(/\/$/, '') === article.pathname.replace(/\/$/, '');
  for (const [key, value] of article.searchParams) {
    if (!/^(utm_|fbclid$|gclid$)/i.test(key) && key !== 'p' && permalink.searchParams.get(key) !== value) return null;
  }
  const queryId = article.searchParams.get('p');
  if (queryId ? String(post.id) !== queryId : !samePath) return null;
  const result = extractArticle('<article>' + post.content.rendered + '</article>', permalink.href);
  return result.words ? { ...result, from: 'publisher-post' } : null;
}

async function readArticle(url) {
  let page;
  try {
    page = await fetchPage(url);
  } catch (error) {
    // A publisher may serve its public post as JSON even when its website refuses the request.
    if (error.message === 'HTTP 403') {
      const post = await readPublicPost(url).catch(() => null);
      if (post) return { ...post, frameable: error.frameable };
    }
    throw error;
  }
  let article = extractArticle(page.text, page.url);
  if (article.words < 60 && !article.completeness.subscriber && article.completeness.status !== 'full') {
    const post = await readPublicPost(page.url, page.text).catch(() => null);
    if (post && post.words > article.words) {
      article = { ...article, blocks: post.blocks, words: post.words, from: post.from };
      if (article.completeness.expected) {
        article.completeness.status = post.words >= article.completeness.expected * 0.85 ? 'full' : 'partial';
      }
    }
  }
  return { ...article, frameable: page.frameable };
}

/**
 * The page for a reading view made in the browser: its HTML without scripts (but with the
 * article data some pages describe themselves with), styles and inline drawings. Sent as JSON
 * text, never served as a page of NewsFeed's.
 */
async function readerPage(url) {
  const page = await fetchPage(url);
  const html = page.text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (m, attrs) => (/application\/ld\+json/i.test(attrs) ? m : ''))
      .replace(/<(style|svg|template)\b[\s\S]*?<\/\1>/gi, '')
      .slice(0, PAGE_MAX_CHARS);
  return { url: page.url, html: withoutDialogs(html), frameable: page.frameable };
}

// ---- HTTP --------------------------------------------------------------------------------

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function file(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(filePath)] || 'application/octet-stream',
        { 'X-Content-Type-Options': 'nosniff' });
  });
}

function webAddress(u) {
  const url = (u.searchParams.get('url') || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

/** Runs an API call and answers with its JSON, or a 502 saying why it failed. */
async function api(res, what, work) {
  try {
    return json(res, 200, await work());
  } catch (e) {
    const why = reason(e);
    console.warn(`${what}: ${why}`);
    const page = e.articleUrl ? { articleUrl: e.articleUrl, frameable: e.frameable } : {};
    return json(res, 502, { error: why, ...page });
  }
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');

  if (u.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
  if (u.pathname === '/api/directory') return json(res, 200, DIRECTORY);
  if (u.pathname === '/api/config') return json(res, 200, { syncUrl: syncUrl() });

  if (u.pathname === '/api/feed') {
    const url = webAddress(u);
    if (!url) return json(res, 400, { error: 'Not a web address' });
    return api(res, `feed ${url}`, () => cached('feed|' + url, FEED_CACHE_MS, () => readFeed(url)));
  }

  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) return json(res, 400, { error: 'Nothing to search for' });
    return api(res, `search ${q}`, () => searchEditions(q, editionsOf(u)));
  }

  if (u.pathname === '/api/sources') {
    const q = (u.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json(res, 400, { error: 'Nothing to search for' });
    const [[lang, country]] = editionsOf(u);
    return api(res, `sources ${q}`, () => findSources(q, lang, country));
  }

  if (u.pathname === '/api/discover') {
    const url = webAddress(u);
    if (!url) return json(res, 400, { error: 'Not a web address' });
    return api(res, `discover ${url}`, () => discover(url));
  }

  if (u.pathname === '/api/icon') {
    const url = webAddress(u);
    if (!url) return json(res, 400, { error: 'Not a web address' });
    const origin = new URL(url).origin;
    const icon = await cached('icon|' + origin, ICON_CACHE_MS, () => inIconSlot(() => siteIcon(origin)).catch(() => null));
    if (!icon) return send(res, 404, 'No icon', 'text/plain', { 'Cache-Control': 'public, max-age=86400' });
    // The bytes come from another site: never let them run as a page here (an SVG could try).
    return send(res, 200, icon.bytes, icon.type, {
      'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  }

  if (u.pathname === '/api/article' || u.pathname === '/api/page') {
    const url = webAddress(u);
    if (!url) return json(res, 400, { error: 'Not a web address' });
    // For a topic's article, its headline and outlet's site, in case Google News won't say where it is.
    const title = (u.searchParams.get('title') || '').trim().slice(0, 300);
    const site = /^https?:\/\/[^\s]+$/i.test(u.searchParams.get('site') || '') ? u.searchParams.get('site') : null;
    const publishedAt = u.searchParams.get('publishedAt');
    const article = u.pathname === '/api/article';
    return api(res, `${article ? 'article' : 'page'} ${url}`, async () => {
      // A topic's article: first where its Google News link leads (remembered), then the article.
      const address = isGoogleNewsLink(url)
        ? confirmedPublisherLink(url, { title, site, publishedAt }) || await cached('link|' + url, LINK_CACHE_MS, () => locate(url, title, site))
        : url;
      return article ? cached('article|' + address, ARTICLE_CACHE_MS, () => readArticle(address)) : readerPage(address);
    });
  }

  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  const filePath = path.join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  return file(res, filePath);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Server error', 'text/plain');
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`NewsFeed: ${DIRECTORY.sources.length} built-in sources`);
    console.log(`  on this PC:    http://localhost:${PORT}`);
    if (HOST !== '0.0.0.0') return;
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const n of nets) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  on your Wi-Fi: http://${n.address}:${PORT}`);
      }
    }
  });
}

module.exports = { server };
