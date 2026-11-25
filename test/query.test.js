'use strict';

// The search words used by the search box and by topics on your own sources (public/query.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseQuery, matches, score } = require('../public/query');

const article = (title, summary = '') => ({ title, summary, author: null, sourceName: 'Example', categories: [] });

test('words, exact phrases and left-out words', () => {
  assert.deepEqual(parseQuery('climate -sport "North Sea"'),
      { include: [['climate'], ['north sea']], exclude: ['sport'], terms: ['climate', 'north sea'] });
  const q = parseQuery('climate "north sea" -sport');
  assert.ok(matches(article('Climate plan for the North Sea'), q));
  assert.ok(!matches(article('Climate plan'), q), 'every group has to match');
  assert.ok(!matches(article('North Sea climate sport'), q), 'left-out words exclude');
});

test('OR joins alternatives: any one of them matches', () => {
  const q = parseQuery('housing OR vivienda OR habitatge');
  assert.deepEqual(q.include, [['housing', 'vivienda', 'habitatge']]);
  assert.ok(matches(article('La Generalitat compra 460 habitatges'), q));
  assert.ok(matches(article('Housing costs rise'), q));
  assert.ok(!matches(article('Barça wins'), q));
});

test('OR binds only its neighbours; AND and a stray OR are ignored', () => {
  assert.deepEqual(parseQuery('Barça OR Barcelona Champions').include, [['barca', 'barcelona'], ['champions']]);
  assert.deepEqual(parseQuery('OR climate AND policy').include, [['climate'], ['policy']]);
  assert.deepEqual(parseQuery('climate OR').include, [['climate']]);
  assert.deepEqual(parseQuery('-crypto OR AI').include, [['ai']], 'OR after a left-out word starts a new group');
  assert.deepEqual(parseQuery('"or" phrase').include, [['or'], ['phrase']], 'a quoted "or" is a word');
});

test('accents and case are ignored; search operators are left to the news search', () => {
  assert.ok(matches(article('El Barça guanya'), parseQuery('barca')));
  assert.deepEqual(parseQuery('site:beteve.cat when:7d').include, []);
});

test('best match counts title words more', () => {
  const q = parseQuery('clima OR climate');
  assert.ok(score(article('Cimera del clima'), q) > score(article('Other news', 'about the climate'), q));
});
