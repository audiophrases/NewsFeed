// Publisher lookup helpers shared by the reader and the server.
'use strict';

// Publisher destinations confirmed by following individual opaque Google News links.
const confirmedPublisherLinks = new Map([
  ['CBMitgFBVV95cUxNSUhiSnNhZVY0MXFObGQyS0E5X2VNc0JQb0x0STJsazBEZHd6dnp2SFk5Sm5TUTR2TUFLUTNnNW82emdTRDVCa1l5RVF2YWNEM0tKVHRaLWhNUE94OHJnT3ZYZ1ZPUXQtbVVfRjBsLWw0VG5ma3ZJa2FnOGNMX2ZVSmRzd2p5Rkg1OC1PMFJnSTFISGZ0UXVrNVRPcTVRM3NIX3ZmOVBKOUNFQUdoUlBfVTV3R1lfZw',
    'https://www.diarilaveu.cat/societat/docents-acusen-orti-de-convertir-la-inspeccio-en-una-policia-ideologica-659514/'],
]);

// Some reported stories come with the publisher URL and feed metadata but no Google ID.
const confirmedStories = [{
  title: 'Un ferit greu i dos de lleus en incendiar-se un pis a Torredembarra (Tarragona)',
  day: '2026-11-26',
  url: 'https://www.aldia.cat/gent/noticia-ferit-greu-dos-lleus-incendiar-pis-torredembarra-tarragona-20261126182042.html',
}];

function confirmedPublisherLink(link, { title, site, publishedAt } = {}) {
  const id = /^https:\/\/news\.google\.com\/(?:rss\/)?(?:articles|read)\/([\w-]+)(?:[?#]|$)/.exec(link || '');
  if (!id) return null;
  if (confirmedPublisherLinks.has(id[1])) return confirmedPublisherLinks.get(id[1]);
  const date = new Date(Number(publishedAt));
  if (!site || !title || !Number.isFinite(date.getTime())) return null;
  const day = date.toISOString().slice(0, 10);
  const story = confirmedStories.find(s => s.day === day && foldHeadline(s.title) === foldHeadline(title)
      && publisherAddress(s.url, site));
  return story?.url || null;
}

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
  module.exports = { confirmedPublisherLink, foldHeadline, sameHeadline, publisherAddress, publisherSearchTerm };
}
