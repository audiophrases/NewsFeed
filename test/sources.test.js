'use strict';

// Matching and ranking for "Search for a source" (lib/sources.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const { candidateSites, matchScore, feedBelongs, feedKey, sameSite } = require('../lib/sources');

test('names: exact, all the words, run together, or not at all', () => {
  assert.equal(matchScore('betevé', 'Betevé', 'https://beteve.cat'), 3);
  assert.equal(matchScore('el nacional', 'El Nacional.cat', 'https://www.elnacional.cat'), 3, 'by the site address');
  assert.equal(matchScore('guardian', 'The Guardian', 'https://www.theguardian.com'), 2);
  assert.equal(matchScore('vilaweb', 'Blocs', 'https://blocs.mesvilaweb.cat'), 1);
  assert.equal(matchScore('betevé', 'Diari ARA', 'https://www.ara.cat'), 0);
});

test('sites from Google News outlets and Feedly feeds, best first', () => {
  const news = [
    { publisher: 'Diari ARA', publisherUrl: 'https://www.ara.cat' },
    { publisher: 'El Nacional.cat', publisherUrl: 'https://www.elnacional.cat' },
    { publisher: 'El Nacional.cat', publisherUrl: 'https://www.elnacional.cat' },
    { publisher: 'El Caso', publisherUrl: 'https://elcaso.elnacional.cat' },
  ];
  const feedly = [
    { feedId: 'feed/http://www.el-nacional.com/rss/', title: 'EL NACIONAL', website: 'https://www.elnacional.com/', subscribers: 2742 },
    { feedId: 'feed/https://www.elnacional.cat/uploads/feeds/feed_ca.xml', title: 'ElNacional.cat', website: 'https://www.elnacional.cat/', subscribers: 50 },
    { feedId: 'feed/https://example.org/feed', title: 'Something else', website: 'https://example.org', subscribers: 99999 },
    { feedId: 'user/123/category/x', title: 'El Nacional', website: 'https://elnacional.example' },
  ];
  const sites = candidateSites('el nacional', news, feedly);
  assert.deepEqual(sites.map(s => s.host), ['elnacional.cat', 'elnacional.com', 'elcaso.elnacional.cat']);
  const [cat, com] = sites;
  assert.equal(cat.home, 'https://www.elnacional.cat');
  assert.equal(cat.articles, 2);
  assert.deepEqual(cat.feedUrls, ['https://www.elnacional.cat/uploads/feeds/feed_ca.xml']);
  assert.equal(com.home, null, 'Feedly only: no home page to look at');
});

test('a listed feed must belong to its site', () => {
  const site = { host: 'elnacional.cat' };
  assert.ok(feedBelongs(site, { url: 'https://www.elnacional.cat/feed.xml', siteUrl: null }));
  assert.ok(feedBelongs(site, { url: 'https://feeds.feedburner.com/elnacional', siteUrl: 'https://www.elnacional.cat/' }));
  assert.ok(!feedBelongs(site, { url: 'https://feeds.feedburner.com/ipadizate', siteUrl: 'https://www.ipadizate.com/' }));
  assert.ok(sameSite('news.example.com', 'example.com'));
  assert.ok(!sameSite('notexample.com', 'example.com'));
});

test('feed addresses compare without scheme, www or a trailing slash', () => {
  assert.equal(feedKey('http://www.vilaweb.cat/feed/'), feedKey('https://vilaweb.cat/feed'));
  assert.notEqual(feedKey('https://vilaweb.cat/feed'), feedKey('https://vilaweb.cat/rss'));
});
