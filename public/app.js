// NewsFeed: reads the sources and topics you follow, merged into one list you can search,
// filter and sort, with a reader for each article. Everything you set up is kept in this
// browser; the server (server.js) fetches the feeds, news searches and article pages.
// Storage, DOM helpers, the toast and the add dialog follow Play the News' web app.
'use strict';

const PAGE = 80;
const CONCURRENCY = 6;
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const READ_LIMIT = 6000;
const KEY_SOURCES = 'newsfeed.sources';
const KEY_READ = 'newsfeed.read';
const KEY_SAVED = 'newsfeed.saved';
const KEY_PREFS = 'newsfeed.prefs';

/** Google News editions for topics: language-COUNTRY. */
const EDITIONS = [
  ['en-US', 'English · United States'], ['en-GB', 'English · United Kingdom'], ['en-IE', 'English · Ireland'],
  ['en-CA', 'English · Canada'], ['en-AU', 'English · Australia'], ['en-IN', 'English · India'],
  ['de-DE', 'Deutsch · Deutschland'], ['de-AT', 'Deutsch · Österreich'], ['de-CH', 'Deutsch · Schweiz'],
  ['fr-FR', 'Français · France'], ['fr-CA', 'Français · Canada'], ['fr-CH', 'Français · Suisse'],
  ['es-ES', 'Español · España'], ['es-MX', 'Español · México'], ['es-US', 'Español · Estados Unidos'],
  ['ca-ES', 'Català · Espanya'],
  ['it-IT', 'Italiano · Italia'], ['pt-PT', 'Português · Portugal'], ['pt-BR', 'Português · Brasil'],
  ['nl-NL', 'Nederlands · Nederland'], ['nl-BE', 'Nederlands · België'],
];

const $ = id => document.getElementById(id);

let directory = { groups: [], sources: [] };
/** Followed feeds and topics, in the user's order. */
let sources = [];
/** By source id: { items, title, error, at }. */
const loaded = new Map();
/** Every article from every source, deduplicated. */
let articles = [];
const byKey = new Map();
let readKeys = new Set();
/** Saved articles by key, kept whole so they outlive the feeds. */
let saved = new Map();
let prefs = { view: 'all', sort: 'newest', since: 0, unreadOnly: false, langs: [], fullText: true };
let shown = PAGE;
let visible = [];
let selectedKey = null;
/** A news search that isn't followed (yet): the "Search all news" view. */
let webSearch = null;
let refreshing = false;
let lastRefresh = 0;
const fullTexts = new Map();

// ---- storage (may be unavailable, e.g. in private windows) ------------------------------

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Not saved; it still works for this visit.
  }
}

const saveSources = () => store(KEY_SOURCES, sources);
const saveRead = () => store(KEY_READ, [...readKeys].slice(-READ_LIMIT));
const saveSaved = () => store(KEY_SAVED, [...saved.values()]);
const savePrefs = () => store(KEY_PREFS, prefs);

// ---- sources -----------------------------------------------------------------------------

/** Most editions one topic searches; each is one more news search on every refresh. */
const MAX_EDITIONS = 5;

/** A topic's editions, its main one first. (Topics from before there were several have one.) */
const topicEditions = s => (Array.isArray(s.editions) && s.editions.length ? s.editions : [`${s.lang}-${s.country}`]);

/** Editions as given, keeping only known shapes and no repeats, at most MAX_EDITIONS. */
const cleanEditions = list => [...new Set((Array.isArray(list) ? list : []).filter(e => /^[a-z]{2}-[A-Z]{2}$/.test(e)))]
    .slice(0, MAX_EDITIONS);

// A one-edition topic keeps the id it had before topics could have more, with its read marks.
const sid = s => (s.kind === 'topic' ? `topic|${topicEditions(s).join('+')}|${s.q.toLowerCase()}`
  : s.kind === 'news' ? `news|${s.edition}|${s.site}` : 'rss|' + s.url);
const sourceById = id => sources.find(s => sid(s) === id) || (webSearch && sid(webSearch) === id ? webSearch : null);

function apiUrl(s) {
  if (s.kind === 'topic') {
    return `/api/search?q=${encodeURIComponent(s.q)}&editions=${topicEditions(s).join(',')}`;
  }
  if (s.kind === 'news') return `/api/search?q=${encodeURIComponent('site:' + s.site)}&editions=${s.edition}`;
  return `/api/feed?url=${encodeURIComponent(s.url)}`;
}

/**
 * A source as stored, from the directory, a search, an import or older storage; null if unusable.
 * Three kinds: rss (a feed), topic (a news search), news (a site's or section's headlines via
 * Google News, for sites that don't let NewsFeed read their feed; listed with the sources).
 */
function sourceEntry(s) {
  if (!s) return null;
  if (s.kind === 'topic') return s.q ? topicEntry(s) : null;
  if (s.kind === 'news') {
    const site = String(s.site || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
    if (!/^[\w-]+(\.[\w-]+)+(\/[\w\-./]*)?$/.test(site)) return null;
    const edition = cleanEditions([s.edition])[0] || defaultEdition();
    return { kind: 'news', site, edition, name: s.name || site, lang: s.lang || edition.split('-')[0], country: s.country || null };
  }
  if (!/^https?:\/\//i.test(s.url || '')) return null;
  return { kind: 'rss', url: s.url, name: s.name || hostOf(s.url), lang: s.lang || null, country: s.country || null };
}

/** A page of the source's site, for its icon: a feed's site once loaded, else the feed's address. */
const sourceLink = s => (s.kind === 'news' ? 'https://' + s.site : loaded.get(sid(s))?.siteUrl || s.url);

/** What the add dialogs say under a source's name. */
const sourceDetail = s => (s.kind === 'news' ? `${s.site} · headlines via Google News` : hostOf(s.url));

/** A topic as it is stored: its main edition in lang and country, all of them in editions. */
function topicEntry(s) {
  const editions = cleanEditions(s.editions).length ? cleanEditions(s.editions)
      : [`${s.lang || 'en'}-${s.country || 'US'}`];
  const [lang, country] = editions[0].split('-');
  return { kind: 'topic', q: s.q, lang, country, editions, name: s.name || s.q };
}

async function getJson(url) {
  const res = await fetch(url);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function fetchSource(s) {
  const id = sid(s);
  try {
    const feed = await getJson(apiUrl(s));
    loaded.set(id, { items: feed.items, title: feed.title, language: feed.language, siteUrl: feed.siteUrl, error: null, at: Date.now() });
  } catch (e) {
    const old = loaded.get(id);
    loaded.set(id, { items: old ? old.items : [], language: old && old.language, error: e.message, at: Date.now() });
  }
}

/** Fetches sources a few at a time, redrawing as each one arrives. */
async function refresh(list = sources) {
  if (!list.length) return;
  const all = list === sources;
  if (all) {
    if (refreshing) return;
    refreshing = true;
    $('refresh').classList.add('spinning');
  }
  let done = 0;
  const queue = list.slice();
  const progress = () => {
    if (all) setProgress(done < list.length ? `Updating ${done} of ${list.length} sources…` : '');
  };
  progress();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      await fetchSource(queue.shift());
      done++;
      progress();
      scheduleRebuild();
    }
  }));
  if (all) {
    refreshing = false;
    lastRefresh = Date.now();
    $('refresh').classList.remove('spinning');
    const failed = list.filter(s => loaded.get(sid(s))?.error);
    if (failed.length) toast(`${failed.length} of ${list.length} sources could not be updated`);
  }
  rebuild();
}

function setProgress(text) {
  $('progress').textContent = text;
  $('progress').hidden = !text;
}

// ---- articles ----------------------------------------------------------------------------

/** Bing wraps links in a click counter; the article's own address is its url parameter. */
function realLink(link) {
  try {
    const u = new URL(link);
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.searchParams.get('url')) return u.searchParams.get('url');
  } catch (e) {
    // keep as is
  }
  return link;
}

