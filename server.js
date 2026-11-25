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

const { getText, getBytes, reason } = require('./lib/fetch');
const { parseFeed, feedLinks, looksLikeFeed, tags, attrOf, absolute, entities } = require('./lib/feeds');
const { extractArticle } = require('./lib/article');
const { candidateSites, feedBelongs, feedKey } = require('./lib/sources');
const { iconCandidates, imageType, ICON_MAX_BYTES } = require('./lib/icons');

const PORT = Number(process.env.PORT) || 8091;
// All interfaces, so phones on the same Wi-Fi can connect; HOST=127.0.0.1 keeps it to this PC.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DIRECTORY = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const FEED_CACHE_MS = 5 * 60 * 1000;
const ARTICLE_CACHE_MS = 60 * 60 * 1000;
const ICON_CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 500;
/** Editions one topic may search at once (each is one more Google News request). */
const MAX_EDITIONS = 5;
/** News searches running at once, across everyone using this server. */
const SEARCH_SLOTS = 3;
// Where news and feed searches go; the tests point these at a local site.
const googleNews = () => process.env.GOOGLE_NEWS_URL || 'https://news.google.com/rss/search';
const feedSearch = () => process.env.FEED_SEARCH_URL || 'https://cloud.feedly.com/v3/search/feeds';

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
      const bing = 'https://www.bing.com/news/search?format=rss&q=' + encodeURIComponent(q)
          + `&setlang=${lang}&cc=${country}`;
      return inSearchSlot(() => readFeed(bing));
    }
  }
}

const newsSearch = (q, lang, country) =>
  cached(`search|${lang}|${country}|${q}`, FEED_CACHE_MS, () => searchNews(q, lang, country));

/**
 * A topic searched in one or more editions, one after another, merged; every article keeps its
 * edition's language. Editions that fail are listed; it fails only if all of them do.
 */
async function searchEditions(q, editions) {
  const items = [], failed = [];
  let lastError;
  for (const [lang, country] of editions) {
    try {
      const feed = await newsSearch(q, lang, country);
      for (const item of feed.items) items.push({ ...item, lang });
    } catch (e) {
      lastError = e;
      failed.push({ edition: `${lang}-${country}`, error: reason(e) });
    }
  }
  if (failed.length === editions.length) throw lastError;
  return { title: q, language: editions[0][0], items, failed };
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

async function readArticle(url) {
  const page = await getText(url);
  if (!/html/i.test(page.type) && !/<html|<body|<p[\s>]/i.test(page.text.slice(0, 5000))) {
    throw new Error('Not a web page');
  }
  return extractArticle(page.text, page.url);
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
    return json(res, 502, { error: why });
  }
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');

  if (u.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
  if (u.pathname === '/api/directory') return json(res, 200, DIRECTORY);

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

  if (u.pathname === '/api/article') {
    const url = webAddress(u);
    if (!url) return json(res, 400, { error: 'Not a web address' });
    return api(res, `article ${url}`, () => cached('article|' + url, ARTICLE_CACHE_MS, () => readArticle(url)));
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
