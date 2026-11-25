'use strict';

// The server end to end, against a local site serving the fixtures.
process.env.ALLOW_PRIVATE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { server } = require('../server');

const FIXTURES = path.join(__dirname, 'fixtures');
/** What the stand-in Google News was asked: lookups it answered. */
const lookups = [];

/** Stands in for Google News' article pages and the lookup they make (see lib/googlenews.js). */
function googleNews(req, res, u) {
  if (req.method === 'POST' && u.pathname === '/_/DotsSplashUi/data/batchexecute') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const asked = decodeURIComponent(body);
      lookups.push(asked);
      if (asked.includes('CBMiRefused')) {
        res.writeHead(429);
        return res.end('Too many requests');
      }
      if (asked.includes('CBMiRedirected')) {
        // What a server in a data centre may get: sent to a check for unusual traffic.
        res.writeHead(302, { Location: 'https://www.google.com/sorry/index?continue=x' });
        return res.end();
      }
      const ok = asked.includes('SIG-OK') && asked.includes('1764081234');
      res.end(ok ? `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"${siteUrl}/story\\",1]",null,null,null,"generic"],["di",12]]`
        : `)]}'\n\n[["wrb.fr","Fbv4je",null,null,null,[3],"generic"]]`);
    });
    return true;
  }
  if (u.pathname.startsWith('/rss/articles/')) {
    const signed = !u.pathname.includes('NoSignature');
    res.end(`<html><body><c-wiz ${signed ? 'data-n-a-sg="SIG-OK" data-n-a-ts="1764081234"' : ''}></c-wiz></body></html>`);
    return true;
  }
  return false;
}

