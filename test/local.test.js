'use strict';

// NewsFeed in the NewsFeed app (public/local.js): the API running in the page, with the app
// fetching for it. Here the test plays the app (android/…/MainActivity.java): it serves the page's
// files and answers /app/net the way the app does, against a local site serving the fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const APP_ORIGIN = 'https://appassets.androidplatform.net';
const TOKEN = 'test-token';
/** The start of a PNG file: enough to be recognised as an image. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000200000002008060000007a7af4', 'hex');

const site = http.createServer((req, res) => {
  const routes = { '/rss.xml': ['rss.xml', 'application/rss+xml'], '/latin1.xml': ['latin1.xml', 'application/rss+xml'],
    '/story': ['article.html', 'text/html; charset=utf-8'] };
  if (req.url === '/moved') {
    res.writeHead(301, { Location: '/rss.xml' });
    return res.end();
  }
  if (req.url === '/' && /^localhost:/.test(req.headers.host)) return res.end('<html><p>No icons here.</p></html>');
  if (req.url === '/') return res.end('<html><head><link rel="icon" href="/favicon-32.png" sizes="32x32"></head></html>');
  if (req.url === '/favicon-32.png') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(PNG);
  }
  if (req.url === '/guarded') {
    res.writeHead(403, { 'cf-mitigated': 'challenge', 'Content-Type': 'text/html' });
    return res.end('<html><title>Just a moment...</title></html>');
  }
  const route = routes[req.url];
  if (!route) {
    res.writeHead(404);
    return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': route[1] });
  res.end(fs.readFileSync(path.join(FIXTURES, route[0])));
});

let siteUrl;

test.before(async () => {
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});

test.after(() => site.close());

/** The app's answer to /app/net: what MainActivity.download does. */
async function appNet(u) {
  const ask = u.searchParams;
  let current = ask.get('url');
  const headers = JSON.parse(ask.get('headers'));
  const max = Number(ask.get('max'));
  const follow = ask.get('follow') !== '0';
  const answer = (meta, bytes = new Uint8Array(0)) =>
    new Response(Buffer.concat([Buffer.from(JSON.stringify(meta) + '\n'), Buffer.from(bytes)]));
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetch(current, { method: ask.get('method'), body: ask.get('body') ?? undefined, headers, redirect: 'manual' });
    } catch (e) {
      return answer({ error: 'fetch failed (host not found)', url: current });
    }
    const location = res.headers.get('location');
    if (follow && res.status >= 300 && res.status < 400 && location) {
      if (hop >= 5) return answer({ error: 'Too many redirects', url: current });
      current = new URL(location, current).href;
      continue;
    }
    const passed = {};
    for (const name of ['content-type', 'location', 'x-frame-options', 'content-security-policy', 'cf-mitigated']) {
      if (res.headers.has(name)) passed[name] = res.headers.get(name);
    }
    const meta = { status: res.status, url: current, headers: passed };
    if (!res.ok) return answer(meta);
    return answer(meta, new Uint8Array(await res.arrayBuffer()).subarray(0, max));
  }
}

/** The app: the page's files, its settings and fetching; what the page asked of it. */
function app({ moved = null } = {}) {
  const asked = [];
  async function appFetch(url, init = {}) {
    const u = new URL(url, APP_ORIGIN);
    asked.push(u.pathname);
    const ours = (init.headers || {})['X-NewsFeed'] === TOKEN;
    if (u.pathname === '/app/config.json') {
      return Response.json({ token: TOKEN, syncUrl: 'https://newsfeed-sync.example.workers.dev', moved });
    }
    if (u.pathname === '/app/net') return ours ? appNet(u) : new Response('no', { status: 403 });
    if (u.pathname === '/app/moved') return new Response(ours ? 'ok' : 'no', { status: ours ? 200 : 403 });
    const file = u.pathname === '/sources.json' ? 'sources.json'
      : u.pathname.startsWith('/lib/') ? u.pathname.slice(1) : 'public' + u.pathname;
    try {
      return new Response(fs.readFileSync(path.join(ROOT, file)));
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  }
  return { fetch: appFetch, asked };
}

/** A page's storage. */
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

/** The Cache API, as far as local.js uses it. */
function cacheStorage() {
  const stores = new Map();
  return {
    open: async name => {
      if (!stores.has(name)) {
        const kept = new Map();
        stores.set(name, {
          kept,
          match: async key => kept.get(String(key))?.clone(),
          put: async (key, res) => { kept.set(String(key), res); },
        });
      }
      return stores.get(name);
    },
    stores,
  };
}

/** local.js as it runs in the app's page: { localApi, app, store, caches }. */
function inApp(options = {}) {
  const phone = app(options);
  const store = storage(options.stored);
  const caches = cacheStorage();
  const code = fs.readFileSync(path.join(ROOT, 'public', 'local.js'), 'utf8');
  const location = new URL(APP_ORIGIN + '/');
  // eslint-disable-next-line no-new-func
  const localApi = new Function('location', 'fetch', 'localStorage', 'caches', `${code}\nreturn localApi;`)(
      location, phone.fetch, store, caches);
  return { localApi, app: phone, store, caches };
}

const getJson = async (local, p, q) => {
  const res = await local.fetch(`${p}?${new URLSearchParams(q)}`);
  return { status: res.status, body: await res.json() };
};

test('on the web, local.js does nothing', () => {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'local.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const localApi = new Function('location', 'fetch', `${code}\nreturn localApi;`)(
      new URL('https://newsfeed.example/'), () => assert.fail('nothing is fetched'));
  assert.equal(localApi, null);
});

