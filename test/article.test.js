'use strict';

// Reader view: how complete the extracted text is, and the page furniture it leaves out
// (lib/article.js). Each page here is modelled on a real case seen on a built-in source.
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractArticle } = require('../lib/article');
const { htmlToText } = require('../lib/feeds');

const URL = 'https://news.example.com/story';
const sentence = i => `Paragraph ${i} of the story adds one more detail that the reporter checked with two sources.`;
const paras = (n, from = 1) => Array.from({ length: n }, (_, i) => sentence(from + i));
const ld = data => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const page = (head, body) => `<!doctype html><html><head><title>Story</title>
  <meta property="og:site_name" content="Example News">${head}</head><body>${body}</body></html>`;
const text = a => a.blocks.map(b => b.text).join('\n');

test('a page that says nothing about itself: completeness unknown', () => {
  const a = extractArticle(page('', `<article>${paras(6).map(p => `<p>${p}</p>`).join('')}</article>`), URL);
  assert.equal(a.blocks.length, 6);
  assert.deepEqual(a.completeness, { status: 'unknown', expected: null, subscriber: false });
});

test('consent dialogs are removed without dropping reporting about cookies', () => {
  const story = ['Cookies will be the subject of the next privacy hearing.', ...paras(5)];
  const dialog = '<div role="dialog"><div><p>Please make your privacy choices before reading on.</p></div></div>';
  const banner = '<section id="onetrust-banner-sdk"><p>Manage vendor settings for this browser.</p></section>';
  const html = page('', '<article>' + story.map(p => '<p>' + p + '</p>').join(dialog) + banner + '</article>' +
      '<div>' + paras(12).map(p => '<p>Elsewhere in the news: ' + p + '</p>').join('') + '</div>');
  assert.deepEqual(extractArticle(html, URL).blocks.map(b => b.text), story);
  assert.equal(extractArticle(page('', dialog + banner), URL).words, 0);
});

test('word count stated and matched: full', () => {
  const html = page(ld({ '@type': 'NewsArticle', wordCount: 95 }),
      `<article>${paras(6).map(p => `<p>${p}</p>`).join('')}</article>`);
  const a = extractArticle(html, URL);
  assert.equal(a.words, 96);
  assert.deepEqual(a.completeness, { status: 'full', expected: 95, subscriber: false });
});

test('subscriber article with its length stated, only the opening served: partial', () => {
  const html = page(ld([{ '@type': 'WebSite' }, { '@type': ['NewsArticle'], wordCount: '900', isAccessibleForFree: 'False' }]),
      `<article>${paras(3).map(p => `<p>${p}</p>`).join('')}<p>Subscribe to continue reading this article.</p></article>`);
  const a = extractArticle(html, URL);
  assert.ok(!/Subscribe/.test(text(a)), 'the paywall prompt is not article text');
  assert.deepEqual(a.completeness, { status: 'partial', expected: 900, subscriber: true });
});

test('subscriber article that does not say how long it is (SPIEGEL+): partial', () => {
  const html = page(ld({ '@type': 'NewsArticle', hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false } }),
      `<article>${paras(4).map(p => `<p>${p}</p>`).join('')}</article>`);
  assert.deepEqual(extractArticle(html, URL).completeness, { status: 'partial', expected: null, subscriber: true });
  const tier = page('<meta property="article:content_tier" content="locked">', `<article><p>${sentence(1)}</p></article>`);
  assert.equal(extractArticle(tier, URL).completeness.subscriber, true, 'Open Graph content tier counts too');
});

test('the whole text is in the page data but hidden on the page (client-side paywall): full, labelled', () => {
  const all = paras(30);
  const html = page(ld({ '@type': 'NewsArticle', isAccessibleForFree: false, articleBody: all.join('\n') }),
      `<article><p>${all[0]}</p><p>${all[1]}</p><div class="paywall"><p>Subscribe to read on.</p></div></article>`);
  const a = extractArticle(html, URL);
  assert.equal(a.from, 'page-data');
  assert.equal(a.blocks.length, 30);
  assert.deepEqual(a.completeness, { status: 'full', expected: a.words, subscriber: true });
});

test('a subscriber page whose page data is only the teaser is not taken as the whole article', () => {
  const teaser = paras(3);
  const html = page(ld({ '@type': 'NewsArticle', isAccessibleForFree: false, articleBody: teaser.join(' ') }),
      `<article>${teaser.map(p => `<p>${p}</p>`).join('')}</article>`);
  assert.equal(extractArticle(html, URL).completeness.status, 'partial');
});

