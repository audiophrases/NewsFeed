// Reordering what you follow, and putting together the lists two devices edited. Topics and
// sources live in one list but are shown (and reordered) in their own sections, so a move counts
// places within its section only. The page loads this as a plain script; the tests load it as a
// module.
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

/**
 * One list from two devices' edits of it: base is what both had, mine and theirs what each made
 * of it since; items are matched by id(). Added on either side: kept, before the item that came
 * after it there (last if none). Removed on either side: gone. Changed here (renamed, settings):
 * mine, otherwise theirs. Order: mine, unless they reordered and I didn't. With nothing in common
 * yet (a device signing in), theirs and then what only I had.
 */
function mergeLists(base, mine, theirs, id) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const theirItems = new Map(theirs.map(x => [id(x), x]));
  if (!base.length) return [...theirs, ...mine.filter(x => !theirItems.has(id(x)))];
  const inBase = new Map(base.map(x => [id(x), x]));
  const myItems = new Map(mine.map(x => [id(x), x]));
  const reordered = list => {
    const now = list.map(id).filter(k => inBase.has(k));
    return !same(now, base.map(id).filter(k => now.includes(k)));
  };
  const [lead, other] = reordered(theirs) && !reordered(mine) ? [theirs, mine] : [mine, theirs];
  const kept = k => !inBase.has(k) || (myItems.has(k) && theirItems.has(k));

  const out = lead.map(id).filter(kept);
  other.map(id).forEach((k, i) => {
    if (!kept(k) || out.includes(k)) return;
    const after = other.slice(i + 1).map(id).find(n => out.includes(n));
    out.splice(after === undefined ? out.length : out.indexOf(after), 0, k);
  });
  return out.map(k => (myItems.has(k) && inBase.has(k) && !same(myItems.get(k), inBase.get(k))
    ? myItems.get(k) : theirItems.get(k) || myItems.get(k)));
}

if (typeof module === 'object' && module.exports) module.exports = { moveWithin, mergeLists };
