'use strict';

// Finding a topic's article on its own site from its headline (lib/findarticle.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const { sameHeadline, slugMatch, sitemapsInRobots, pickSitemaps, findInSitemap } = require('../lib/findarticle');

const HEADLINE = 'Torredembarra s’adhereix a l’Associació per l’Impuls Metropolità del Camp de Tarragona';

test('the same headline, punctuation, accents and case aside', () => {
  assert.ok(sameHeadline(HEADLINE, "Torredembarra s'adhereix a l'Associació per l'Impuls Metropolità del Camp de Tarragona"));
  assert.ok(sameHeadline(HEADLINE, HEADLINE + ' | Infocamp'), 'a long one with a few words more');
  assert.ok(!sameHeadline('Torredembarra', 'Torredembarra reclama tolerància zero'), 'short ones must be equal');
  assert.ok(!sameHeadline(HEADLINE, 'Altafulla aprova el pressupost'));
});

test('an address\'s slug against a headline', () => {
  assert.ok(slugMatch('https://infocamp.cat/torredembarra-sadhereix-a-lassociacio-per-limpuls-metropolita-del-camp-de-tarragona/', HEADLINE) >= 0.7);
  assert.ok(slugMatch('https://infocamp.cat/altafulla-aprova-el-pressupost/', HEADLINE) < 0.2);
  assert.equal(slugMatch('not an address', HEADLINE), 0);
});

test('sitemaps: from robots.txt, news ones and the newest from an index, an article by headline or slug', () => {
  assert.deepEqual(sitemapsInRobots('User-agent: *\nDisallow: /wp-admin/\nSitemap: https://infocamp.cat/sitemap_index.xml\n'),
      ['https://infocamp.cat/sitemap_index.xml']);
  const index = `<sitemapindex>
    <sitemap><loc>https://x.cat/post-sitemap1.xml</loc><lastmod>2024-01-01T00:00:00Z</lastmod></sitemap>
    <sitemap><loc>https://x.cat/post-sitemap9.xml</loc><lastmod>2026-11-25T10:00:00Z</lastmod></sitemap>
    <sitemap><loc><![CDATA[https://x.cat/news-sitemap.xml]]></loc></sitemap>
    <sitemap><loc>https://x.cat/page-sitemap.xml</loc><lastmod>2025-01-01T00:00:00Z</lastmod></sitemap></sitemapindex>`;
  assert.deepEqual(pickSitemaps(index, 2), ['https://x.cat/news-sitemap.xml', 'https://x.cat/post-sitemap9.xml']);
  const news = `<urlset><url><loc>https://x.cat/n/123</loc><news:news><news:title>${HEADLINE}</news:title></news:news></url></urlset>`;
  assert.equal(findInSitemap(news, HEADLINE), 'https://x.cat/n/123', 'by its news:title');
  const slugs = `<urlset><url><loc>https://x.cat/altafulla-aprova-el-pressupost/</loc></url>
    <url><loc>https://x.cat/torredembarra-sadhereix-a-lassociacio-per-limpuls-metropolita-del-camp-de-tarragona/</loc></url></urlset>`;
  assert.equal(findInSitemap(slugs, HEADLINE), 'https://x.cat/torredembarra-sadhereix-a-lassociacio-per-limpuls-metropolita-del-camp-de-tarragona/');
  assert.equal(findInSitemap(slugs, 'Una notícia que no hi és'), null);
});
