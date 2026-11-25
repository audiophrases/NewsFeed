'use strict';

// Reordering topics and sources within their own section (public/organize.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const { moveWithin } = require('../public/organize');

const list = ['feed A', 'topic 1', 'feed B', 'topic 2', 'feed C', 'topic 3'];
const isTopic = s => s.startsWith('topic');
const isFeed = s => !isTopic(s);

test('a move counts places within its section; the other section stays put', () => {
  assert.deepEqual(moveWithin(list, isFeed, 0, 2), ['feed B', 'topic 1', 'feed C', 'topic 2', 'feed A', 'topic 3']);
  assert.deepEqual(moveWithin(list, isTopic, 2, 0), ['feed A', 'topic 3', 'feed B', 'topic 1', 'feed C', 'topic 2']);
  assert.deepEqual(moveWithin(list, isTopic, 0, 1), ['feed A', 'topic 2', 'feed B', 'topic 1', 'feed C', 'topic 3'], 'one down');
});

test('moves out of range, or nowhere, change nothing (and never the list given)', () => {
  for (const [from, to] of [[0, 0], [-1, 1], [0, 3], [3, 0]]) assert.deepEqual(moveWithin(list, isFeed, from, to), list);
  const copy = list.slice();
  moveWithin(list, isFeed, 0, 2);
  assert.deepEqual(list, copy);
});
