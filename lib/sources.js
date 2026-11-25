// "Search for a source": which sites someone typing a name like "El Nacional" or "Betevé" means.
// Candidates come from two places: outlets Google News names on its results (each with its
// site's address, where the server then looks for feeds) and Feedly's feed search. The server
// fetches and checks every feed before offering it; this file only matches and ranks.
'use strict';

const MAX_SITES = 6;

const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = s => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const compact = s => words(s).join('');

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return null;
  }
}

/** The same site: equal hosts, or one inside the other (news.example.com and example.com). */
function sameSite(a, b) {
  return Boolean(a && b) && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a));
}

/**
 * How well a name (and its site's address) fits what was typed: 3 exactly ("Betevé", or
 * elnacional.cat for "el nacional"), 2 has all the words, 1 contains them run together, 0 not.
 */
function matchScore(q, name, url) {
  const want = compact(q);
  if (!want) return 0;
  const host = hostOf(url) || '';
  const label = compact(host.split('.')[0]);
  if (compact(name) === want || label === want) return 3;
  const have = new Set([...words(name), ...words(host)]);
  if (words(q).every(w => have.has(w))) return 2;
  return (compact(name) + compact(host)).includes(want) ? 1 : 0;
}

/**
 * Sites worth looking at, best first, from Google News items ({ publisher, publisherUrl }) and
 * Feedly results ({ feedId: "feed/<url>", title, website, subscribers }). Each site has its home
 * page (where to look for feeds) when Google News named it, and the feed addresses Feedly knows.
 */
function candidateSites(q, newsItems = [], feedlyResults = []) {
  const sites = new Map();
  const siteFor = (host, name) => {
    if (!sites.has(host)) sites.set(host, { host, name, home: null, feedUrls: [], score: 0, articles: 0, followers: 0 });
    return sites.get(host);
  };
  for (const item of newsItems) {
    if (!item.publisher || !item.publisherUrl) continue;
    const score = matchScore(q, item.publisher, item.publisherUrl);
    const host = hostOf(item.publisherUrl);
    if (!score || !host) continue;
    const site = siteFor(host, item.publisher);
    site.name = item.publisher;
    site.home = site.home || new URL(item.publisherUrl).origin;
    site.score = Math.max(site.score, score);
    site.articles++;
  }
  for (const r of feedlyResults) {
    const feedUrl = String(r.feedId || '').replace(/^feed\//, '');
    if (!/^https?:\/\//i.test(feedUrl)) continue;
    const score = matchScore(q, r.title, r.website || feedUrl);
    const host = hostOf(r.website || feedUrl);
    if (!score || !host) continue;
    const site = siteFor(host, r.title || host);
    site.score = Math.max(site.score, score);
    site.followers += Number(r.subscribers) || 0;
    if (!site.feedUrls.includes(feedUrl)) site.feedUrls.push(feedUrl);
  }
  return [...sites.values()]
      .sort((a, b) => b.score - a.score || Boolean(b.home) - Boolean(a.home)
          || b.articles - a.articles || b.followers - a.followers)
      .slice(0, MAX_SITES);
}

/**
 * Whether a checked feed belongs to the site it was listed under: it lives there, or says it is
 * that site's feed. (Feed indexes have stale entries, e.g. a site's name on someone else's feed.)
 */
function feedBelongs(site, feed) {
  return sameSite(hostOf(feed.url), site.host) || sameSite(hostOf(feed.siteUrl), site.host);
}

/** A feed address compared without scheme, www or a trailing slash. */
const feedKey = url => (hostOf(url) || '') + (() => {
  try {
    const u = new URL(url);
    return (u.pathname.replace(/\/$/, '') + u.search).toLowerCase();
  } catch (e) {
    return url;
  }
})();

module.exports = { candidateSites, matchScore, feedBelongs, feedKey, sameSite, hostOf, MAX_SITES };
