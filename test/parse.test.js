'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseFeed, feedLinks, looksLikeFeed } = require('../lib/feeds');
const { extractArticle } = require('../lib/article');
const { isPrivateAddress } = require('../lib/fetch');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('RSS 2.0: every item, with text, image, author, categories and dates', () => {
  const feed = parseFeed(fixture('rss.xml'), 'https://news.example.com/rss.xml');
  assert.equal(feed.title, 'Example News & Views');
  assert.equal(feed.language, 'en');
  assert.equal(feed.siteUrl, 'https://news.example.com/');
  assert.equal(feed.items.length, 2);
  const [a, b] = feed.items;
  assert.equal(a.title, 'Climate talks reach a deal in Bonn');
  assert.equal(a.link, 'https://news.example.com/climate-deal?utm_source=rss');
  assert.equal(a.id, 'a1');
  assert.equal(a.summary, 'Negotiators agreed on new targets late on Friday.');
  assert.equal(a.image, 'https://img.example.com/a.jpg');
  assert.equal(a.author, 'Jane Doe');
  assert.deepEqual(a.categories, ['Environment', 'World']);
  assert.equal(a.publishedAt, Date.parse('2026-11-23T10:00:00Z'));
  assert.equal(b.summary, 'A dramatic finish – again.');
  assert.equal(b.image, 'https://img.example.com/derby.jpg');
  assert.equal(b.publishedAt, Date.parse('2026-11-24T07:30:00Z'));
});

test('Atom: alternate link resolved, audio enclosure ignored, HTML title flattened', () => {
  const feed = parseFeed(fixture('atom.xml'), 'https://tech.example.de/atom.xml');
  assert.equal(feed.title, 'Beispiel Tech');
  assert.equal(feed.language, 'de');
  assert.equal(feed.siteUrl, 'https://tech.example.de/');
  const [e] = feed.items;
  assert.equal(e.title, 'Neue Chips schneller');
  assert.equal(e.link, 'https://tech.example.de/artikel/chips');
  assert.equal(e.author, 'Max Muster');
  assert.deepEqual(e.categories, ['Hardware']);
  assert.equal(e.summary, 'Der neue Prozessor ist doppelt so schnell.');
  assert.ok(e.hasContent);
  assert.equal(e.publishedAt, Date.parse('2026-11-24T09:00:00Z'));
});

test('Google News: publisher split from the title, repeated description dropped', () => {
  const feed = parseFeed(fixture('google.xml'), 'https://news.google.com/rss/search?q=climate');
  const [a, b] = feed.items;
  assert.equal(a.title, 'Climate talks reach a deal in Bonn');
  assert.equal(a.publisher, 'Example News');
  assert.equal(a.summary, '');
  assert.equal(b.publisher, 'Science Weekly');
});

test('not a feed', () => {
  assert.throws(() => parseFeed('<html><body>hi</body></html>', 'https://x.example/'), /Not an RSS or Atom feed/);
  assert.ok(looksLikeFeed(fixture('rss.xml')));
  assert.ok(looksLikeFeed(fixture('atom.xml')));
  assert.ok(!looksLikeFeed(fixture('site.html')));
});

test('feed discovery from a web page', () => {
  assert.deepEqual(feedLinks(fixture('site.html'), 'https://news.example.com/'), [
    { url: 'https://news.example.com/rss.xml', title: 'Example News – Top stories' },
    { url: 'https://news.example.com/atom.xml', title: null },
  ]);
});

test('article extraction keeps the story, drops navigation, scripts and boilerplate', () => {
  const a = extractArticle(fixture('article.html'), 'https://news.example.com/climate-deal');
  assert.equal(a.title, 'Climate talks reach a deal in Bonn');
  assert.equal(a.site, 'Example News');
  assert.equal(a.author, 'Jane Doe');
  assert.equal(a.image, 'https://news.example.com/img/hero.jpg');
  assert.equal(a.publishedAt, Date.parse('2026-11-23T10:00:00Z'));
  assert.deepEqual(a.blocks.map(b => b.type), ['p', 'h', 'p', 'quote', 'p']);
  assert.match(a.blocks[0].text, /^Negotiators from almost 200 countries/);
  assert.equal(a.blocks[4].text, 'Campaigners said it did not go far enough & called for faster action on coal.');
  const all = a.blocks.map(b => b.text).join(' ');
  assert.ok(!/newsletter|Copyright|not text|Delegates applaud|Advertisement/.test(all));
});

test('private addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2a00:1450::1']) assert.ok(!isPrivateAddress(ip), ip);
});
