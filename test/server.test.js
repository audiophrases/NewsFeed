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
const site = http.createServer((req, res) => {
  const routes = {
    '/': ['site.html', 'text/html'], '/rss.xml': ['rss.xml', 'application/rss+xml'],
    '/atom.xml': ['atom.xml', 'application/atom+xml'], '/latin1.xml': ['latin1.xml', 'application/rss+xml'],
    '/story': ['article.html', 'text/html; charset=utf-8'],
  };
  if (req.url === '/moved') {
    res.writeHead(301, { Location: '/rss.xml' });
    return res.end();
  }
  const route = routes[req.url];
  if (!route) {
    res.writeHead(404);
    return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': route[1] });
  res.end(fs.readFileSync(path.join(FIXTURES, route[0])));
});

let siteUrl, appUrl;

test.before(async () => {
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  appUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  site.close();
  server.close();
});

const api = async (p, q) => {
  const res = await fetch(`${appUrl}${p}?${new URLSearchParams(q)}`);
  return { status: res.status, body: await res.json() };
};

test('directory', async () => {
  const { status, body } = await api('/api/directory', {});
  assert.equal(status, 200);
  assert.ok(body.sources.length > 30);
  const groups = new Set(body.groups.map(g => g.id));
  for (const s of body.sources) {
    assert.ok(groups.has(s.group), s.name);
    assert.match(s.url, /^https:\/\//);
    if (s.country) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'flags', `${s.country}.png`)), s.country);
  }
  assert.equal(new Set(body.sources.map(s => s.url)).size, body.sources.length, 'no duplicate feeds');
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
