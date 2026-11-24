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

const { getText, reason } = require('./lib/fetch');
const { parseFeed, feedLinks, looksLikeFeed } = require('./lib/feeds');
const { extractArticle } = require('./lib/article');

const PORT = Number(process.env.PORT) || 8091;
// All interfaces, so phones on the same Wi-Fi can connect; HOST=127.0.0.1 keeps it to this PC.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DIRECTORY = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const FEED_CACHE_MS = 5 * 60 * 1000;
const ARTICLE_CACHE_MS = 60 * 60 * 1000;
const CACHE_LIMIT = 500;

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
  return parseFeed(text, finalUrl);
}

/** News about a topic from Google News (no key needed); Bing News if Google fails. */
async function searchNews(q, lang, country) {
  const hl = `${lang}-${country}`;
  const google = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q)
      + `&hl=${hl}&gl=${country}&ceid=${country}:${lang}`;
  try {
    return await readFeed(google);
  } catch (e) {
    const bing = 'https://www.bing.com/news/search?format=rss&q=' + encodeURIComponent(q)
        + `&setlang=${lang}&cc=${country}`;
    return readFeed(bing);
  }
}

/** Feeds for an address: itself if it is a feed, else those the page links to or common paths. */
async function discover(url) {
  const page = await getText(url);
  if (looksLikeFeed(page.text)) {
    const feed = parseFeed(page.text, page.url);
    return [{ url: page.url, title: feed.title, language: feed.language, count: feed.items.length }];
  }
  let links = feedLinks(page.text, page.url);
  if (!links.length) {
    const origin = new URL(page.url).origin;
    links = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'].map(p => ({ url: origin + p }));
  }
  const checked = await Promise.all(links.slice(0, 8).map(async l => {
    try {
      const feed = await cached('feed|' + l.url, FEED_CACHE_MS, () => readFeed(l.url));
      return { url: l.url, title: l.title || feed.title, language: feed.language, count: feed.items.length };
    } catch (e) {
      return null;
    }
  }));
  return checked.filter(Boolean);
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

  if (u.pathname === '/api/directory') return json(res, 200, DIRECTORY);

  if (u.pathname === '/api/feed') {
    const url = webAddress(u);
    if (!url) return json(res, 400, { error: 'Not a web address' });
    return api(res, `feed ${url}`, () => cached('feed|' + url, FEED_CACHE_MS, () => readFeed(url)));
  }

  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) return json(res, 400, { error: 'Nothing to search for' });
    const lang = /^[a-z]{2}$/.test(u.searchParams.get('lang')) ? u.searchParams.get('lang') : 'en';
    const country = /^[A-Z]{2}$/.test(u.searchParams.get('country')) ? u.searchParams.get('country') : 'US';
    return api(res, `search ${q}`, () => cached(`search|${lang}|${country}|${q}`, FEED_CACHE_MS,
        () => searchNews(q, lang, country)));
  }

  if (u.pathname === '/api/discover') {
    const url = webAddress(u);
    if (!url) return json(res, 400, { error: 'Not a web address' });
    return api(res, `discover ${url}`, () => discover(url));
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