const site = http.createServer((req, res) => {
  if (googleNews(req, res, new URL(req.url, siteUrl))) return;
  const routes = {
    '/': ['site.html', 'text/html'], '/rss.xml': ['rss.xml', 'application/rss+xml'],
    '/atom.xml': ['atom.xml', 'application/atom+xml'], '/latin1.xml': ['latin1.xml', 'application/rss+xml'],
    '/story': ['article.html', 'text/html; charset=utf-8'],
    '/comments/feed/': ['rss.xml', 'application/rss+xml'],
  };
  if (req.url === '/moved') {
    res.writeHead(301, { Location: '/rss.xml' });
    return res.end();
  }
  // Asked for as localhost, the site is one without icons.
  if (req.url === '/' && /^localhost:/.test(req.headers.host)) {
    return res.end('<html><head><link rel="alternate" type="application/rss+xml" href="/local-feed.xml"></head>'
        + '<body><p>No icons here.</p><a href="/story">The council approves the budget for next year</a></body></html>');
  }
  // That site's own feed, with a topic's article in it (found by its headline when Google won't say).
  if (req.url === '/local-feed.xml') {
    const here = `http://${req.headers.host}`;
    return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local news</title><link>${here}/</link>
      <item><title>Torredembarra s'adhereix a l'Associació per l'Impuls Metropolità</title><link>${here}/story</link></item>
      </channel></rss>`);
  }
  if (req.url === '/favicon-32.png') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); // mislabelled, as sites do
    return res.end(PNG);
  }
  const u = new URL(req.url, siteUrl);
  if (u.pathname === '/gnews') return res.end(newsSearchXml(u.searchParams.get('q'), u.searchParams.get('hl')));
  if (u.pathname === '/feedly') return res.end(JSON.stringify(feedSearchJson()));
  const route = routes[req.url];
  if (!route) {
    res.writeHead(404);
    return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': route[1] });
  res.end(fs.readFileSync(path.join(FIXTURES, route[0])));
});

/** Stands in for Google News: one story from this site per edition, one from another outlet. */
const newsSearchXml = (q, hl) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${q} - Google News</title>
<item><title>${q} story in ${hl} - Example News</title><link>${siteUrl}/story?hl=${hl}</link><guid>${hl}-1</guid>
<pubDate>Mon, 23 Nov 2026 10:05:00 GMT</pubDate><source url="${siteUrl}">Example News</source></item>
<item><title>Other story in ${hl} - Elsewhere</title><link>https://elsewhere.example/${hl}</link><guid>${hl}-2</guid>
<pubDate>Mon, 23 Nov 2026 09:00:00 GMT</pubDate><source url="https://elsewhere.example">Elsewhere</source></item>
</channel></rss>`;

/** Stands in for Feedly's feed search: two feeds of this site and one unrelated. */
const feedSearchJson = () => ({ results: [
  { feedId: `feed/${siteUrl}/rss.xml`, title: 'Example News', website: siteUrl, subscribers: 10 },
  { feedId: `feed/${siteUrl}/latin1.xml`, title: 'Example News en français', website: siteUrl, subscribers: 5 },
  { feedId: 'feed/https://unrelated.example/feed', title: 'Unrelated', website: 'https://unrelated.example' },
] });

/** The start of a PNG file: enough for the server to recognise it as an image. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000200000002008060000007a7af4', 'hex');

let siteUrl, appUrl;

test.before(async () => {
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  appUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.GOOGLE_NEWS_URL = siteUrl + '/gnews';
  process.env.FEED_SEARCH_URL = siteUrl + '/feedly';
  process.env.GOOGLE_NEWS_SITE = siteUrl;
});

test.after(() => {
  site.close();
  server.close();
});

const api = async (p, q) => {
  const res = await fetch(`${appUrl}${p}?${new URLSearchParams(q)}`);
  return { status: res.status, body: await res.json() };
};

test('config: the sync service, when this server has one', async () => {
  const was = process.env.SYNC_URL;
  try {
    delete process.env.SYNC_URL;
    assert.deepEqual((await api('/api/config', {})).body, { syncUrl: null });
    process.env.SYNC_URL = 'https://newsfeed-sync.example.workers.dev/';
    assert.deepEqual((await api('/api/config', {})).body, { syncUrl: 'https://newsfeed-sync.example.workers.dev' });
    process.env.SYNC_URL = 'javascript:alert(1)';
    assert.deepEqual((await api('/api/config', {})).body, { syncUrl: null });
  } finally {
    if (was === undefined) delete process.env.SYNC_URL;
    else process.env.SYNC_URL = was;
  }
});

test('directory', async () => {
  const { status, body } = await api('/api/directory', {});
  assert.equal(status, 200);
  assert.ok(body.sources.length > 30);
  const groups = new Set(body.groups.map(g => g.id));
  for (const s of body.sources) {
    assert.ok(groups.has(s.group), s.name);
    // A feed, or (for a site that refuses NewsFeed) its headlines via Google News, replacing its feed.
    if (s.kind === 'news') {
      assert.match(s.site, /^[a-z0-9.-]+\.[a-z]+(\/[a-z0-9/-]*)?$/, s.name);
      assert.match(s.edition, /^[a-z]{2}-[A-Z]{2}$/, s.name);
      assert.match(s.replaces, /^https:\/\//, s.name);
    } else assert.match(s.url, /^https:\/\//);
    if (s.country) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'flags', `${s.country}.png`)), s.country);
  }
  assert.equal(new Set(body.sources.map(s => s.url || s.site)).size, body.sources.length, 'no duplicate feeds');
});

test('feed, following redirects', async () => {
  const { status, body } = await api('/api/feed', { url: siteUrl + '/moved' });
  assert.equal(status, 200);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].title, 'Climate talks reach a deal in Bonn');
});

test('feed in ISO-8859-1', async () => {
  const { body } = await api('/api/feed', { url: siteUrl + '/latin1.xml' });
  assert.equal(body.items[0].title, 'Lété à Paris');
});

test('errors are reported, not thrown', async () => {
  assert.equal((await api('/api/feed', { url: 'javascript:alert(1)' })).status, 400);
  const missing = await api('/api/feed', { url: siteUrl + '/missing.xml' });
  assert.equal(missing.status, 502);
  assert.equal(missing.body.error, 'HTTP 404');
  const notFeed = await api('/api/feed', { url: siteUrl + '/story' });
  assert.equal(notFeed.status, 502);
  assert.match(notFeed.body.error, /Not an RSS or Atom feed/);
});

test('discover feeds from a site, or a feed address itself', async () => {
  const fromSite = await api('/api/discover', { url: siteUrl + '/' });
  assert.deepEqual(fromSite.body.map(f => [f.title, f.count]), [['Example News – Top stories', 2], ['Beispiel Tech', 1]]);
  const fromFeed = await api('/api/discover', { url: siteUrl + '/atom.xml' });
  assert.equal(fromFeed.body.length, 1);
  assert.equal(fromFeed.body[0].language, 'de');
});

test('article reader view', async () => {
  const { status, body } = await api('/api/article', { url: siteUrl + '/story' });
  assert.equal(status, 200);
  assert.equal(body.site, 'Example News');
  assert.equal(body.blocks.length, 5);
  assert.ok(body.words > 50);
});

test('private network addresses are refused unless allowed', async () => {
  process.env.ALLOW_PRIVATE = '0';
  try {
    const { status, body } = await api('/api/feed', { url: siteUrl + '/atom.xml?x=1' });
    assert.equal(status, 502);
    assert.match(body.error, /private network/);
  } finally {
    process.env.ALLOW_PRIVATE = '1';
  }
});

test('static files stay inside public/', async () => {
  assert.equal((await fetch(appUrl + '/')).status, 200);
  assert.equal((await fetch(appUrl + '/flags/es-ct.png')).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(appUrl + '/..%2Fserver.js')).status, 404);
});

test('health check for the host', async () => {
  const res = await fetch(appUrl + '/health');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('a topic in several editions: one search each, every article tagged with its language', async () => {
  const { status, body } = await api('/api/search', { q: 'climate', editions: 'en-US,ca-ES,en-US,nonsense' });
  assert.equal(status, 200);
  assert.deepEqual(body.items.map(i => [i.title, i.lang]), [
    ['climate story in en-US', 'en'], ['Other story in en-US', 'en'],
    ['climate story in ca-ES', 'ca'], ['Other story in ca-ES', 'ca'],
  ]);
  assert.deepEqual(body.failed, []);
  const older = await api('/api/search', { q: 'climate', lang: 'ca', country: 'ES' });
  assert.deepEqual(older.body.items.map(i => i.lang), ['ca', 'ca'], 'lang and country still work');
});

test('search for a source by name: the outlet’s own feeds and the listed ones, checked', async () => {
  const { status, body } = await api('/api/sources', { q: 'example news', lang: 'en', country: 'US' });
  assert.equal(status, 200);
  assert.equal(body.sites.length, 1, 'the other outlet and the unrelated feed are left out');
  const [found] = body.sites;
  assert.equal(found.name, 'Example News');
  assert.equal(found.home, siteUrl);
  assert.deepEqual(found.feeds.map(f => f.url.replace(siteUrl, '')), ['/rss.xml', '/atom.xml', '/latin1.xml'],
      'from the site first, no duplicates, no comments feed');
  assert.equal(found.feeds[0].count, 2);
  assert.equal(found.feeds[0].sample, 'Climate talks reach a deal in Bonn');
  assert.equal((await api('/api/sources', { q: '' })).status, 400);
});

test('site icons: the one the home page names, checked to be an image, kept from running as a page', async () => {
  const res = await fetch(`${appUrl}/api/icon?url=${encodeURIComponent(siteUrl + '/any/page')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png', 'type from the bytes, not the label');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  const none = await fetch(`${appUrl}/api/icon?url=${encodeURIComponent('http://localhost:' + new URL(siteUrl).port + '/story')}`);
  assert.equal(none.status, 404, 'its page names no icon we can get and there is no /favicon.ico');
});

test('found feeds say which site they are on', async () => {
  const { body } = await api('/api/discover', { url: siteUrl + '/' });
  assert.deepEqual(body.map(f => f.site), ['Example News', 'Example News']);
});

test('a topic\'s article: its Google News link looked up (once), then the article read', async () => {
  const link = `${siteUrl}/rss/articles/CBMiGoodArticle_000000001?oc=5`;
  const first = await api('/api/article', { url: link });
  assert.equal(first.status, 200);
  assert.equal(first.body.url, siteUrl + '/story', 'the article\'s own address, for "Read on"');
  assert.equal(first.body.site, 'Example News');
  assert.equal(lookups.length, 1);
  await api('/api/article', { url: link });
  assert.equal(lookups.length, 1, 'remembered: Google is not asked again');
});

test('when Google News doesn\'t say where an article is, the reader is told so', async () => {
  const { status, body } = await api('/api/article', { url: `${siteUrl}/rss/articles/CBMiNoSignature_00000002` });
  assert.equal(status, 502);
  assert.match(body.error, /Google News didn’t say where this article is/);
});

test('a lookup sent elsewhere (a check for unusual traffic) counts as refused, and says where it went', async () => {
  const asked = lookups.length;
  const { status, body } = await api('/api/article', { url: `${siteUrl}/rss/articles/CBMiRedirected_0000000005` });
  assert.equal(status, 502);
  assert.match(body.error, /isn’t answering NewsFeed’s lookups just now/);
  assert.equal(lookups.length, asked + 1);
});

test('after Google refuses a lookup, lookups pause instead of insisting', async () => {
  const refused = await api('/api/article', { url: `${siteUrl}/rss/articles/CBMiRefused_000000000003` });
  assert.match(refused.body.error, /isn’t answering NewsFeed’s lookups just now/);
  const asked = lookups.length;
  const next = await api('/api/article', { url: `${siteUrl}/rss/articles/CBMiAfterPause_00000004` });
  assert.match(next.body.error, /isn’t answering NewsFeed’s lookups just now/);
  assert.equal(lookups.length, asked, 'not asked while paused');
});

test('when Google News won\'t say, the article is found on its own site by its headline', async () => {
  const site = `http://localhost:${new URL(siteUrl).port}`;
  const asked = lookups.length;
  const found = await api('/api/article', {
    url: `${siteUrl}/rss/articles/CBMiOnItsSite_00000000007`, site,
    title: 'Torredembarra s’adhereix a l’Associació per l’Impuls Metropolità',
  });
  assert.equal(found.status, 200);
  assert.equal(found.body.url, site + '/story');
  assert.equal(lookups.length, asked, 'Google is still left alone');
  // Not in its feed (some sites' feeds are years old), but linked from its home page.
  const linked = await api('/api/article', {
    url: `${siteUrl}/rss/articles/CBMiOnHomePage_0000000009`, site, title: 'The council approves the budget for next year',
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.url, site + '/story');
  const missing = await api('/api/article', { url: `${siteUrl}/rss/articles/CBMiNotOnSite_00000000008`, title: 'A headline nobody published', site });
  assert.equal(missing.status, 502);
  assert.match(missing.body.error,
      /isn’t answering NewsFeed’s lookups just now, and localhost doesn’t list it on its home page, in its feeds or in its sitemaps/);
});