/** The same story linked from two places: compare without tracking parameters, scheme or www. */
function linkKey(link) {
  try {
    const u = new URL(link);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ocid|cmpid|at_|ns_|xtor|rss|ref$|src$)/i.test(p)) u.searchParams.delete(p);
    }
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') + u.search).toLowerCase();
  } catch (e) {
    return null;
  }
}

const titleKey = t => fold(t).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

let rebuildTimer = null;

function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuild();
  }, 150);
}

/** Merges every source's items: feeds first, so a story they carry isn't shown again from a topic. */
function rebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = null;
  articles = [];
  byKey.clear();
  const byTitle = new Map();
  const ordered = [...sources.filter(s => s.kind !== 'topic'), ...sources.filter(s => s.kind === 'topic')];
  for (const s of ordered) {
    const id = sid(s);
    const got = loaded.get(id);
    if (!got) continue;
    for (const item of got.items) {
      // Google News lists a site's topic pages too ("China", "Women's football"): not articles.
      if (s.kind === 'news' && item.title.split(/\s+/).length < 3) continue;
      const link = item.link ? realLink(item.link) : null;
      const key = (link && linkKey(link)) || `${id}|${item.id}`;
      const tk = titleKey(item.title);
      const twin = byKey.get(key) || (tk.length > 24 ? byTitle.get(tk) : null);
      if (twin) {
        if (!twin.sids.includes(id)) twin.sids.push(id);
        continue;
      }
      const a = {
        key, sid: id, sids: [id], title: item.title, link, summary: item.summary, image: item.image,
        author: item.author, categories: item.categories || [], publishedAt: item.publishedAt || 0,
        sourceName: item.publisher || s.name, country: s.kind === 'news' || !item.publisher ? s.country : null,
        site: item.publisherUrl || got.siteUrl || s.url || null,
        lang: item.lang || s.lang || got.language || null,
      };
      articles.push(a);
      byKey.set(key, a);
      if (tk.length > 24) byTitle.set(tk, a);
      // A saved copy picks up a newer image or summary.
      if (saved.has(key)) saved.set(key, { ...a, savedAt: saved.get(key).savedAt });
    }
  }
  render();
}

/** Articles of the web-search view: one search, nothing merged. */
function webArticles() {
  const got = webSearch && loaded.get(sid(webSearch));
  if (!got) return [];
  return got.items.map(item => {
    const link = item.link ? realLink(item.link) : null;
    const key = (link && linkKey(link)) || 'web|' + item.id;
    return byKey.get(key) || {
      key, sid: sid(webSearch), sids: [sid(webSearch)], title: item.title, link, summary: item.summary,
      image: item.image, author: item.author, categories: item.categories || [], publishedAt: item.publishedAt || 0,
      sourceName: item.publisher || webSearch.name, country: null, lang: item.lang || webSearch.lang,
      site: item.publisherUrl || null,
    };
  });
}

const articleByKey = key => byKey.get(key) || saved.get(key) || webArticles().find(a => a.key === key) || null;

// ---- search and filters ------------------------------------------------------------------

// parseQuery, matches and score (search words, with OR) are in query.js.

/** Articles of the current view, before the language, time, unread and search filters. */
function viewArticles() {
  const [kind, id] = splitView(prefs.view);
  if (kind === 'saved') return [...saved.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  if (kind === 'web') return webArticles();
  if (kind === 'source') return articles.filter(a => a.sids.includes(id));
  if (kind === 'topic') {
    const topic = sourceById(id);
    const query = topic ? parseQuery(topic.q) : null;
    return articles.filter(a => a.sids.includes(id) || (query && query.include.length && matches(a, query)));
  }
  if (kind === 'unread') return articles.filter(a => !readKeys.has(a.key));
  return articles;
}

function splitView(view) {
  const i = view.indexOf(':');
  return i < 0 ? [view, null] : [view.slice(0, i), view.slice(i + 1)];
}

function applyFilters(list) {
  const kind = splitView(prefs.view)[0];
  const query = kind === 'web' ? parseQuery('') : parseQuery($('q').value);
  const since = prefs.since ? Date.now() - prefs.since * 3600 * 1000 : 0;
  const langs = new Set(prefs.langs);
  let out = list.filter(a => (!since || a.publishedAt >= since)
      && (!prefs.unreadOnly || kind === 'unread' || !readKeys.has(a.key) || a.key === selectedKey)
      && (!langs.size || langs.has(a.lang || '?'))
      && matches(a, query));
  const sort = prefs.sort === 'relevance' && !query.include.length ? 'newest' : prefs.sort;
  if (kind === 'saved' && sort === 'newest' && prefs.sort === 'newest') return out; // by when saved
  const newest = (a, b) => b.publishedAt - a.publishedAt;
  if (sort === 'newest') out.sort(newest);
  else if (sort === 'oldest') out.sort((a, b) => (a.publishedAt || Infinity) - (b.publishedAt || Infinity));
  else if (sort === 'source') out.sort((a, b) => a.sourceName.localeCompare(b.sourceName) || newest(a, b));
  else if (sort === 'relevance') {
    const scores = new Map(out.map(a => [a, score(a, query)]));
    out.sort((a, b) => scores.get(b) - scores.get(a) || newest(a, b));
  }
  return out;
}

// ---- rendering ---------------------------------------------------------------------------

function render() {
  renderSidebar();
  renderList();
  renderReaderState();
}

function viewTitle() {
  const [kind, id] = splitView(prefs.view);
  if (kind === 'unread') return 'Unread';
  if (kind === 'saved') return 'Saved';
  if (kind === 'web') return webSearch ? `News about “${webSearch.q}”` : 'News search';
  if (kind === 'source' || kind === 'topic') return sourceById(id)?.name || 'All articles';
  return 'All articles';
}

function renderSidebar() {
  const unread = articles.filter(a => !readKeys.has(a.key));
  const views = [
    ['all', 'All articles', 'i-text', articles.length ? String(unread.length) : ''],
    ['unread', 'Unread', 'i-dot', ''],
    ['saved', 'Saved', 'i-star', saved.size ? String(saved.size) : ''],
  ];
  if (webSearch) views.push(['web', `“${webSearch.q}”`, 'i-search', '']);
  $('views').replaceChildren(...views.map(([view, name, icon, badge]) => navItem(view, name, icon, badge)));

  const topics = sources.filter(s => s.kind === 'topic');
  const feeds = sources.filter(s => s.kind !== 'topic');
  $('topics').replaceChildren(...(topics.length ? topics.map(s => sourceItem(s, 'topic')) : [hintItem('Follow topics you care about to get news about them from every outlet.')]));
  $('sources').replaceChildren(...(feeds.length ? feeds.map(s => sourceItem(s, 'source')) : [hintItem('No sources yet.')]));
}

function navItem(view, name, icon, badge) {
  const li = el('li', prefs.view === view ? 'active' : '');
  const glyph = el('span', 'glyph');
  glyph.append(svgIcon(icon));
  li.append(glyph, el('span', 'name', name), el('span', 'badge', badge));
  li.tabIndex = 0;
  li.addEventListener('click', () => setView(view));
  li.addEventListener('keydown', e => { if (e.key === 'Enter') setView(view); });
  return li;
}

function sourceItem(s, kind) {
  const id = sid(s);
  const view = `${kind}:${id}`;
  const li = navItem(view, s.name, kind === 'topic' ? 'i-search' : 'i-text', '');
  if (kind === 'source') li.firstChild.replaceWith(mark(s.country, sourceLink(s)));
  const got = loaded.get(id);
  const badge = li.querySelector('.badge');
  if (got && got.error && !got.items.length) {
    badge.className = 'error';
    badge.textContent = '!';
    li.title = `Could not update: ${got.error}`;
  } else if (got) {
    const list = kind === 'topic' ? viewArticlesFor(view) : articles.filter(a => a.sids.includes(id));
    const n = list.filter(a => !readKeys.has(a.key)).length;
    badge.textContent = n ? String(n) : '';
    li.title = kind === 'topic' ? `${s.q} · ${topicEditions(s).join(', ')}`
      : s.kind === 'news' ? `Headlines via Google News · site:${s.site} · ${s.edition}` : s.url;
  }
  const remove = iconButton('i-close', `Stop following ${s.name}`, () => unfollow(s));
  remove.classList.add('remove');
  li.append(remove);
  return li;
}

function viewArticlesFor(view) {
  const was = prefs.view;
  prefs.view = view;
  try {
    return viewArticles();
  } finally {
    prefs.view = was;
  }
}

const hintItem = text => el('li', 'hint', text);

function renderList() {
  $('view-title').textContent = viewTitle();
  document.title = `${viewTitle()} · NewsFeed`;
  const base = viewArticles();
  renderLanguages(base);
  visible = applyFilters(base);
  const unreadN = visible.filter(a => !readKeys.has(a.key)).length;
  $('view-count').textContent = visible.length
      ? `${visible.length} ${visible.length === 1 ? 'article' : 'articles'}${unreadN && unreadN !== visible.length ? ` · ${unreadN} unread` : ''}`
      : '';
  $('sort').value = prefs.sort;
  $('since').value = String(prefs.since);
  $('unread-only').setAttribute('aria-checked', String(prefs.unreadOnly));
  renderWebSearchBar();

  const query = parseQuery(splitView(prefs.view)[0] === 'web' ? '' : $('q').value);
  $('articles').replaceChildren(...visible.slice(0, shown).map(a => articleRow(a, query)));
  $('more').hidden = visible.length <= shown;
  $('more').textContent = `Show more (${visible.length - shown})`;
  renderEmpty(base);
}

function renderLanguages(base) {
  const counts = new Map();
  for (const a of base) counts.set(a.lang || '?', (counts.get(a.lang || '?') || 0) + 1);
  // Keep chips that are switched on even when this view has none, so they can be switched off.
  for (const l of prefs.langs) if (!counts.has(l)) counts.set(l, 0);
  if (counts.size < 2) {
    $('lang-filter').replaceChildren();
    return;
  }
  $('lang-filter').replaceChildren(...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => {
    const on = prefs.langs.includes(code);
    const b = el('button', 'chip small', `${languageName(code)} ${n}`);
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => {
      prefs.langs = on ? prefs.langs.filter(l => l !== code) : [...prefs.langs, code];
      savePrefs();
      shown = PAGE;
      renderList();
    });
    return b;
  }));
}