test('one long run of page data is cut into paragraphs', () => {
  const run = paras(40).join(' ');
  const a = extractArticle(page(ld({ '@type': 'Article', articleBody: run }), '<article><p>Short.</p></article>'), URL);
  assert.equal(a.from, 'page-data');
  assert.equal(a.blocks.length, 10, 'four sentences each');
});

test('furniture at either end is dropped: update stamps, "choose us on Google", headlines, cookies (Catalan)', () => {
  const html = page('', `<article>
    <p>Actualització: 25.11.2026 - 13:56</p>
    <p>Tria VilaWeb com la teva font informativa preferida a Google.</p>
    <p>El govern ha aprovat avui el pressupost, per&ograve; l&rsquo;oposició hi votarà en contra.</p>
    <p>La votació serà dijous al parlament, i el resultat encara és incert per als dos blocs.</p>
    <p>S’esfondra un tram del canal de la Infanta durant les obres del futur Institut Escola</p>
    <p>Uns plànols oblidats durant 100 anys reescriuen la història de la Casa Orlandai</p>
    <p>Aquest web utilitza galetes per millorar l'experiència de navegació. Si continues navegant, considerem que acceptes que n'utilitzem.</p>
  </article>`);
  const a = extractArticle(html, URL);
  assert.deepEqual(a.blocks.map(b => b.text.slice(0, 20)), ['El govern ha aprovat', 'La votació serà dijo']);
  assert.match(a.blocks[0].text, /però l’oposició/, 'Latin-1 entities decoded');
});

test('furniture the patterns don\'t know is dropped when the page data shows it isn\'t article text', () => {
  const article = paras(6);
  const html = page(ld({ '@type': 'NewsArticle', articleBody: article.join('\n') }), `<article>
    <p>Registrati gratis e ricevi ogni mattina la selezione degli articoli scelti per te.</p>
    ${article.map(p => `<p>${p}</p>`).join('')}
    <h3>I tuoi preferiti</h3>
    <p>Il servizio è dedicato agli utenti registrati: crea un archivio con tutti gli articoli.</p>
  </article>`);
  const a = extractArticle(html, URL);
  assert.equal(a.from, 'page');
  assert.deepEqual(a.blocks.map(b => b.text), article);
});

test('BBC-style endings: "Get in touch" and "Follow … on Facebook, external"', () => {
  const html = page('', `<article>${paras(3).map(p => `<p>${p}</p>`).join('')}
    <h2>Get in touch</h2><p>Follow Norfolk news on BBC Sounds, Facebook, external, Instagram, external and X, external.</p>
  </article>`);
  assert.equal(extractArticle(html, URL).blocks.length, 3);
});

test('HTML entity names for accented letters', () => {
  assert.equal(htmlToText('cidad&atilde;o, c&ograve;mplice, &Agrave; la une, na&iuml;f, &laquo;s&iacute;&raquo;'),
      'cidadão, còmplice, À la une, naïf, «sí»');
});

test('a text that is one unfinished paragraph is kept, not emptied', () => {
  const html = page('', '<article><p>Tutti questi dati hanno spinto il ministro verso la riforma del Codice della strada</p></article>');
  assert.equal(extractArticle(html, URL).blocks.length, 1);
});

test('an article written as text with line breaks instead of paragraphs (Altafulla Ràdio)', () => {
  const html = page('', `<div class="title-noticia">L’Ajuntament de Torredembarra es replantejarà el servei del bus urbà</div>
    <div class="text-noticia">L’Ajuntament de Torredembarra vol replantejar el servei del bus urbà, per fer-lo més eficient.<br />
    <br />El primer tinent d’alcalde ho ha explicat en el ple d’aquest dilluns, en resposta a una pregunta.<br />
    <br />Pino ha assenyalat que els principals usuaris del bus urbà són els nens i joves que van a l’escola.<br /></div>
    <div class="share"><a href="/">Inici</a> | <a href="/x">Contacte</a></div>`);
  const a = extractArticle(html, URL);
  assert.equal(a.blocks.length, 3);
  assert.match(a.blocks[0].text, /^L’Ajuntament de Torredembarra vol replantejar/);
});
