// Publisher lookup helpers shared by the reader and the server.
'use strict';

const foldHeadline = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The same headline, punctuation, accents and case aside (a long one may have a few words more). */
function sameHeadline(a, b) {
  const x = foldHeadline(a), y = foldHeadline(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) > 30 && (x.includes(y) || y.includes(x)));
}

/** A possible article on this publisher, including WordPress's numeric post URLs. */
function publisherAddress(link, site) {
  try {
    const u = new URL(link);
    const host = new URL(site).host.replace(/^www\./, '');
    if (/^https?:$/.test(u.protocol) && !u.username && !u.password && u.host.replace(/^www\./, '') === host &&
        (u.pathname !== '/' || u.searchParams.has('p'))) return u.href;
  } catch {
    // The publisher or candidate URL is missing or malformed.
  }
  return null;
}

// An acronym is often enough to find a headline with edited wording or punctuation.
function publisherSearchTerm(title) {
  const words = title.match(/[\p{L}\p{N}]+/gu) || [];
  const acronym = words.find(w => /^\p{Lu}{3,}$/u.test(w));
  return acronym || words.filter(w => w.length >= 4).slice(0, 4).join(' ') || title;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { foldHeadline, sameHeadline, publisherAddress, publisherSearchTerm };
}
