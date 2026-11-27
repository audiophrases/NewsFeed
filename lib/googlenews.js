// Google News article links (news.google.com/rss/articles/CBMi…) don't name the article's own
// address: in a browser, Google's article page asks Google where the link leads and then goes
// there. NewsFeed's server asks the same question, so a topic's articles can be read in the app.
// It is Google's own page's lookup, not a published API: the server asks only when someone opens
// an article, one at a time, remembers every answer, and stops asking for a while if Google
// refuses (see server.js). These are the parts that don't fetch anything.
'use strict';

/** The article id of a Google News article link, or null. */
function articleId(link) {
  try {
    const m = /^\/(?:rss\/)?(?:articles|read)\/([\w-]{20,})$/.exec(new URL(link).pathname);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/** Older ids carry the address inside them (base64); newer ones are opaque. */
function addressInside(id) {
  let raw;
  try {
    // atob works on the server (Node 16+) and in the NewsFeed app; it wants the padding back.
    const base64 = id.replace(/-/g, '+').replace(/_/g, '/');
    raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  } catch (e) {
    return null;
  }
  // The id is a small protobuf: the address runs until the next byte that isn't printable text.
  const m = /https?:\/\/[\x21-\x7e]+/.exec(raw);
  return m && isArticleAddress(m[0]) ? m[0] : null;
}

/** The signature and timestamp Google's article page carries for the lookup. */
function signatureOf(html) {
  const sig = /data-n-a-sg="([^"]+)"/.exec(html);
  const ts = /data-n-a-ts="(\d+)"/.exec(html);
  return sig && ts ? { sig: sig[1], ts: Number(ts[1]) } : null;
}

/** The form body of the lookup, as Google's page sends it. */
function lookupBody(id, { sig, ts }) {
  const request = ['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
    'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, ts, sig];
  return 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', JSON.stringify(request), null, 'generic']]]));
}

/** The article's address from the lookup's answer (")]}'" then JSON), or null. */
function addressFromLookup(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  const tries = [text.slice(start), ...text.slice(start).split('\n')];
  for (const t of tries) {
    let data;
    try {
      data = JSON.parse(t);
    } catch (e) {
      continue;
    }
    for (const entry of Array.isArray(data) ? data : []) {
      if (!Array.isArray(entry) || entry[1] !== 'Fbv4je' || typeof entry[2] !== 'string') continue;
      try {
        const [kind, url] = JSON.parse(entry[2]);
        if (kind === 'garturlres' && isArticleAddress(url)) return url;
      } catch (e) {
        // not this one
      }
    }
  }
  return null;
}

/** A web address that isn't Google News again. */
function isArticleAddress(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== 'news.google.com';
  } catch (e) {
    return false;
  }
}

module.exports = { articleId, addressInside, signatureOf, lookupBody, addressFromLookup };
