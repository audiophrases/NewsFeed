'use strict';

// Reordering topics and sources within their own section (public/organize.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const { moveWithin, mergeLists } = require('../public/organize');

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

// Two devices' edits of one source list (sync): items are { id, name }.
const item = (id, name = id) => ({ id, name });
const ids = list => list.map(x => x.name === x.id ? x.id : `${x.id}=${x.name}`).join(' ');
const merge = (base, mine, theirs) => ids(mergeLists(base.map(i => item(i)), mine, theirs, x => x.id));
const items = text => text.split(' ').filter(Boolean).map(t => item(...t.split('=')));

test('a device signing in: the account\'s list first, then what only this device had', () => {
  assert.equal(merge([], items('X Y'), items('A B')), 'A B X Y');
  assert.equal(merge([], items('X A'), items('A B')), 'A B X', 'one both had appears once');
  assert.equal(merge([], [], items('A B')), 'A B');
});

test('both devices added: both kept, where each was added', () => {
  assert.equal(merge(['A', 'B'], items('A C B'), items('A B D')), 'A C B D');
});

test('removed on either device: gone, even if the other changed it', () => {
  assert.equal(merge(['A', 'B', 'C'], items('A C'), items('A B C D')), 'A C D');
  assert.equal(merge(['A', 'B', 'C'], items('A B=Bee C'), items('A C')), 'A C');
});

test('renamed here: mine; renamed there only: theirs', () => {
  assert.equal(merge(['A', 'B'], items('A=Ay B'), items('A B=Bee')), 'A=Ay B=Bee');
  assert.equal(merge(['A', 'B'], items('A=Ay B'), items('A=Other B')), 'A=Ay B');
});

test('order: mine, unless only they reordered', () => {
  assert.equal(merge(['A', 'B', 'C'], items('A B C D'), items('C A B')), 'C A B D');
  assert.equal(merge(['A', 'B', 'C'], items('B A C'), items('C A B')), 'B A C', 'both reordered: mine');
});