function languageName(code) {
  if (!code || code === '?') return 'Other';
  try {
    const name = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch (e) {
    // not a language code
  }
  return code;
}

function renderWebSearchBar() {
  const bar = $('web-search');
  const q = $('q').value.trim();
  const kind = splitView(prefs.view)[0];
  if (kind === 'web' && webSearch) {
    const following = sources.some(s => sid(s) === sid(webSearch));
    bar.replaceChildren(el('span', '', following ? 'You follow this topic.' : 'Results from a news search across all outlets.'));
    if (!following) bar.append(button('primary-text', 'Follow this topic', () => follow(webSearch)));
    bar.hidden = false;
  } else if (q && kind !== 'saved' && parseQuery(q).include.length) {
    bar.replaceChildren(el('span', '', `Looking beyond your sources?`),
        button('primary-text', `Search all news for “${q}”`, () => runWebSearch(q)));
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
}

function button(kind, text, onClick) {
  const b = el('button', kind === 'primary-text' ? 'text-button' : kind, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function articleRow(a, query) {
  const li = el('li', [readKeys.has(a.key) ? '' : 'unread', a.key === selectedKey ? 'selected' : ''].join(' ').trim());
  li.dataset.key = a.key;
  const body = el('div', 'body');
  const meta = el('div', 'meta');
  if (a.country || a.site) meta.append(mark(a.country, a.site));
  meta.append(el('span', 'src', a.sourceName));
  if (a.publishedAt) meta.append(el('span', '', '· ' + age(a.publishedAt)));
  if (saved.has(a.key)) {
    const star = svgIcon('i-star');
    star.classList.add('star');
    meta.append(star);
  }
  const title = el('h3', 'title');
  title.append(...highlight(a.title, query));
  body.append(meta, title);
  if (a.summary) {
    const summary = el('p', 'summary');
    summary.append(...highlight(a.summary.split('\n')[0], query));
    body.append(summary);
  }
  li.append(body);
  if (a.image) {
    const img = el('img', 'thumb');
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.src = a.image;
    img.addEventListener('error', () => img.remove());
    li.append(img);
  }
  li.addEventListener('click', () => select(a.key));
  return li;
}

/** Text with the search terms wrapped in <mark>, as DOM nodes. */
function highlight(text, query) {
  if (!query.include.length) return [text];
  const folded = fold(text);
  // Folding keeps lengths for Latin text; if it didn't, don't risk marking the wrong letters.
  if (folded.length !== text.length) return [text];
  const ranges = [];
  for (const t of query.terms) {
    for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) ranges.push([i, i + t.length]);
  }
  if (!ranges.length) return [text];
  ranges.sort((x, y) => x[0] - y[0]);
  const out = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s < at) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(el('mark', '', text.slice(s, e)));
    at = e;
  }
  out.push(text.slice(at));
  return out;
}

function renderEmpty(base) {
  const empty = $('empty');
  empty.replaceChildren();
  if (visible.length) {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
  const kind = splitView(prefs.view)[0];
  if (!sources.length && kind !== 'saved' && kind !== 'web') {
    empty.append(el('h2', '', 'Welcome to NewsFeed'),
        el('p', '', 'Follow news sources and topics you care about. Everything they publish shows up here, to search, filter, sort and read.'),
        button('primary', 'Add sources', () => openAdd()),
        button('primary subtle', 'Follow a topic', () => openAdd('topic')));
  } else if (kind === 'saved' && !saved.size) {
    empty.append(el('p', '', 'Nothing saved yet. Press the star on an article (or s) to keep it here.'));
  } else if (refreshing || (kind === 'web' && !loaded.get(sid(webSearch)))) {
    empty.append(el('p', '', 'Loading…'));
  } else if (base.length) {
    empty.append(el('p', '', 'No articles match these filters.'), button('primary subtle', 'Clear filters', clearFilters));
  } else {
    const id = splitView(prefs.view)[1];
    const got = kind === 'web' || kind === 'source' || kind === 'topic' ? loaded.get(id || sid(webSearch)) : null;
    const s = kind === 'source' ? sourceById(id) : null;
    if (got && got.error && s && s.kind === 'rss' && /HTTP 40[13]/.test(got.error)) {
      empty.append(el('p', '', `${s.name} doesn’t let NewsFeed read its feed (${got.error}). `
          + 'Its headlines can still come through Google News, with a link to each article on the site.'),
      button('primary subtle', 'Get its headlines via Google News', () => replaceWithNews(s)));
    } else if (got && got.error && /HTTP 4(04|10)/.test(got.error)) {
      empty.append(el('p', '', `The feed is no longer at this address (${got.error}). Search for the source again to find its new feed.`));
    } else {
      empty.append(el('p', '', got && got.error ? `Could not load: ${got.error}` : kind === 'unread' ? 'All caught up.' : 'No articles yet.'));
    }
  }
}

function clearFilters() {
  $('q').value = '';
  prefs.since = 0;
  prefs.unreadOnly = false;
  prefs.langs = [];
  savePrefs();
  shown = PAGE;
  renderList();
}

// ---- views -------------------------------------------------------------------------------

function setView(view) {
  prefs.view = view;
  savePrefs();
  shown = PAGE;
  closeDrawer();
  $('list-pane').scrollTop = 0;
  render();
}

async function runWebSearch(q) {
  const [lang, country] = defaultEdition().split('-');
  webSearch = { kind: 'topic', q, lang, country, name: q };
  $('q').value = '';
  setView('web');
  await fetchSource(webSearch);
  render();
}

// ---- reader ------------------------------------------------------------------------------

const narrow = () => matchMedia('(max-width: 860px)').matches;

function select(key, { scroll = false } = {}) {
  const a = articleByKey(key);
  if (!a) return;
  selectedKey = key;
  if (!readKeys.has(key)) {
    readKeys.add(key);
    saveRead();
  }
  for (const li of $('articles').children) {
    li.classList.toggle('selected', li.dataset.key === key);
    if (li.dataset.key === key) li.classList.remove('unread');
  }
  if (scroll) $('articles').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  renderReader(a);
  renderSidebar();
  if (narrow() && !document.body.classList.contains('reading')) {
    document.body.classList.add('reading');
    history.pushState({ reading: true }, '');
  }
}

function closeReader() {
  if (!document.body.classList.contains('reading')) return;
  document.body.classList.remove('reading');
  if (history.state && history.state.reading) history.back();
  renderList();
}

function renderReaderState() {
  const a = selectedKey && articleByKey(selectedKey);
  if (!a) return;
  $('toggle-read').classList.toggle('on', !readKeys.has(a.key));
  $('toggle-read').setAttribute('aria-label', readKeys.has(a.key) ? 'Mark unread' : 'Mark read');
  $('save-icon').setAttribute('href', saved.has(a.key) ? '#i-star' : '#i-star-o');
  $('toggle-save').classList.toggle('on', saved.has(a.key));
  $('toggle-save').setAttribute('aria-label', saved.has(a.key) ? 'Remove from saved' : 'Save');
}

function renderReader(a) {
  $('reader').classList.add('has-article');
  $('open-original').href = a.link || '#';
  $('open-original').hidden = !a.link;
  renderReaderState();
  const body = $('reader-body');
  body.scrollTop = 0;
  const meta = el('div', 'r-meta');
  if (a.country || a.site) meta.append(mark(a.country, a.site));
  meta.append(el('strong', '', a.sourceName));
  if (a.author && a.author !== a.sourceName) meta.append(el('span', '', a.author));
  if (a.publishedAt) {
    const time = el('time', '', new Date(a.publishedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
    time.dateTime = new Date(a.publishedAt).toISOString();
    time.title = age(a.publishedAt);
    meta.append(time);
  }
  const status = el('p', 'r-status');
  status.id = 'reader-status';
  const parts = [meta, el('h2', '', a.title), status];
  if (a.image) parts.push(heroImage(a.image));
  const text = el('div', 'text');
  text.id = 'reader-text';
  for (const para of (a.summary || '').split(/\n+/).filter(Boolean)) text.append(el('p', '', para));
  parts.push(text);
  if (a.categories.length) {
    const tags = el('div', 'tags');
    tags.append(...a.categories.map(c => button('chip small', c, () => { $('q').value = c; closeReader(); onQuery(); })));
    parts.push(tags);
  }
  const note = el('div', 'note');
  note.id = 'reader-note';
  parts.push(note);
  body.replaceChildren(...parts);
  if (fullTexts.has(a.key)) showFullText(a, fullTexts.get(a.key));
  else if (refusals.has(a.key)) {
    setStatus('summary', shownSoFar(a), refusals.get(a.key));
    readerActions(a, '', undefined, false);
  } else if (prefs.fullText && a.link && canFetch(a.link)) loadFullText(a);
  else if (a.link && !canFetch(a.link)) {
    setStatus('summary', shownSoFar(a), `found through Google News, whose links NewsFeed can’t follow to the article. `
        + `Read it on ${a.sourceName}.`);
    readerActions(a);
  } else {
    setStatus('summary', shownSoFar(a), 'From the feed.');
    readerActions(a);
  }
}

/** What the reader shows before (or instead of) the full text. */
const shownSoFar = a => (a.summary ? 'Summary only' : 'Headline only');

/**
 * The line under the headline saying how much of the article this is. kind: "full" (all of it,
 * checked), "partial" (part of it, checked), "unknown" (can't be checked), "summary", "loading".
 */
function setStatus(kind, label, detail, subscriber = false) {
  const status = $('reader-status');
  if (!status) return;
  status.className = `r-status ${kind}`;
  const mark = { full: '✓ ', partial: '⚠ ' }[kind] || '';
  status.replaceChildren(el('strong', '', mark + label));
  if (subscriber) status.append(' ', el('span', 'r-tag', 'Subscriber article'));
  if (detail) status.append(' · ', detail);
}

/** A fetch error, said the way a reader would want to hear it. */
function explainFailure(message, site) {
  if (/HTTP 402/.test(message)) return `${site} only shows its articles to subscribers.`;
  if (/HTTP 40[13]/.test(message)) return `${site} doesn’t let NewsFeed read its pages.`;
  if (/HTTP 4(04|10)/.test(message)) return 'The article is no longer on the site.';
  if (/HTTP 429/.test(message)) return `${site} is limiting requests just now; try again later.`;
  if (/Timed out/.test(message)) return `${site} took too long to answer.`;
  if (/Not a web page/.test(message)) return 'The link doesn’t lead to a web page.';
  return `The article couldn’t be loaded (${message}).`;
}

function heroImage(src) {
  const img = el('img', 'hero');
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  img.src = src;
  img.addEventListener('error', () => img.remove());
  return img;
}

/** Google News links only lead to the article through a script page. */
const canFetch = link => !/^https:\/\/news\.google\.com\//.test(link);

/** Articles whose site refused for good (subscribers only, blocked, gone), by key: the reason. */
const refusals = new Map();

function readerActions(a, message, openText, canRetry = true) {
  const note = $('reader-note');
  if (!note) return;
  note.replaceChildren();
  if (message) note.append(el('p', '', message));
  const actions = el('div', 'actions');
  if (a.link) {
    // A Google News link's own address says news.google.com; name the outlet instead.
    const where = canFetch(a.link) ? hostOf(a.link) || 'the site' : a.sourceName;
    const open = el('a', 'primary', openText || 'Read on ' + where);
    open.href = a.link;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    actions.append(open);
  }
  if (canRetry && a.link && canFetch(a.link) && !fullTexts.has(a.key)) {
    actions.append(button('primary subtle', 'Load full text', () => loadFullText(a)));
  }
  note.append(actions);
}

const hostOf = link => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

async function loadFullText(a) {
  if (!a.link || !canFetch(a.link)) return;
  const note = $('reader-note');
  if (note) note.replaceChildren();
  setStatus('loading', 'Loading the full article…');
  let result;
  try {
    result = await getJson(`/api/article?url=${encodeURIComponent(a.link)}`);
  } catch (e) {
    if (selectedKey === a.key) {
      const why = explainFailure(e.message, a.sourceName);
      // Asking again won't change a subscribers-only, blocked or deleted page; a timeout might pass.
      const final = /HTTP (40[1-4]|410)/.test(e.message);
      if (final) refusals.set(a.key, why);
      setStatus('summary', shownSoFar(a), why);
      readerActions(a, '', undefined, !final);
    }
    return;
  }
  fullTexts.set(a.key, result);
  if (selectedKey === a.key) showFullText(a, result);
}

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function showFullText(a, result) {
  const text = $('reader-text');
  const site = result.site || a.sourceName;
  const { status, expected, subscriber } = result.completeness || { status: 'unknown' };
  // Only replace the feed's summary with something longer.
  const summaryLength = (a.summary || '').length;
  const fullLength = result.blocks.reduce((n, b) => n + b.text.length, 0);
  if (!text || fullLength < Math.max(300, summaryLength * 1.2)) {
    setStatus('summary', shownSoFar(a), subscriber
      ? `the page has no more of this subscriber article for NewsFeed`
      : `${site} didn’t share more than this`, subscriber);
    readerActions(a);
    return;
  }
  const out = [];
  let list = null;
  for (const b of result.blocks) {
    if (b.type === 'li') {
      if (!list) out.push(list = el('ul'));
      list.append(el('li', '', b.text));
      continue;
    }
    list = null;
    out.push(el(b.type === 'h' ? 'h3' : b.type === 'quote' ? 'blockquote' : 'p', '', b.text));
  }
  text.replaceChildren(...out);
  if (!a.image && result.image) text.before(heroImage(result.image));
  const minutes = `${Math.max(1, Math.round(result.words / 230))} min read`;
  if (status === 'full') {
    setStatus('full', 'Full article', `as long as ${site} says it is (${plural(expected, 'word', 'words')}) · ${minutes}`, subscriber);
    readerActions(a);
  } else if (status === 'partial') {
    setStatus('partial', 'Only part of the article', expected
      ? `${plural(result.words, 'word', 'words')} of the ${expected.toLocaleString()} ${site} says it has`
      : `usually only the opening of a subscriber article can be read here (${plural(result.words, 'word', 'words')})`,
    subscriber);
    readerActions(a, 'The rest is on the site.', `Read the rest on ${hostOf(a.link) || site}`);
  } else {
    setStatus('unknown', 'Text from the page', `${minutes} · ${site} doesn’t say how long the article is, so it can’t be checked for completeness`);
    readerActions(a);
  }
}

function toggleRead() {
  if (!selectedKey) return;
  if (readKeys.has(selectedKey)) readKeys.delete(selectedKey);
  else readKeys.add(selectedKey);
  saveRead();
  render();
}

function toggleSave(key = selectedKey) {
  const a = key && articleByKey(key);
  if (!a) return;
  if (saved.has(key)) {
    saved.delete(key);
    toast('Removed from saved');
  } else {
    saved.set(key, { ...a, savedAt: Date.now() });
    toast('Saved');
  }
  saveSaved();
  render();
}

function markAllRead() {
  const list = visible.filter(a => !readKeys.has(a.key));
  if (!list.length) return toast('Nothing unread here');
  for (const a of list) readKeys.add(a.key);
  saveRead();
  render();
  toast(`Marked ${list.length} as read`);
}

function step(delta) {
  if (!visible.length) return;
  const i = visible.findIndex(a => a.key === selectedKey);
  const next = i < 0 ? 0 : Math.min(Math.max(0, i + delta), visible.length - 1);
  if (next >= shown) {
    shown = next + PAGE;
    renderList();
  }
  select(visible[next].key, { scroll: true });
}

// ---- following and unfollowing -----------------------------------------------------------

async function follow(s, { quiet = false, fetchNow = true } = {}) {
  if (sources.some(x => sid(x) === sid(s))) {
    if (!quiet) toast(`You already follow ${s.name}`);
    return false;
  }
  const entry = sourceEntry(s);
  if (!entry) return false;
  sources.push(entry);
  saveSources();
  if (webSearch && sid(webSearch) === sid(entry)) {
    webSearch = null;
    prefs.view = 'topic:' + sid(entry);
    savePrefs();
  }
  render();
  if (!quiet) toast(`Following ${entry.name}`);
  if (!fetchNow) return entry;
  if (!loaded.has(sid(entry))) await refresh([entry]);
  else rebuild();
  return entry;
}

function unfollow(s) {
  if (!confirm(`Stop following ${s.name}?`)) return;
  const id = sid(s);
  sources = sources.filter(x => sid(x) !== id);
  saveSources();
  loaded.delete(id);
  if (prefs.view.endsWith(':' + id)) prefs.view = 'all';
  savePrefs();
  rebuild();
}

// ---- adding sources and topics (the dialog flow of Play the News) ------------------------

let addMode = null;
let addCandidates = [];

function openAdd(mode) {
  if (mode === 'topic') showTopicForm();
  else showGroups();
  if (!$('add-dialog').open) $('add-dialog').showModal();
  closeDrawer();
}

function setStep(title, confirmText, back) {
  $('add-title').textContent = title;
  $('add-confirm').hidden = !confirmText;
  $('add-confirm').disabled = false;
  $('add-confirm').textContent = confirmText || '';
  $('add-back').hidden = !back;
}

function showGroups(q = '') {
  addMode = null;
  setStep('Add sources', null, false);
  const have = new Set(sources.map(sid));
  $('add-body').replaceChildren(
      sourceSearchForm(typeof q === 'string' ? q : ''),
      choice('Follow a topic…', 'News about anything, from every outlet', showTopicForm),
      choice('Website or feed address…', 'Any site with an RSS or Atom feed', showAddressForm),
      ...directory.groups.map(g => {
        const all = directory.sources.filter(s => s.group === g.id);
        const added = all.filter(s => have.has(sid({ kind: 'rss', ...s }))).length;
        return choice(g.name, all.map(s => s.name).slice(0, 3).join(', ') + (all.length > 3 ? '…' : ''),
            () => showGroup(g), `${added ? added + ' of ' : ''}${all.length}`);
      }));
}

function showGroup(g) {
  const have = new Set(sources.map(sid));
  addCandidates = directory.sources.filter(s => s.group === g.id).map(s => ({ kind: 'rss', ...s }));
  addMode = 'group';
  setStep(g.name, 'Add', true);
  $('add-body').replaceChildren(...addCandidates.map((s, i) => {
    const row = el('label', 'choice');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.index = i;
    const following = have.has(sid(s));
    box.checked = following;
    box.disabled = following;
    const name = el('span', 'name', s.name);
    name.append(el('span', 'detail', following ? 'Following' : sourceDetail(s)));
    row.append(box, mark(s.country, sourceLink(s)), name);
    return row;
  }));
}

function defaultEdition() {
  const nav = navigator.language || 'en-US';
  const exact = EDITIONS.find(([code]) => code.toLowerCase() === nav.toLowerCase());
  if (exact) return exact[0];
  const lang = nav.split('-')[0].toLowerCase();
  return (EDITIONS.find(([code]) => code.startsWith(lang + '-')) || EDITIONS[0])[0];
}

/** The languages editions come in, by their own names: [['en', 'English'], ['de', 'Deutsch'], …]. */
const EDITION_LANGS = [...new Map(EDITIONS.map(([code, name]) => [code.split('-')[0], name.split(' · ')[0]]))];

/** The edition for a language, in the given country if it has one there (es → es-MX for MX). */
function editionFor(lang, country) {
  const codes = EDITIONS.map(([code]) => code);
  return codes.find(c => c === `${lang}-${country}`) || codes.find(c => c.startsWith(lang + '-'));
}

/** Languages a topic being set up also searches in, besides its main edition's. */
let topicAlso = new Set();

const TOPIC_HELP = 'Headlines about this from outlets everywhere, via Google News. Use quotes for exact '
    + 'phrases, - to leave words out and OR between alternatives. Press Enter to preview.';

function showTopicForm(q = '') {
  addMode = 'topic';
  topicAlso = new Set();
  setStep('Follow a topic', 'Follow', true);
  const form = el('div', 'form');
  const input = dialogInput('text', 'topic-q', 'e.g. climate, "champions league", AI -crypto', previewTopic);
  input.value = typeof q === 'string' ? q : '';
  const edition = document.createElement('select');
  edition.id = 'topic-edition';
  edition.setAttribute('aria-label', 'News edition');
  for (const [code, name] of EDITIONS) edition.append(new Option(name, code));
  edition.value = defaultEdition();
  edition.addEventListener('change', () => {
    topicAlso.delete(edition.value.split('-')[0]);
    renderTopicLanguages();
    clearTopicPreview();
  });
  const alsoHead = el('p', 'help', 'Also search in:');
  const also = el('div', 'chips');
  also.id = 'topic-also';
  const alsoHelp = el('p', 'help small', 'Names work as they are in every language. For other words, add '
      + 'the translations with OR, e.g. housing OR vivienda OR habitatge.');
  const help = el('p', 'help', TOPIC_HELP);
  help.id = 'topic-help';
  const preview = el('ul', 'preview');
  preview.id = 'topic-preview';
  form.append(input, edition, alsoHead, also, alsoHelp, help);
  $('add-body').replaceChildren(form, preview);
  renderTopicLanguages();
  input.focus();
}

/** One switch per language other than the main edition's. */
function renderTopicLanguages() {
  const main = $('topic-edition').value.split('-')[0];
  $('topic-also').replaceChildren(...EDITION_LANGS.filter(([lang]) => lang !== main).map(([lang, name]) => {
    const on = topicAlso.has(lang);
    const b = el('button', 'chip small', name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => {
      if (on) topicAlso.delete(lang);
      else if (topicAlso.size + 1 >= MAX_EDITIONS) return toast(`Up to ${MAX_EDITIONS} languages per topic`);
      else topicAlso.add(lang);
      renderTopicLanguages();
      clearTopicPreview();
    });
    return b;
  }));
}

function clearTopicPreview() {
  previewRequest++;
  $('topic-help').textContent = TOPIC_HELP;
  $('topic-preview').replaceChildren();
}

let previewRequest = 0;

function topicFromForm() {
  const q = $('topic-q').value.trim();
  if (!q) return null;
  const main = $('topic-edition').value;
  const country = main.split('-')[1];
  const editions = [main, ...[...topicAlso].map(lang => editionFor(lang, country)).filter(Boolean)];
  return topicEntry({ q, editions });
}

async function previewTopic() {
  const t = topicFromForm();
  if (!t) return;
  const request = ++previewRequest;
  $('topic-help').textContent = 'Searching…';
  $('topic-q').blur();
  try {
    const feed = await getJson(apiUrl(t));
    if (request !== previewRequest || addMode !== 'topic') return;
    loaded.set(sid(t), { items: feed.items, language: feed.language, error: null, at: Date.now() });
    const perLang = new Map();
    for (const item of feed.items) perLang.set(item.lang, (perLang.get(item.lang) || 0) + 1);
    const split = perLang.size > 1 ? ` (${[...perLang].map(([l, n]) => `${languageName(l)} ${n}`).join(' · ')})` : '';
    const failed = (feed.failed || []).map(f => `${languageName(f.edition.split('-')[0])} failed: ${f.error}.`).join(' ');
    $('topic-help').textContent = (feed.items.length ? `${feed.items.length} recent articles${split}, for example:`
        : 'No news found for this right now.') + (failed ? ' ' + failed : '');
    $('topic-preview').replaceChildren(...previewSample(feed.items, 6).map(item => {
      const li = el('li', '', item.title);
      li.append(el('div', 'detail', [item.publisher, perLang.size > 1 ? languageName(item.lang) : '',
        item.publishedAt ? age(item.publishedAt) : ''].filter(Boolean).join(' · ')));
      return li;
    }));
  } catch (e) {
    if (request === previewRequest) $('topic-help').textContent = `Search failed: ${e.message}`;
  }
}

/** A few articles for the preview, taking turns between languages so each one shows. */
function previewSample(items, n) {
  const byLang = new Map();
  for (const item of items) {
    if (!byLang.has(item.lang)) byLang.set(item.lang, []);
    byLang.get(item.lang).push(item);
  }
  const out = [];
  for (let i = 0; out.length < n && out.length < items.length; i++) {
    for (const list of byLang.values()) if (list[i] && out.length < n) out.push(list[i]);
  }
  return out;
}

// ---- searching for a source by name --------------------------------------------------------

/** The search box at the top of "Add sources". */
function sourceSearchForm(q) {
  const form = el('div', 'form');
  const input = dialogInput('search', 'source-q', 'Search for a source, e.g. El Nacional, Betevé', searchSources);
  input.value = q;
  input.setAttribute('aria-label', 'Search for a source');
  const help = el('p', 'help', 'A news outlet’s name, or a site or feed address. Press Enter to search.');
  help.id = 'source-help';
  form.append(input, help);
  // On a phone the keyboard would cover the list before you chose to type.
  if (!narrow()) setTimeout(() => input.focus());
  return form;
}

/** "elnacional.cat", "https://…": an address to look at rather than a name to search for. */
const looksLikeAddress = q => /^https?:\/\//i.test(q) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q);

/** Whether a name or address fits the words typed (accents and case aside). */
function nameMatches(q, ...texts) {
  const words = fold(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const text = fold(texts.join(' '));
  return words.length > 0 && words.every(w => text.includes(w));
}

let sourceQuery = '';

async function searchSources() {
  const q = $('source-q').value.trim();
  if (!q) return;
  if (looksLikeAddress(q)) {
    showAddressForm(q);
    return discoverFeeds();
  }
  sourceQuery = q;
  addMode = 'search';
  setStep('Add sources', 'Add', true);
  const results = el('div');
  results.id = 'source-results';
  $('add-body').replaceChildren(sourceSearchForm(q), results);
  $('source-q').blur();
  const builtIn = directory.sources.filter(s => nameMatches(q, s.name, s.url ? hostOf(s.url) : s.site)).map(s => ({ kind: 'rss', ...s }));
  renderSourceResults(builtIn, null);
  const [lang, country] = defaultEdition().split('-');
  let found;
  try {
    found = await getJson(`/api/sources?q=${encodeURIComponent(q)}&lang=${lang}&country=${country}`);
  } catch (e) {
    if (addMode === 'search' && sourceQuery === q) $('source-help').textContent = `Search failed: ${e.message}`;
    return;
  }
  if (addMode !== 'search' || sourceQuery !== q) return;
  renderSourceResults(builtIn, found.sites);
}

/** Sites in the languages this browser asks for first, then the rest as they came. */
function byPreferredLanguage(sites) {
  const prefs = (navigator.languages || [navigator.language || 'en']).map(l => l.split('-')[0].toLowerCase());
  const rank = site => {
    const ranks = site.feeds.map(f => prefs.indexOf(f.language)).filter(i => i >= 0);
    return ranks.length ? Math.min(...ranks) : prefs.length;
  };
  return sites.map((site, i) => ({ site, i, r: rank(site) })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.site);
}

/** Built-in matches, then each site found with its feeds, as boxes to tick. sites null: still searching. */
function renderSourceResults(builtIn, sites) {
  const have = new Set(sources.map(sid));
  addCandidates = [];
  const rows = [];
  const row = (s, detail) => {
    const label = el('label', 'choice');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.index = addCandidates.length;
    addCandidates.push(s);
    const following = have.has(sid(s));
    box.checked = following;
    box.disabled = following;
    const name = el('span', 'name', s.name);
    name.append(el('span', 'detail', following ? 'Following' : detail));
    label.append(box, mark(s.country, sourceLink(s)), name);
    return label;
  };
  if (builtIn.length) {
    rows.push(el('div', 'group-head', 'Built in'));
    for (const s of builtIn) rows.push(row(s, sourceDetail(s)));
  }
  for (const site of byPreferredLanguage(sites || [])) {
    const head = el('div', 'group-head', site.name);
    head.append(el('span', 'detail', site.host));
    rows.push(head);
    if (!site.feeds.length) {
      const note = el('p', 'help indent', site.error
        ? `This site doesn’t let NewsFeed read its feeds (${site.error}). `
        : 'No RSS feed found on this site. ');
      note.append(button('primary-text', 'Follow its headlines via Google News', () => followSiteHeadlines(site)));
      rows.push(note);
    }
    for (const f of site.feeds) {
      const s = { kind: 'rss', url: f.url, name: sourceTitle(site.name, f.title), lang: f.language, country: guessCountry(f.url, f.language) };
      const detail = [`${f.count} articles`, f.language ? languageName(f.language) : '', f.sample ? `“${f.sample}”` : hostOf(f.url)];
      rows.push(row(s, detail.filter(Boolean).join(' · ')));
    }
  }
  $('source-results').replaceChildren(...rows);
  const fresh = [...$('source-results').querySelectorAll('input:not(:disabled)')];
  if (fresh.length === 1 && sites) fresh[0].checked = true;
  const feeds = (sites || []).reduce((n, site) => n + site.feeds.length, 0);
  $('source-help').textContent = !sites ? 'Searching the web for sources…'
    : !builtIn.length && !sites.length ? 'Nothing found by that name. Try another spelling, or paste the site’s address.'
    : builtIn.length + feeds ? 'Tick the ones you want, then press Add.'
    : 'No feeds found for that name.';
}

/** A site without a feed we can read, followed through Google News instead (its site:… headlines). */
async function followSiteHeadlines(site) {
  const entry = sourceEntry({ kind: 'news', site: site.host, edition: defaultEdition(), name: site.name });
  $('add-dialog').close();
  if (await follow(entry)) setView('source:' + sid(entry));
}

/**
 * A feed that refuses NewsFeed, swapped in place for its site's headlines via Google News (same
 * name and flag, the edition of its language and country).
 */
async function replaceWithNews(s) {
  const edition = editionFor(s.lang || 'en', (s.country || '').slice(0, 2).toUpperCase()) || defaultEdition();
  const host = hostOf(s.url).replace(/^(feeds?|rss)\./, '');
  // A section's feed (…/football/rss) becomes that section's headlines, if Google News has them
  // under that path; otherwise the whole site's.
  const path = new URL(s.url).pathname.split('/').filter(p => p && !/^(rss|feeds?|atom|index)$|\.(xml|rss)$/i.test(p));
  const sites = [path.length && path.length <= 2 ? `${host}/${path.join('/')}` : null, host].filter(Boolean);
  toast(`Looking for ${s.name}’s headlines…`);
  for (const site of sites) {
    const entry = sourceEntry({ kind: 'news', site, edition, name: s.name, lang: s.lang, country: s.country });
    let feed;
    try {
      feed = entry && await getJson(apiUrl(entry));
    } catch (e) {
      continue;
    }
    if (!feed || feed.items.length < 3) continue;
    const i = sources.indexOf(s);
    if (i < 0) return;
    loaded.delete(sid(s));
    loaded.set(sid(entry), { items: feed.items, title: feed.title, language: feed.language, error: null, at: Date.now() });
    if (sources.some(x => sid(x) === sid(entry))) sources.splice(i, 1);
    else sources[i] = entry;
    saveSources();
    prefs.view = 'source:' + sid(entry);
    savePrefs();
    rebuild();
    toast(`${s.name} now comes through Google News`);
    return;
  }
  toast(`Google News has no recent headlines from ${host}`);
}

function showAddressForm(url = '') {
  addMode = 'address';
  setStep('Website or feed', 'Find feeds', true);
  const form = el('div', 'form');
  const input = dialogInput('url', 'address', 'https://example.com or a feed address', discoverFeeds);
  input.value = typeof url === 'string' ? url : '';
  const help = el('p', 'help', 'Paste a news site’s address, or the address of its RSS or Atom feed.');
  help.id = 'address-help';
  form.append(input, help);
  const results = el('div');
  results.id = 'address-results';
  $('add-body').replaceChildren(form, results);
  input.focus();
}

async function discoverFeeds() {
  let url = $('address').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  $('address-help').textContent = 'Looking for feeds…';
  $('add-confirm').disabled = true;
  let found;
  try {
    found = await getJson(`/api/discover?url=${encodeURIComponent(url)}`);
  } catch (e) {
    $('address-help').textContent = `Couldn’t read that address: ${e.message}`;
    $('add-confirm').disabled = false;
    return;
  }
  if (addMode !== 'address') return;
  $('add-confirm').disabled = false;
  if (!found.length) {
    $('address-help').textContent = 'No feed found there. Try the site’s home page, or look for an RSS link on it.';
    return;
  }
  const have = new Set(sources.map(sid));
  addCandidates = found.map(f => ({
    kind: 'rss', url: f.url, name: sourceTitle(f.site, f.title) || hostOf(f.url), lang: f.language, country: guessCountry(f.url, f.language),
  }));
  addMode = 'found';
  setStep('Feeds found', 'Add', true);
  $('address-help').textContent = found.length === 1 ? 'Found this feed:' : `Found ${found.length} feeds. Pick the ones you want:`;
  $('address-results').replaceChildren(...addCandidates.map((s, i) => {
    const row = el('label', 'choice');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.index = i;
    const following = have.has(sid(s));
    box.checked = following || found.length === 1;
    box.disabled = following;
    const name = el('span', 'name', s.name);
    name.append(el('span', 'detail', `${following ? 'Following · ' : ''}${found[i].count} articles · ${s.url}`));
    row.append(box, name);
    return row;
  }));
}

/**
 * A feed's name in the sidebar: its own title, with its site's name in front when the title doesn't
 * say which site it is ("Europe" from The Economist becomes "The Economist – Europe").
 */
function sourceTitle(site, title) {
  const clean = (title || '').replace(/\s*[»|:–-]\s*(rss|feed|atom)( feed)?$/i, '').trim();
  if (!clean) return site || '';
  if (!site) return clean;
  const core = s => fold(s).replace(/^the\s+/, '').replace(/\.[a-z]{2,3}(\.[a-z]{2})?$/, '').replace(/[^\p{L}\p{N}]/gu, '');
  const t = core(clean), n = core(site);
  // "ElNacional.cat" names El Nacional.cat; "News" doesn't name BBC News.
  const named = !n || t.includes(n) || (t.length >= n.length * 0.6 && n.includes(t));
  return named ? clean : `${site} – ${clean}`;
}

/** A flag for a feed outside the directory, from its country domain (as Play the News does). */
function guessCountry(url, lang) {
  const tld = hostOf(url).split('.').pop();
  const flags = ['at', 'au', 'be', 'ca', 'ch', 'de', 'es', 'fr', 'gb', 'ie', 'in', 'it', 'mx', 'nl', 'nz', 'pt', 'qa', 'us'];
  if (tld === 'cat' || lang === 'ca') return 'es-ct';
  if (tld === 'uk') return 'gb';
  return flags.includes(tld) ? tld : null;
}

async function confirmAdd() {
  if (addMode === 'group' || addMode === 'found' || addMode === 'search') {
    const picked = [...$('add-body').querySelectorAll('input:checked:not(:disabled)')]
        .map(box => addCandidates[Number(box.dataset.index)]);
    if (!picked.length) return toast('Pick at least one source');
    $('add-dialog').close();
    const added = [];
    for (const s of picked) {
      const entry = await follow(s, { quiet: true, fetchNow: false });
      if (entry) added.push(entry);
    }
    toast(`Added ${added.length} ${added.length === 1 ? 'source' : 'sources'}`);
    await refresh(added);
  } else if (addMode === 'topic') {
    const t = topicFromForm();
    if (!t) return $('topic-q').focus();
    $('add-dialog').close();
    if (await follow(t)) setView('topic:' + sid(t));
  } else if (addMode === 'address') {
    await discoverFeeds();
  }
}

/** A text input that acts on Enter itself: the form's own Enter would press Close. */
function dialogInput(type, id, placeholder, onEnter) {
  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    }
  });
  return input;
}

function choice(text, detail, onClick, count) {
  const b = el('button', 'choice');
  b.type = 'button';
  const name = el('span', 'name', text);
  if (detail) name.append(el('span', 'detail', detail));
  b.append(name);
  if (count) b.append(el('span', 'count', count));
  b.addEventListener('click', onClick);
  return b;
}

$('add-dialog').querySelector('form').addEventListener('submit', e => {
  if (e.submitter && e.submitter.value === 'ok') {
    e.preventDefault();
    confirmAdd();
  }
});

$('add-back').addEventListener('click', () => {
  if (addMode === 'found') showAddressForm();
  else showGroups(addMode === 'search' ? sourceQuery : '');
});

// ---- export and import -------------------------------------------------------------------

function exportSources() {
  const data = JSON.stringify({ app: 'NewsFeed', version: 1, sources, saved: [...saved.values()] }, null, 2);
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `newsfeed-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** NewsFeed's own export, or OPML from another feed reader. */
async function importFile(file) {
  const text = await file.text();
  let list = [], savedList = [];
  if (/^\s*[{[]/.test(text)) {
    const data = JSON.parse(text);
    list = (Array.isArray(data) ? data : data.sources || []).filter(Boolean);
    savedList = Array.isArray(data.saved) ? data.saved.filter(a => a && a.key && a.title) : [];
  } else {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    list = [...doc.querySelectorAll('outline[xmlUrl]')].map(o => ({
      kind: 'rss', url: o.getAttribute('xmlUrl'), name: o.getAttribute('title') || o.getAttribute('text') || hostOf(o.getAttribute('xmlUrl')),
    })).filter(s => /^https?:\/\//.test(s.url));
  }
  let added = 0;
  const fresh = [];
  for (const s of list) {
    const entry = sourceEntry(s.kind === 'topic' || s.kind === 'news' ? s : { ...s, country: s.country || guessCountry(s.url || '') });
    if (!entry || sources.some(x => sid(x) === sid(entry))) continue;
    sources.push(entry);
    fresh.push(entry);
    added++;
  }
  for (const a of savedList) if (!saved.has(a.key)) saved.set(a.key, a);
  saveSources();
  saveSaved();
  toast(`Imported ${added} ${added === 1 ? 'source' : 'sources'}${savedList.length ? ` and ${savedList.length} saved` : ''}`);
  render();
  refresh(fresh);
}

// ---- small DOM helpers (as in Play the News) ---------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/** A source's flag when its country is known, else its site's own icon (link: any page of the site). */
function mark(country, link) {
  return country ? flag(country) : siteIcon(link);
}

/**
 * The icon a site shows in browser tabs, found and kept by the server (so no icon service learns
 * which sites you follow); a blank if it has none.
 */
function siteIcon(link) {
  let origin;
  try {
    origin = new URL(link).origin;
  } catch (e) {
    return flag(null);
  }
  const img = el('img', 'flag icon');
  img.src = `/api/icon?url=${encodeURIComponent(origin)}`;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => img.replaceWith(flag(null)));
  return img;
}

/** A 20×15 flag, or a blank of the same size so names stay in one column. */
function flag(country) {
  if (!country) return el('span', 'flag');
  const img = el('img', 'flag');
  img.src = `/flags/${country}.png`;
  img.alt = '';
  return img;
}

function svgIcon(symbol) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + symbol);
  svg.append(use);
  return svg;
}

function iconButton(symbol, text, onClick) {
  const b = el('button', 'icon');
  b.type = 'button';
  b.setAttribute('aria-label', text);
  b.title = text;
  b.append(svgIcon(symbol));
  b.addEventListener('click', e => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** "just now", "25 min ago", "3 h ago", "2 days ago". */
function age(time) {
  const min = Math.floor((Date.now() - time) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  const days = Math.floor(min / (24 * 60));
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
  return new Date(time).toLocaleDateString();
}

let toastTimer;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

// ---- wiring ------------------------------------------------------------------------------

function closeDrawer() {
  document.body.classList.remove('drawer');
  $('scrim').hidden = true;
}

let queryTimer;

function onQuery() {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => {
    if (splitView(prefs.view)[0] === 'web' && $('q').value.trim()) prefs.view = 'all';
    shown = PAGE;
    renderList();
  }, 120);
}

function onKey(e) {
  if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Escape' && e.target.id === 'q') {
      e.target.value = '';
      e.target.blur();
      onQuery();
    }
    return;
  }
  const a = selectedKey && articleByKey(selectedKey);
  const actions = {
    j: () => step(1), ArrowDown: () => step(1), k: () => step(-1), ArrowUp: () => step(-1),
    s: () => toggleSave(), m: toggleRead, r: () => refresh(), f: () => a && loadFullText(a),
    o: () => a && a.link && window.open(a.link, '_blank', 'noopener'),
    '/': () => $('q').focus(), Escape: closeReader,
  };
  const action = actions[e.key];
  if (!action) return;
  e.preventDefault();
  action();
}

/**
 * Stored sources, checked; a built-in feed that has been replaced (the directory entry says which
 * address it replaces, as The Guardian's, which refuses NewsFeed) becomes its replacement.
 */
function upgradeSources(stored, replaced = new Map()) {
  const out = [];
  let changed = false;
  for (const s of Array.isArray(stored) ? stored : []) {
    const replacement = s && s.url && directory.sources.find(d => d.replaces === s.url);
    const entry = sourceEntry(replacement ? { kind: 'rss', ...replacement } : s);
    changed = changed || Boolean(replacement) || !entry;
    if (replacement && entry) replaced.set(sid(s), sid(entry));
    if (entry && !out.some(x => sid(x) === sid(entry))) out.push(entry);
  }
  if (changed) store(KEY_SOURCES, out);
  return out;
}

/** The saved view, moved to a replaced source's replacement; "all" if its source is gone. */
function upgradeView(view, replaced) {
  const [kind, id] = splitView(view);
  if (kind !== 'source' && kind !== 'topic') return view;
  if (replaced.has(id)) return `source:${replaced.get(id)}`;
  return sources.some(s => sid(s) === id) ? view : 'all';
}

async function start() {
  try {
    directory = await getJson('/api/directory');
  } catch (e) {
    toast('Could not reach the NewsFeed server');
  }
  const replaced = new Map();
  sources = upgradeSources(load(KEY_SOURCES, []), replaced);
  readKeys = new Set(load(KEY_READ, []));
  saved = new Map(load(KEY_SAVED, []).filter(a => a && a.key).map(a => [a.key, a]));
  prefs = { ...prefs, ...load(KEY_PREFS, {}) };
  if (!Array.isArray(prefs.langs)) prefs.langs = [];
  if (prefs.view === 'web') prefs.view = 'all';
  prefs.view = upgradeView(prefs.view, replaced);

  $('q').addEventListener('input', onQuery);
  $('sort').addEventListener('change', () => { prefs.sort = $('sort').value; savePrefs(); renderList(); });
  $('since').addEventListener('change', () => { prefs.since = Number($('since').value); savePrefs(); shown = PAGE; renderList(); });
  $('unread-only').addEventListener('click', () => { prefs.unreadOnly = !prefs.unreadOnly; savePrefs(); shown = PAGE; renderList(); });
  $('mark-all').addEventListener('click', markAllRead);
  $('more').addEventListener('click', () => { shown += PAGE; renderList(); });
  $('refresh').addEventListener('click', () => refresh());
  $('add-source').addEventListener('click', () => openAdd());
  $('add-topic').addEventListener('click', () => openAdd('topic'));
  $('toggle-read').addEventListener('click', toggleRead);
  $('toggle-save').addEventListener('click', () => toggleSave());
  $('full-text').addEventListener('click', () => { const a = articleByKey(selectedKey); if (a) loadFullText(a); });
  $('close-reader').addEventListener('click', closeReader);
  $('home').addEventListener('click', e => { e.preventDefault(); setView('all'); });
  $('menu').addEventListener('click', () => { document.body.classList.add('drawer'); $('scrim').hidden = false; });
  $('scrim').addEventListener('click', closeDrawer);
  $('export').addEventListener('click', exportSources);
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', () => {
    const file = $('import-file').files[0];
    $('import-file').value = '';
    if (file) importFile(file).catch(e => toast(`Couldn’t import that file: ${e.message}`));
  });
  window.addEventListener('popstate', () => {
    if (document.body.classList.contains('reading')) {
      document.body.classList.remove('reading');
      renderList();
    }
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > AUTO_REFRESH_MS) refresh();
  });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, AUTO_REFRESH_MS);

  render();
  refresh();
}

start();
