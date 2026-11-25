'use strict';

// Where Google News article links lead (lib/googlenews.js): the parts that don't fetch.
const test = require('node:test');
const assert = require('node:assert/strict');

const { articleId, addressInside, signatureOf, lookupBody, addressFromLookup } = require('../lib/googlenews');

test('article ids from Google News links', () => {
  assert.equal(articleId('https://news.google.com/rss/articles/CBMivwFBVV95cUxNd2RGSU9h?oc=5'), 'CBMivwFBVV95cUxNd2RGSU9h');
  assert.equal(articleId('https://news.google.com/articles/CBMivwFBVV95cUxNd2RGSU9h'), 'CBMivwFBVV95cUxNd2RGSU9h');
  assert.equal(articleId('https://news.google.com/rss/search?q=x'), null);
  assert.equal(articleId('not a link'), null);
});

test('older ids carry the address inside; newer ones do not', () => {
  const url = 'https://www.example.cat/noticia/una-noticia-123';
  const old = Buffer.concat([Buffer.from([0x08, 0x13, 0x22, url.length]), Buffer.from(url), Buffer.from([0xd2, 0x01, 0x00])])
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(addressInside(old), url);
  assert.equal(addressInside('CBMivwFBVV95cUxNd2RGSU9hTHBhYkFUOHotVDk2dTAwQlh3a1kwNw'), null);
});

test('the signature Google\'s article page carries, and the lookup sent with it', () => {
  const html = '<c-wiz jsrenderer="x" data-n-a-sg="AZ5r3eT-sig" data-n-a-id="CBMi123" data-n-a-ts="1764081234"></c-wiz>';
  assert.deepEqual(signatureOf(html), { sig: 'AZ5r3eT-sig', ts: 1764081234 });
  assert.equal(signatureOf('<html>consent</html>'), null);
  const body = decodeURIComponent(lookupBody('CBMi123', { sig: 'AZ5r3eT-sig', ts: 1764081234 }).slice('f.req='.length));
  const [[[rpc, inner]]] = JSON.parse(body);
  assert.equal(rpc, 'Fbv4je');
  assert.deepEqual(JSON.parse(inner).slice(0, 1).concat(JSON.parse(inner).slice(2)), ['garturlreq', 'CBMi123', 1764081234, 'AZ5r3eT-sig']);
});

test('the article address from the lookup\'s answer', () => {
  const answer = ')]}\'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://altafullaradio.cat/noticia/l-ajuntament-de-torredembarra_n22397\\",1]",'
      + 'null,null,null,"generic"],["di",12],["af.httprm",12,"-123",4]]';
  assert.equal(addressFromLookup(answer), 'https://altafullaradio.cat/noticia/l-ajuntament-de-torredembarra_n22397');
  assert.equal(addressFromLookup(')]}\'\n\n[["wrb.fr","Fbv4je",null,null,null,[3],"generic"]]'), null, 'an error answer');
  assert.equal(addressFromLookup(')]}\'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://news.google.com/x\\",1]"]]'), null,
      'never Google News again');
  assert.equal(addressFromLookup('<html>Sorry</html>'), null);
});
