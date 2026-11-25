// Reordering what you follow. Topics and sources live in one list but are shown (and reordered)
// in their own sections, so a move counts places within its section only. The page loads this as
// a plain script; the tests load it as a module.
'use strict';

/**
 * The list with the item at `from` moved to `to`, both counted among the items for which
 * `inSection` is true; every other item keeps its place. Out-of-range moves change nothing.
 */
function moveWithin(list, inSection, from, to) {
  const section = list.filter(inSection);
  if (from === to || from < 0 || to < 0 || from >= section.length || to >= section.length) return list.slice();
  const [item] = section.splice(from, 1);
  section.splice(to, 0, item);
  let next = 0;
  return list.map(x => (inSection(x) ? section[next++] : x));
}

if (typeof module === 'object' && module.exports) module.exports = { moveWithin };
