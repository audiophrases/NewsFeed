'use strict';

// Finding a topic's article on its own site from its headline (lib/findarticle.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const { sameHeadline, slugMatch, sitemapsInRobots, pickSitemaps, findInSitemap, siteLinks, siteSearchForm, findInLinks } = require('../lib/findarticle');

const HEADLINE = 'Torredembarra s’adhereix a l’Associació per l’Impuls Metropolità del Camp de Tarragona';

test('a publisher search uses a same-origin GET form with a query field', () => {
  const html = `<template><form role="search" action="/template"><input name="q"></form></template>
    <form action="https://elsewhere.example/search"><input type=search name=q></form>
    <form method=POST action="/search"><input type=search name=q></form>
    <form action="/newsletter"><input type=email name="email"></form>
    <form role=search action="/cerca?lang=ca"><input name="terme" type=text></form>`;
  assert.deepEqual(siteSearchForm(html, 'https://publisher.example/'), { url: 'https://publisher.example/cerca?lang=ca', name: 'terme' });
});

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

test('a home page\'s links: the article by its link\'s text, else its address, and only on that site', () => {
  // As Altafulla Ràdio's home page links its news (its feed is years out of date).
  const home = `<ul><li><a href="/">Inici</a></li>
    <li><a href="https://twitter.com/altafullaradio">Twitter</a></li>
    <li><a href="/noticia/el-temps-a-altafulla_n22390"><span>El temps</span> a Altafulla</a></li>
    <li><a class="t" href="/noticia/torredembarra-enllesteix-la-regulacio-dels-habitatges-turistics_n22398">Torredembarra enllesteix
      la regulaci&oacute; dels habitatges tur&iacute;stics</a></li>
    <li><a href="https://www.altafullaradio.cat/noticia/n22401">Altafulla aprova el pressupost</a></li></ul>`;
  const links = siteLinks(home, 'https://altafullaradio.cat/');
  assert.deepEqual(links.map(l => l.text), ['El temps a Altafulla', 'Torredembarra enllesteix la regulació dels habitatges turístics',
    'Altafulla aprova el pressupost'], 'its own pages (www or not), not other sites or the home page');
  assert.equal(findInLinks(links, 'Torredembarra enllesteix la regulació dels habitatges turístics'),
      'https://altafullaradio.cat/noticia/torredembarra-enllesteix-la-regulacio-dels-habitatges-turistics_n22398');
  assert.equal(findInLinks(links, 'Altafulla aprova el pressupost'), 'https://www.altafullaradio.cat/noticia/n22401',
      'by its text when the address is just a number');
  assert.equal(findInLinks(siteLinks(`<a href="/torredembarra-sadhereix-a-lassociacio-per-limpuls-metropolita-del-camp-de-tarragona">Llegir més</a>`,
      'https://infocamp.cat/'), HEADLINE), 'https://infocamp.cat/torredembarra-sadhereix-a-lassociacio-per-limpuls-metropolita-del-camp-de-tarragona',
      'by its address when the text says nothing');
  assert.equal(findInLinks(links, 'Una notícia que no hi és'), null);
});