test('in the app, the API runs in the page: settings, directory and feeds, fetched by the app', async () => {
  const { localApi, app: phone } = inApp();
  const local = await localApi;
  assert.deepEqual((await getJson(local, '/api/config')).body, { syncUrl: 'https://newsfeed-sync.example.workers.dev' });
  const directory = await getJson(local, '/api/directory');
  assert.ok(directory.body.sources.length > 10);

  const feed = await getJson(local, '/api/feed', { url: siteUrl + '/rss.xml' });
  assert.equal(feed.status, 200);
  assert.ok(feed.body.items.length > 0);
  assert.equal(feed.body.url, siteUrl + '/rss.xml');
  // Redirects are followed by the app, and the page is told where they ended.
  const moved = await getJson(local, '/api/feed', { url: siteUrl + '/moved' });
  assert.equal(moved.body.url, siteUrl + '/rss.xml');
  // An ISO-8859-1 feed is read in its own encoding.
  const latin1 = await getJson(local, '/api/feed', { url: siteUrl + '/latin1.xml' });
  assert.equal(latin1.status, 200);
  assert.ok(!JSON.stringify(latin1.body).includes('�'));
  // Only the app's own files and answers were asked for: no server.
  assert.ok(phone.asked.every(p => p.startsWith('/app/') || p.startsWith('/lib/') || ['/sources.json', '/publisher.js'].includes(p)),
      phone.asked.join(' '));
});

test('in the app, failures read as on the server', async () => {
  const local = await inApp().localApi;
  const missing = await getJson(local, '/api/feed', { url: siteUrl + '/missing' });
  assert.equal(missing.status, 502);
  assert.equal(missing.body.error, 'HTTP 404');
  const guarded = await getJson(local, '/api/article', { url: siteUrl + '/guarded' });
  assert.equal(guarded.status, 502);
  assert.equal(guarded.body.error, 'HTTP 403 (browser check)');
  assert.equal(guarded.body.articleUrl, siteUrl + '/guarded');
  const nowhere = await getJson(local, '/api/feed', { url: 'http://nowhere.invalid/feed' });
  assert.equal(nowhere.status, 502);
  assert.match(nowhere.body.error, /fetch failed/);
});

test('in the app, articles are read and pages the phone opened are extracted, all on the phone', async () => {
  const local = await inApp().localApi;
  const article = await getJson(local, '/api/article', { url: siteUrl + '/story' });
  assert.equal(article.status, 200);
  assert.ok(article.body.blocks.length > 0);
  const html = fs.readFileSync(path.join(FIXTURES, 'article.html'), 'utf8');
  const res = await local.fetch('/api/extract', { method: 'POST', body: JSON.stringify({ url: 'https://news.example/story', html }) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).blocks, article.body.blocks);
});

test('in the app, sites’ icons are found by the phone and kept', async () => {
  const { localApi, caches } = inApp();
  const local = await localApi;
  const src = await local.iconUrl(siteUrl);
  assert.match(src, /^blob:/);
  const icon = await (await fetch(src)).arrayBuffer();
  assert.deepEqual(Buffer.from(icon), PNG);
  // A site without one: none, and that is kept too (for less long).
  assert.equal(await local.iconUrl(siteUrl.replace('127.0.0.1', 'localhost')), null);
  const kept = caches.stores.get('newsfeed-icons').kept;
  assert.equal(kept.size, 2);
  assert.deepEqual([...kept.values()].map(r => r.status).sort(), [200, 404]);
});

test('in the app, what the app kept from before comes over once, without replacing what the page has', async () => {
  const moved = { 'newsfeed.sources': '[{"kind":"rss","url":"https://a.example/feed"}]', 'newsfeed.prefs': '{"sort":"oldest"}',
    'other.key': 'not ours' };
  const { localApi, app: phone, store } = inApp({ moved, stored: { 'newsfeed.prefs': '{"sort":"newest"}' } });
  await localApi;
  assert.equal(store.getItem('newsfeed.sources'), moved['newsfeed.sources']);
  assert.equal(store.getItem('newsfeed.prefs'), '{"sort":"newest"}');
  assert.equal(store.getItem('other.key'), null);
  // The app is told the page has it (with its word), so it isn't offered again.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(phone.asked.includes('/app/moved'));
});
