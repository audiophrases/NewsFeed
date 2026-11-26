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
const KEY_LINKS = 'newsfeed.links';
const KEY_SYNC = 'newsfeed.sync';
/** Google News links whose article address is remembered, at most. */
const LINKS_LIMIT = 3000;

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
/** searchLangs: the languages searches use, as last picked (the first is the main one); null until picked. */
let prefs = { view: 'all', sort: 'newest', since: 0, unreadOnly: false, langs: [], fullText: true, searchLangs: null, textSize: 1 };
let shown = PAGE;
let visible = [];
let selectedKey = null;
/** The search view's news search (a topic that isn't followed, unless you follow it). */
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

/** Every change to what you follow comes through here (and goes to your other devices). */
const saveSources = () => {
  store(KEY_SOURCES, sources);
  noteSources();
};
const saveRead = () => store(KEY_READ, [...readKeys].slice(-READ_LIMIT));
const saveSaved = () => store(KEY_SAVED, [...saved.values()]);
const savePrefs = () => store(KEY_PREFS, prefs);

/** The article text sizes A− and A+ step through, as multiples of the usual size. */
const TEXT_SIZES = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];

/** Sets the article text size: a step up (1), down (-1), or none (0, to apply the saved one). */
function textSize(step) {
  const now = TEXT_SIZES.indexOf(prefs.textSize) >= 0 ? TEXT_SIZES.indexOf(prefs.textSize) : TEXT_SIZES.indexOf(1);
  const next = Math.min(TEXT_SIZES.length - 1, Math.max(0, now + step));
  prefs.textSize = TEXT_SIZES[next];
  $('reader').style.setProperty('--read', String(prefs.textSize));
  $('text-smaller').disabled = next === 0;
  $('text-larger').disabled = next === TEXT_SIZES.length - 1;
  if (!step) return;
  savePrefs();
  toast(`Text ${Math.round(prefs.textSize * 100)}%`);
}

// ---- sources -----------------------------------------------------------------------------

/** A bound on a topic's editions against bad data, not a choice: there are fewer languages. */
const MAX_EDITIONS = 25;

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
  if (!res.ok) {
    const error = new Error(body.error || `HTTP ${res.status}`);
    error.articleUrl = body.articleUrl;
    error.frameable = body.frameable;
    throw error;
  }
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
  const all = list === sources;
  if (!all && !list.length) return;
  if (all) {
    if (refreshing) return;
    refreshing = true;
    showRefreshing(true);
    // Your other devices' changes first, so the right sources are fetched (but don't wait long).
    await Promise.race([syncNow(), new Promise(resolve => setTimeout(resolve, 2000))]);
    list = sources;
  }
  // An open search is news too: it updates with the rest.
  if (all && webSearch && !sources.some(s => sid(s) === sid(webSearch))) fetchSource(webSearch).then(scheduleRebuild);
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
    showRefreshing(false);
    const failed = list.filter(s => loaded.get(sid(s))?.error);
    if (failed.length) toast(`${failed.length} of ${list.length} sources could not be updated`);
  }
  rebuild();
}

function showRefreshing(on) {
  $('refresh').classList.toggle('spinning', on);
  if (!on && pull && pull.updating) pullSettle();
}

// ---- pull down to update (phones and tablets) --------------------------------------------
//
// The page itself never scrolls (the list does), so the browser's own pull-to-refresh can't
// happen: the list does it. Pulling down from its top past PULL_READY and letting go updates
// everything; the spinner stays until the update is done.

const PULL_READY = 72;
const PULL_MAX = 120;
/** Where the spinner rests while updating, and how far above the list it hides. */
const PULL_REST = 56;
const PULL_HIDE = 48;

let pull = null;

function pullShow(distance, { ready = false, spinning = false, animate = false } = {}) {
  const box = $('pull');
  box.classList.toggle('settle', animate);
  box.classList.toggle('ready', ready);
  box.classList.toggle('spinning', spinning);
  const spinner = box.firstElementChild;
  spinner.style.transform = `translateY(${distance - PULL_HIDE}px) rotate(${spinning ? 0 : distance * 3}deg)`;
  spinner.style.opacity = String(spinning ? 1 : Math.min(1, distance / PULL_READY));
}

/** Hides the spinner, unless an update it started is still running. */
function pullSettle() {
  if (pull && pull.updating && refreshing) return;
  pull = null;
  pullShow(0, { animate: true });
}

function setupPullToRefresh() {
  const pane = $('list-pane');
  pane.addEventListener('touchstart', e => {
    if (pull && pull.updating) return;
    // Only from the very top, with one finger, not while a filter's chips are being swiped.
    pull = e.touches.length === 1 && pane.scrollTop <= 0
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, distance: 0, active: null }
        : null;
  }, { passive: true });
  pane.addEventListener('touchmove', e => {
    if (!pull || pull.updating || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - pull.x, dy = e.touches[0].clientY - pull.y;
    // The first few pixels decide: down and mostly vertical is a pull; anything else scrolls.
    if (pull.active === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      pull.active = dy > 0 && Math.abs(dy) > Math.abs(dx) && pane.scrollTop <= 0;
      if (!pull.active) return;
    }
    if (!pull.active) return;
    e.preventDefault(); // no rubber-band bounce or browser refresh meanwhile
    // Harder to pull the further it goes.
    pull.distance = Math.max(0, PULL_MAX * (1 - Math.exp(-dy / (PULL_MAX * 1.6))));
    pullShow(pull.distance, { ready: pull.distance >= PULL_READY });
  }, { passive: false });
  const end = () => {
    if (!pull || pull.updating) return;
    if (pull.active && pull.distance >= PULL_READY) {
      pull.updating = true;
      pullShow(PULL_REST, { spinning: true, animate: true });
      refresh().finally(pullSettle);
    } else {
      pullSettle();
    }
  };
  pane.addEventListener('touchend', end);
  pane.addEventListener('touchcancel', end);
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
      const tk = storyTitle(item.title);
      const twin = byKey.get(key) || (tk && byTitle.get(tk));
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
      if (tk) byTitle.set(tk, a);
      // A saved copy picks up a newer image or summary.
      if (saved.has(key)) saved.set(key, { ...a, savedAt: saved.get(key).savedAt });
    }
  }
  render();
}

/** What a news search of all outlets found; the ones already in your news are your articles. */
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

/** The search view: your articles that match its words, and what the news search found besides. */
function searchArticles() {
  if (!webSearch) return [];
  const query = parseQuery(webSearch.q);
  return combineSearch(query.include.length ? articles.filter(a => matches(a, query)) : [], webArticles());
}

const articleByKey = key => byKey.get(key) || saved.get(key) || webArticles().find(a => a.key === key) || null;

// ---- search and filters ------------------------------------------------------------------

// parseQuery, matches and score (search words, with OR) are in query.js.

/** Articles of the current view, before the language, time, unread and search filters. */
function viewArticles() {
  const [kind, id] = splitView(prefs.view);
  if (kind === 'saved') return [...saved.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  if (kind === 'web') return searchArticles();
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
  // A search's words chose its articles already (the news search's matched in their text too);
  // they still rank them for "Best match".
  const query = kind === 'web' ? parseQuery('') : parseQuery($('q').value);
  const ranking = kind === 'web' && webSearch ? parseQuery(webSearch.q) : query;
  const since = prefs.since ? Date.now() - prefs.since * 3600 * 1000 : 0;
  const langs = new Set(prefs.langs);
  let out = list.filter(a => (!since || a.publishedAt >= since)
      && (!prefs.unreadOnly || kind === 'unread' || !readKeys.has(a.key) || a.key === selectedKey)
      && (!langs.size || langs.has(a.lang || '?'))
      && matches(a, query));
  const sort = prefs.sort === 'relevance' && !ranking.include.length ? 'newest' : prefs.sort;
  if (kind === 'saved' && sort === 'newest' && prefs.sort === 'newest') return out; // by when saved
  const newest = (a, b) => b.publishedAt - a.publishedAt;
  if (sort === 'newest') out.sort(newest);
  else if (sort === 'oldest') out.sort((a, b) => (a.publishedAt || Infinity) - (b.publishedAt || Infinity));
  else if (sort === 'source') out.sort((a, b) => a.sourceName.localeCompare(b.sourceName) || newest(a, b));
  else if (sort === 'relevance') {
    const scores = new Map(out.map(a => [a, score(a, ranking)]));
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
  if (kind === 'web') return webSearch ? `Search: “${webSearch.q}”` : 'Search';
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
  const [viewKind, viewId] = splitView(prefs.view);
  $('edit-view').hidden = !((viewKind === 'source' || viewKind === 'topic') && sources.some(s => sid(s) === viewId));
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
  renderWebSearchBar(base);

  const query = parseQuery(viewKind === 'web' && webSearch ? webSearch.q : $('q').value);
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

/**
 * Under the toolbar while searching: typing shows matches in your news, with the search of all
 * news too one press away; that search's view says where its articles come from.
 */
function renderWebSearchBar(base) {
  const bar = $('web-search');
  const q = $('q').value.trim();
  const kind = splitView(prefs.view)[0];
  if (kind === 'web' && webSearch) {
    searchBar(bar, base);
    bar.hidden = false;
  } else if (q && kind !== 'saved' && parseQuery(q).include.length) {
    const all = button('primary-text', 'Search all news too', () => runWebSearch(q));
    all.title = 'Your news and a news search of every outlet, in one list (or press Enter)';
    bar.replaceChildren(el('span', '', 'Showing matches in your news.'), all);
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
}

/** The search's bar: how many articles are yours and how many more it found, its languages, follow. */
function searchBar(bar, base) {
  const got = loaded.get(sid(webSearch));
  const own = base.filter(a => byKey.has(a.key)).length;
  const yours = own ? `${own} in your news` : 'None in your news';
  const following = sources.some(s => sid(s) === sid(webSearch));
  const text = following ? `${yours}. You follow this topic.`
      : !got ? `${yours}. Searching all news…`
      : got.error && !got.items.length ? `${yours}. The search of all news failed: ${got.error}`
      : `${yours} · ${base.length - own} more from all news`;
  bar.replaceChildren(el('span', '', text));
  if (!following) {
    const keep = button('primary-text', 'Follow as a topic', () => follow(webSearch));
    keep.title = 'Keep this search in Topics, updated with the rest of your news';
    bar.append(keep);
  }
  const chosen = topicEditions(webSearch).map(e => e.split('-')[0]);
  const langs = el('div', 'also');
  langs.append(el('span', '', 'Search in:'), ...EDITION_LANGS.map(([lang, name]) => {
    const b = el('button', 'chip small', name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(chosen.includes(lang)));
    b.addEventListener('click', () => {
      if (!chosen.includes(lang)) rememberSearchLangs([...chosen, lang]);
      else if (chosen.length === 1) return toast('Search in at least one language');
      else rememberSearchLangs(chosen.filter(l => l !== lang));
      runWebSearch(webSearch.q);
    });
    return b;
  }));
  bar.append(langs);
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
      empty.append(el('p', '', got && got.error ? `Could not load: ${got.error}` : kind === 'unread' ? 'All caught up.'
          : kind === 'web' ? 'Nothing found, in your news or in all news.' : 'No articles yet.'));
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
  // The search box shows a search's words while its view is open, and only then.
  const box = $('q');
  if (webSearch && prefs.view === 'web' && view !== 'web' && box.value.trim() === webSearch.q) box.value = '';
  if (webSearch && view === 'web') box.value = webSearch.q;
  prefs.view = view;
  savePrefs();
  shown = PAGE;
  closeDrawer();
  $('list-pane').scrollTop = 0;
  render();
}

/**
 * Searches your news and all news for these words, in one view: a news search like a topic's (in
 * the languages last picked for searches), not followed unless you choose to.
 */
async function runWebSearch(q) {
  const old = webSearch;
  webSearch = topicEntry({ q, editions: searchEditions() });
  if (old && sid(old) !== sid(webSearch) && !sources.some(s => sid(s) === sid(old))) loaded.delete(sid(old));
  $('q').blur();
  setView('web');
  await fetchSource(webSearch);
  render();
}

/**
 * The languages searches and new topics use: the ones last picked, in that order; at first the
 * browser's own. Each in the browser's country where it has an edition there.
 */
function searchEditions() {
  const own = defaultEdition();
  const [ownLang, country] = own.split('-');
  const known = new Set(EDITION_LANGS.map(([lang]) => lang));
  const langs = (Array.isArray(prefs.searchLangs) ? prefs.searchLangs : []).filter(lang => known.has(lang));
  const editions = (langs.length ? langs : [ownLang]).map(lang => (lang === ownLang ? own : editionFor(lang, country)));
  return cleanEditions(editions);
}

/** Remembers the languages of the latest search, for the next ones. */
function rememberSearchLangs(langs) {
  prefs.searchLangs = [...new Set(langs)];
  savePrefs();
}

// ---- reader ------------------------------------------------------------------------------

const narrow = () => matchMedia('(max-width: 860px)').matches;

function select(key, { scroll = false } = {}) {
  const a = articleByKey(key);
  if (!a) return;
  selectedKey = key;
  if (!readKeys.has(key)) {
    readKeys.add(key);
    noteRead(key, true);
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

// ---- full screen reading -------------------------------------------------------------------
//
// The reader bar's full screen button: NewsFeed's search bar goes while an article is open, and on
// wide screens the sidebar and list too. It doesn't ask the browser for full screen: Chrome then
// shows a notice on how to leave it, every time, which no page can turn off. The same button or
// Esc ends it.

let fullRead = false;

function setFullRead(on) {
  fullRead = on;
  document.body.classList.toggle('full-read', on);
  $('full-screen').setAttribute('aria-pressed', String(on));
  $('full-screen').setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
  $('full-screen').title = on ? 'Leave full screen (Esc)' : 'Full screen';
  $('full-icon').setAttribute('href', on ? '#i-full-exit' : '#i-full');
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
  if ($('add-outlet')) $('add-outlet').hidden = followsOutlet(a);
  renderSiteButton();
}

function renderReader(a) {
  $('reader').classList.add('has-article');
  $('reader').classList.remove('site-view');
  $('open-original').href = articleLink(a) || '#';
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
  // From an outlet you don't follow (a topic's, a search's): one click to add it.
  const add = el('button', 'add-outlet');
  add.type = 'button';
  add.id = 'add-outlet';
  add.title = `Add ${a.sourceName} to your sources`;
  add.append(svgIcon('i-add'), el('span', '', 'Add source'));
  add.hidden = followsOutlet(a);
  add.addEventListener('click', () => showOutlet(a));
  meta.append(add);
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
  if (siteShown.has(a.key)) showSite(a);
  else if (fullTexts.has(a.key)) showFullText(a, fullTexts.get(a.key));
  else if (refusals.has(a.key)) {
    setStatus('summary', shownSoFar(a), refusals.get(a.key));
    readerActions(a, '', undefined, false);
  } else if (prefs.fullText && a.link && canFetch(a.link)) loadFullText(a);
  else if (a.link && !canFetch(a.link)) {
    setStatus('summary', shownSoFar(a), 'the article’s link isn’t a web address NewsFeed can open.');
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
  // The lookup of a topic's article: Google's own words, as the server puts them.
  if (/Google News/.test(message)) return `${message}.`;
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

/** Every web link can be loaded; a Google News one is first looked up (by the server, via Google). */
const canFetch = link => /^https?:\/\//i.test(link || '');

const isGoogleNews = link => /^https:\/\/news\.google\.com\//.test(link || '');

/**
 * Where Google News links lead, as the server found out: kept in this browser, so opening the
 * same article again (even after the server has restarted) doesn't ask Google again.
 */
let knownLinks = new Map();

const saveLinks = () => store(KEY_LINKS, [...knownLinks].slice(-LINKS_LIMIT));

/** The article's own address when known (a topic's articles come as Google News links). */
const articleLink = a => confirmedPublisherLink(a.link) || knownLinks.get(a.link) || a.link;

function rememberPublisher(a, address) {
  if (!isGoogleNews(a.link) || !canFetch(address) || isGoogleNews(address)) return;
  knownLinks.delete(a.link);
  knownLinks.set(a.link, address);
  saveLinks();
}

// A publisher may allow its public WordPress index to be read from the reader's network.
async function findPublisherFromBrowser(a, home) {
  const url = new URL('/wp-json/wp/v2/search', home);
  if (url.protocol !== 'https:' || !/\.[a-z]{2,}$/i.test(url.hostname)) return null;
  url.search = new URLSearchParams({ search: publisherSearchTerm(a.title), type: 'post', per_page: '20' });
  const response = await fetch(url, {
    credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const rows = await response.json();
  if (!Array.isArray(rows)) return null;
  const title = document.createElement('template');
  for (const row of rows.slice(0, 20)) {
    if (typeof row?.title !== 'string') continue;
    title.innerHTML = row.title;
    const link = publisherAddress(row.url, home);
    if (link && sameHeadline(title.content.textContent, a.title)) return link;
  }
  return null;
}

function publisherLinkForm(a, home) {
  const details = el('details', 'publisher-link');
  details.append(el('summary', '', 'Use a publisher link'));
  const form = el('form', 'actions');
  const input = el('input');
  input.type = 'url';
  input.required = true;
  input.placeholder = 'Paste the article URL';
  input.setAttribute('aria-label', 'Publisher article URL');
  input.addEventListener('input', () => input.setCustomValidity(''));
  const submit = el('button', 'primary subtle', 'Read here');
  submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const address = publisherAddress(input.value.trim(), home);
    if (!address) {
      input.setCustomValidity(`Enter an article URL on ${hostOf(home)}.`);
      input.reportValidity();
      return;
    }
    rememberPublisher(a, address);
    $('open-original').href = address;
    loadFullText(a);
  });
  details.append(form);
  return details;
}

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
    const link = articleLink(a);
    const where = isGoogleNews(link) ? a.sourceName : hostOf(link) || 'the site';
    const open = el('a', 'primary', openText || 'Read on ' + where);
    open.href = link;
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
  // Asked for the text while the site's page shows: back to the reader, which loads it.
  if (siteShown.delete(a.key)) return renderReader(a);
  const note = $('reader-note');
  if (note) note.replaceChildren();
  const link = articleLink(a);
  setStatus('loading', isGoogleNews(link) ? 'Finding the article through Google News…' : 'Loading the full article…');
  let result;
  try {
    // A Google News link comes with its headline and outlet, to find it on the outlet's site
    // if Google won't say where it leads.
    result = await getJson(`/api/article?url=${encodeURIComponent(link)}${lookupParams(a, link)}`);
  } catch (e) {
    rememberPublisher(a, e.articleUrl);
    if (e.frameable === false) frameRefused.add(a.key);
    if (selectedKey !== a.key || siteShown.has(a.key)) return;
    const home = isGoogleNews(articleLink(a)) && outletHome(a);
    if (home) {
      setStatus('loading', 'Checking the publisher’s index…');
      const address = await findPublisherFromBrowser(a, home).catch(() => null);
      if (selectedKey !== a.key || siteShown.has(a.key)) return;
      if (address) {
        rememberPublisher(a, address);
        return loadFullText(a);
      }
    }
    $('open-original').href = articleLink(a);
    const why = explainFailure(e.message, a.sourceName) +
        (e.frameable === false ? ' The publisher also blocks embedded pages.' : '');
    // Asking again won't change a subscribers-only, blocked or deleted page; a timeout might pass.
    const final = /HTTP (40[1-4]|410)/.test(e.message) && !isGoogleNews(articleLink(a));
    if (final) refusals.set(a.key, why);
    setStatus('summary', shownSoFar(a), why);
    readerActions(a, '', undefined, !final);
    if (home) $('reader-note').append(publisherLinkForm(a, home));
    return;
  }
  rememberPublisher(a, result.url);
  if (result.frameable === false) frameRefused.add(a.key);
  fullTexts.set(a.key, result);
  if (selectedKey === a.key && !siteShown.has(a.key)) {
    $('open-original').href = articleLink(a);
    showFullText(a, result);
  }
}

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function showFullText(a, result) {
  const text = $('reader-text');
  // The outlet's name as listed ("Altafulla Ràdio"), not its page's own, which can be a slogan.
  const site = a.sourceName || result.site;
  const { status, expected, subscriber } = result.completeness || { status: 'unknown' };
  // Only replace the feed's summary with something longer.
  const summaryLength = (a.summary || '').length;
  const fullLength = result.blocks.reduce((n, b) => n + b.text.length, 0);
  const minLength = result.from === 'publisher-post' || status === 'full' ? 1 : 300;
  if (!text || fullLength < Math.max(minLength, summaryLength * 1.2)) {
    const why = subscriber ? 'The page has no more of this subscriber article for NewsFeed.'
      : `${site} didn’t share more than this with NewsFeed.`;
    setStatus('summary', shownSoFar(a), why.replace(/^The/, 'the').replace(/\.$/, ''), subscriber);
    readerActions(a);
    fallbackFromPage(a, result, why);
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
    readerActions(a, 'The rest is on the site.', `Read the rest on ${hostOf(articleLink(a)) || site}`);
  } else {
    setStatus('unknown', 'Text from the page', `${minutes} · ${site} doesn’t say how long the article is, so it can’t be checked for completeness`);
    readerActions(a);
  }
}

// ---- when NewsFeed can't get the article's text ------------------------------------------
//
// Readability can recover an article when the paragraph extractor finds too little text.
// Loading the publisher's interactive site is a separate reader action.

/** Reading views by article key: a promise of the view, or of null when the page has none. */
const readingViews = new Map();
/** Articles for which the reader explicitly selected the publisher's site. */
const siteShown = new Set();
/** Articles whose site says other sites may not show its pages. */
const frameRefused = new Set();

/** The extra parameters that let the server find a topic's article if Google News won't say. */
const lookupParams = (a, link) => (isGoogleNews(link) && a.site
  ? `&title=${encodeURIComponent(a.title)}&site=${encodeURIComponent(a.site)}` : '');

let readabilityLoad = null;

/** Mozilla's Readability, loaded the first time a page needs it. */
function loadReadability() {
  if (window.Readability) return Promise.resolve();
  if (!readabilityLoad) {
    readabilityLoad = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/readability/Readability.js';
      script.onload = resolve;
      script.onerror = () => {
        readabilityLoad = null;
        reject(new Error('The reading view couldn’t be loaded'));
      };
      document.head.append(script);
    });
  }
  return readabilityLoad;
}

/** The article's reading view: { content, url, words, frameable }, or null if the page has too little. */
function makeReadingView(a) {
  if (!readingViews.has(a.key)) {
    const link = articleLink(a);
    const made = Promise.all([getJson(`/api/page?url=${encodeURIComponent(link)}${lookupParams(a, link)}`), loadReadability()])
        .then(([page]) => {
          if (page.frameable === false) frameRefused.add(a.key);
          // A parsed document is inert: nothing in it runs or loads.
          const doc = new DOMParser().parseFromString(page.html, 'text/html');
          const base = doc.createElement('base');
          base.href = page.url;
          doc.head.prepend(base);
          const parsed = new window.Readability(doc, { charThreshold: 300 }).parse();
          const text = parsed && (parsed.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length < Math.max(300, (a.summary || '').length * 1.2)) return null;
          return { content: parsed.content, url: page.url, words: text.split(' ').length };
        });
    made.catch(() => readingViews.delete(a.key));
    readingViews.set(a.key, made);
  }
  return readingViews.get(a.key);
}

/** Tags a reading view keeps (others give up their text and keep nothing else), and renamed ones. */
const READING_TAGS = new Set(['p', 'h3', 'h4', 'h5', 'ul', 'ol', 'li', 'blockquote', 'figure', 'figcaption', 'img',
  'a', 'em', 'i', 'strong', 'b', 'u', 's', 'sub', 'sup', 'br', 'hr', 'pre', 'code', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'th', 'td', 'caption', 'dl', 'dt', 'dd', 'small', 'mark', 'q', 'cite', 'abbr']);
const READING_RENAME = { h1: 'h3', h2: 'h3', h3: 'h4', h4: 'h5', h5: 'h5', h6: 'h5' };
/** Tags dropped with everything in them. */
const READING_DROP = new Set(['script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'svg', 'math', 'video', 'audio', 'canvas', 'noscript', 'template', 'link', 'meta', 'base', 'dialog']);

const webUrl = (value, base) => {
  try {
    const u = new URL(value, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch (e) {
    return null;
  }
};

/**
 * Readability's article as new elements of this page: rebuilt tag by tag from a list of allowed
 * ones, with only addresses (http and https) and table spans carried over, so nothing of the
 * page's own (scripts, handlers, styles, forms) can come along.
 */
function readingNodes(parent, base) {
  const out = [];
  for (const node of parent.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(document.createTextNode(node.data));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = READING_RENAME[node.localName] || node.localName;
    if (READING_DROP.has(tag)) continue;
    if (tag === 'img') {
      const src = webUrl(node.getAttribute('src') || (node.getAttribute('srcset') || '').trim().split(/\s+/)[0], base);
      if (!src || node.getAttribute('width') === '1' || node.getAttribute('height') === '1') continue;
      const img = el('img');
      img.src = src;
      img.alt = node.getAttribute('alt') || '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove());
      out.push(img);
      continue;
    }
    const children = readingNodes(node, base);
    if (!READING_TAGS.has(tag)) {
      out.push(...children);
      continue;
    }
    if (tag === 'a') {
      const href = webUrl(node.getAttribute('href') || '', base);
      if (!href) {
        out.push(...children);
        continue;
      }
      const link = el('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(...children);
      out.push(link);
      continue;
    }
    // Empty paragraphs and headings are what's left of page furniture.
    if (/^(p|h\d|li|figure|figcaption)$/.test(tag) && !children.some(c => c.nodeName === 'IMG' || c.querySelector?.('img'))
        && !children.map(c => c.textContent).join('').trim()) continue;
    const copy = el(tag);
    for (const name of ['colspan', 'rowspan']) {
      if (/^\d{1,2}$/.test(node.getAttribute(name) || '')) copy.setAttribute(name, node.getAttribute(name));
    }
    copy.append(...children);
    out.push(copy);
  }
  return out;
}

const sameImage = (x, y) => !!x && !!y && x.split('?')[0] === y.split('?')[0];

/** Ad labels (in the built-in sources' languages) and copyright lines that come along with an article. */
const READING_LABEL = /^(advertisement|advertising|sponsored|publicitat|publicidad|anuncio|werbung|anzeige|publicit[ée]|pubblicit[àa]|publicidade|advertentie)\b|^(©|copyright\b)/i;
const labelOnly = node => !!node && !node.querySelector?.('img') && node.textContent.trim().length < 200
    && READING_LABEL.test(node.textContent.trim());

function showReadingView(a, view) {
  const text = $('reader-text');
  if (!text) return;
  const doc = new DOMParser().parseFromString(view.content, 'text/html');
  text.replaceChildren(...readingNodes(doc.body, view.url));
  // The headline and picture the reader already shows, not twice.
  const heading = text.querySelector('h3, h4');
  if (heading && sameHeadline(heading.textContent, a.title) && !heading.previousElementSibling?.textContent.trim()) heading.remove();
  const first = text.querySelector('img');
  if (first && sameImage(first.src, a.image)) (first.closest('figure') || first).remove();
  while (labelOnly(text.firstElementChild)) text.firstElementChild.remove();
  while (labelOnly(text.lastElementChild)) text.lastElementChild.remove();
  for (const p of text.querySelectorAll('p')) if (p.textContent.trim().length <= 30 && labelOnly(p)) p.remove();
  const host = hostOf(view.url) || a.sourceName;
  setStatus('unknown', 'Reading view',
      `${Math.max(1, Math.round(view.words / 230))} min read · ${host}’s page with everything but the article left out; it can’t be checked for completeness`);
  readerActions(a);
}

/** The article's address for a frame: a web page (not Google News), https when NewsFeed is. */
function siteAddress(a) {
  const link = articleLink(a);
  if (!/^https?:\/\//i.test(link || '') || isGoogleNews(link)) return null;
  return location.protocol === 'https:' ? link.replace(/^http:/i, 'https:') : link;
}

function showSite(a) {
  const address = siteAddress(a);
  const text = $('reader-text');
  if (!address || !text) return;
  siteShown.add(a.key);
  $('reader').classList.add('site-view');
  const frame = el('iframe');
  frame.src = address;
  frame.title = `${a.sourceName}: ${a.title}`;
  frame.referrerPolicy = 'no-referrer';
  // The page runs as on its own site, but can't take NewsFeed's place (pages in frames often try).
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('allow', 'fullscreen');
  const box = el('div', 'site-frame');
  box.append(frame);
  text.replaceChildren(box);
  const host = hostOf(address) || a.sourceName;
  setStatus('site', 'The site’s own page', `Shown here as ${host} shows it.`);
  readerActions(a, `If it stays blank, ${host} doesn’t let other sites show its pages: open it on the site.`,
      undefined, !refusals.has(a.key));
  renderSiteButton();
}

/** Try Readability, then keep the feed's text when there is no readable article body. */
async function fallbackFromPage(a, result, why) {
  if (result.frameable === false) frameRefused.add(a.key);
  if (!(result.completeness && result.completeness.subscriber)) {
    setStatus('loading', 'Making a reading view of the page…');
    let view = null;
    try {
      view = await makeReadingView(a);
    } catch (e) {
      // The summary is still available.
    }
    if (selectedKey !== a.key || siteShown.has(a.key)) return;
    if (view) return showReadingView(a, view);
  }
  if (selectedKey !== a.key) return;
  setStatus('summary', shownSoFar(a), why, result.completeness?.subscriber);
  readerActions(a);
}

/** The reader bar's site button: shows the site's page, or goes back to the reader. */
function toggleSite() {
  const a = selectedKey && articleByKey(selectedKey);
  if (!a) return;
  if (siteShown.has(a.key)) {
    siteShown.delete(a.key);
    renderReader(a);
  } else if (!siteAddress(a)) {
    toast(a.link && isGoogleNews(articleLink(a)) ? 'Its address isn’t known yet: load the full text first' : 'This article has no web page');
  } else if (frameRefused.has(a.key)) {
    toast(`${a.sourceName} doesn’t let other sites show its pages`);
  } else {
    showSite(a);
  }
  renderSiteButton();
}

function renderSiteButton() {
  const on = !!selectedKey && siteShown.has(selectedKey);
  $('view-site').classList.toggle('on', on);
  $('view-site').setAttribute('aria-pressed', String(on));
  $('view-site').title = on ? 'Back to the reader (w)' : 'Show the site’s page here (w)';
}

function toggleRead() {
  if (!selectedKey) return;
  if (readKeys.has(selectedKey)) readKeys.delete(selectedKey);
  else readKeys.add(selectedKey);
  noteRead(selectedKey, readKeys.has(selectedKey));
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
  noteSaved(key, saved.get(key));
  saveSaved();
  render();
}

function markAllRead() {
  const list = visible.filter(a => !readKeys.has(a.key));
  if (!list.length) return toast('Nothing unread here');
  for (const a of list) {
    readKeys.add(a.key);
    noteRead(a.key, true);
  }
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
    // The topic shows everything its search finds: its words in the box would hide some.
    if ($('q').value.trim() === entry.q) $('q').value = '';
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
  if (!confirm(`Stop following ${s.name}?`)) return false;
  const id = sid(s);
  sources = sources.filter(x => sid(x) !== id);
  saveSources();
  loaded.delete(id);
  if (splitView(prefs.view)[1] === id) prefs.view = 'all';
  savePrefs();
  rebuild();
  return true;
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
  setStep('Follow a topic', 'Follow', true);
  const form = el('div', 'form');
  const { fields, preview, input } = topicFields(typeof q === 'string' ? q : '', searchEditions());
  form.append(...fields);
  $('add-body').replaceChildren(form, preview);
  renderTopicLanguages();
  input.focus();
}

/** A topic's words, main edition and other languages, as form fields (and its preview list). */
function topicFields(q, editions) {
  topicAlso = new Set(editions.slice(1).map(e => e.split('-')[0]));
  const input = dialogInput('text', 'topic-q', 'e.g. climate, "champions league", AI -crypto', previewTopic);
  input.value = q;
  input.setAttribute('aria-label', 'Words to follow');
  const edition = document.createElement('select');
  edition.id = 'topic-edition';
  edition.setAttribute('aria-label', 'News edition');
  for (const [code, name] of EDITIONS) edition.append(new Option(name, code));
  edition.value = editions[0];
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
  return { fields: [input, edition, alsoHead, also, alsoHelp, help], preview, input };
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
  const topic = topicEntry({ q, editions });
  // A new topic's languages are the latest searched (editing a topic you follow doesn't count).
  if (addMode === 'topic') rememberSearchLangs(topic.editions.map(e => e.split('-')[0]));
  return topic;
}

async function previewTopic() {
  const t = topicFromForm();
  if (!t) return;
  const request = ++previewRequest;
  $('topic-help').textContent = 'Searching…';
  $('topic-q').blur();
  try {
    const feed = await getJson(apiUrl(t));
    if (request !== previewRequest || (addMode !== 'topic' && addMode !== 'edit-one')) return;
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

// ---- adding the outlet of the article you're reading -----------------------------------------

/**
 * An article's outlet's home page: from Google News' word on its source, else the article's own
 * address; null when neither names it (an aggregator's link not looked up yet).
 */
function outletHome(a) {
  for (const link of [a.site, articleLink(a)]) {
    try {
      const u = new URL(link);
      if (/^https?:$/.test(u.protocol) && !/(^|\.)(google|bing)\.com$/.test(u.hostname)) return u.origin;
    } catch (e) {
      // not an address
    }
  }
  return null;
}

/** Two hosts of one site: the same, or one inside the other (edition.cnn.com and cnn.com). */
const sameSite = (x, y) => x === y || x.endsWith('.' + y) || y.endsWith('.' + x);

/** The hosts a source reads from: its feed's and its site's, or its Google News site's. */
function sourceHosts(s) {
  if (s.kind === 'news') return [s.site.split('/')[0].replace(/^www\./, '')];
  return [hostOf(s.url), hostOf(loaded.get(sid(s))?.siteUrl || '')].filter(Boolean);
}

/** Whether you follow an article's outlet as a source (its feed or headlines), not just a topic. */
function followsOutlet(a) {
  const followed = sources.filter(s => s.kind !== 'topic');
  if (followed.some(s => a.sids.includes(sid(s)))) return true;
  const home = outletHome(a);
  return Boolean(home) && followed.some(s => sourceHosts(s).some(h => sameSite(h, hostOf(home))));
}

/** Google News' edition for an outlet's headlines: its articles' language, in your country if it can. */
const outletEdition = a => (a.lang && editionFor(a.lang.split('-')[0].toLowerCase(), defaultEdition().split('-')[1]))
    || defaultEdition();

/**
 * A feed of an outlet, named for the sidebar: the outlet's name for its only feed, or for one whose
 * title is that name with a tagline ("News from California, … - Los Angeles Times"); otherwise
 * the feed's title, which names a section ("The Economist – Europe").
 */
function outletFeedName(outlet, f, only) {
  const title = sourceTitle(f.site || outlet, f.title) || outlet;
  const words = s => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const named = fold(title).includes(fold(outlet));
  return only || (named && words(title).length - words(outlet).length > 3) ? outlet : title;
}

let outletRequest = 0;

/**
 * "Add source" in the reader: the feeds on the article's site to tick, and its headlines via
 * Google News, ticked when the site has no feed NewsFeed can read. Without a site, a search by name.
 */
async function showOutlet(a) {
  const home = outletHome(a);
  if (!home) {
    showGroups(a.sourceName);
    if (!$('add-dialog').open) $('add-dialog').showModal();
    return searchSources();
  }
  const host = hostOf(home);
  const request = ++outletRequest;
  addMode = 'outlet';
  setStep(`Add ${a.sourceName}`, 'Add', false);
  $('add-confirm').disabled = true;
  const help = el('p', 'help', `Looking for feeds on ${host}…`);
  const results = el('div');
  $('add-body').replaceChildren(help, results);
  if (!$('add-dialog').open) $('add-dialog').showModal();

  let feeds = [], error = null;
  try {
    feeds = await getJson(`/api/discover?url=${encodeURIComponent(home)}`);
  } catch (e) {
    error = e.message;
  }
  if (addMode !== 'outlet' || request !== outletRequest) return;
  $('add-confirm').disabled = false;
  addCandidates = [
    ...feeds.map(f => ({ kind: 'rss', url: f.url, name: outletFeedName(a.sourceName, f, feeds.length === 1),
      lang: f.language, country: guessCountry(f.url, f.language) })),
    sourceEntry({ kind: 'news', site: host, edition: outletEdition(a), name: a.sourceName, lang: a.lang }),
  ];
  const have = new Set(sources.map(sid));
  results.replaceChildren(...addCandidates.map((s, i) => {
    const row = el('label', 'choice');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.index = i;
    const following = have.has(sid(s));
    box.checked = following || (feeds.length === 1 ? i === 0 : !feeds.length && s.kind === 'news');
    box.disabled = following;
    const f = feeds[i];
    const detail = following ? 'Following' : !f ? sourceDetail(s)
      : [`${f.count} articles`, f.language ? languageName(f.language) : '', f.sample ? `“${f.sample}”` : hostOf(f.url)].filter(Boolean).join(' · ');
    const name = el('span', 'name', s.name);
    name.append(el('span', 'detail', detail));
    row.append(box, mark(s.country, home), name);
    return row;
  }));
  help.textContent = feeds.length > 1 ? `${host} has ${feeds.length} feeds. Tick the ones you want, then press Add.`
    : feeds.length ? `Found ${host}’s feed. Press Add to follow it.`
    : error ? `${host} doesn’t let NewsFeed look for its feeds (${error}), but its headlines can come through Google News.`
    : `No feed found on ${host}, but its headlines can come through Google News.`;
  const other = el('p', 'help');
  other.append(button('primary-text', `Not this site? Search for “${a.sourceName}”`, () => {
    showGroups(a.sourceName);
    searchSources();
  }));
  results.append(other);
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
  if (addMode === 'group' || addMode === 'found' || addMode === 'search' || addMode === 'outlet') {
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
  } else if (addMode === 'edit') {
    $('add-dialog').close();
  } else if (addMode === 'edit-one') {
    await saveEdit();
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
  if (addMode === 'edit-one') showEditList();
  else if (addMode === 'found') showAddressForm();
  else showGroups(addMode === 'search' ? sourceQuery : '');
});

// ---- editing what you follow: rename, reorder, change -------------------------------------

/** Countries there are flag pictures for; es-ct is Catalonia. */
const FLAGS = ['at', 'au', 'be', 'ca', 'ch', 'de', 'es', 'es-ct', 'fr', 'gb', 'ie', 'in', 'it', 'mx', 'nl', 'nz', 'pt', 'qa', 'us'];

const isTopic = s => s.kind === 'topic';
const isSource = s => s.kind !== 'topic';

/** A flag's country in the browser's language (Catalonia has no country code of its own). */
function countryName(code) {
  if (code === 'es-ct') return 'Catalunya';
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of(code.toUpperCase());
  } catch (e) {
    return code.toUpperCase();
  }
}

/** What something is called when its name is cleared: a feed's own title, a topic's words, a site. */
function defaultName(s) {
  if (s.kind === 'topic') return s.q;
  if (s.kind === 'news') return s.site;
  return loaded.get(sid(s))?.title || hostOf(s.url);
}

/** The one being changed in "More settings", and whether that was opened from the list. */
let editing = null;
let editFromList = false;
let dragging = null;

function openEditor(section) {
  showEditList(section);
  if (!$('add-dialog').open) $('add-dialog').showModal();
  closeDrawer();
}

function openEditOne(s) {
  editFromList = false;
  showEditOne(s);
  if (!$('add-dialog').open) $('add-dialog').showModal();
  closeDrawer();
}

/** Every topic and source in its section: rename by typing, arrows or dragging to reorder. */
function showEditList(scrollTo, focus) {
  addMode = 'edit';
  editing = null;
  setStep('Edit topics and sources', 'Done', false);
  const body = [];
  if (!sources.length) body.push(el('p', 'help indent', 'Nothing to edit yet: follow some sources or topics first.'));
  for (const [label, inSection] of [['Topics', isTopic], ['Sources', isSource]]) {
    const list = sources.filter(inSection);
    if (!list.length) continue;
    const head = el('div', 'group-head', label);
    head.id = 'edit-' + label.toLowerCase();
    body.push(head, ...list.map((s, i) => editRow(s, i, list.length, inSection)));
  }
  if (sources.length) {
    body.push(el('p', 'help indent', 'Type to rename (empty gives back the original name). Move with the arrows, '
        + 'or drag by the handle. ✎ opens more settings: flag, language, address, or a topic’s words and languages.'));
  }
  $('add-body').replaceChildren(...body);
  if (scrollTo) $('edit-' + scrollTo)?.scrollIntoView({ block: 'start' });
  if (focus) $('add-body').querySelector(`.edit-row[data-id="${CSS.escape(focus.id)}"] [data-action="${focus.action}"]`)?.focus();
}

function editRow(s, index, count, inSection) {
  const id = sid(s);
  const row = el('div', 'edit-row');
  row.dataset.id = id;
  const handle = el('span', 'handle');
  handle.title = 'Drag to reorder';
  handle.append(svgIcon('i-drag'));
  // Only the handle starts a drag, so selecting text in the name still works.
  handle.addEventListener('pointerdown', () => { row.draggable = true; });
  handle.addEventListener('pointerup', () => { row.draggable = false; });
  row.addEventListener('dragstart', e => {
    dragging = s;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', s.name);
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    dragging = null;
    row.draggable = false;
    row.classList.remove('dragging');
  });
  row.addEventListener('dragover', e => {
    if (!dragging || dragging === s || !inSection(dragging)) return;
    e.preventDefault();
    const list = sources.filter(inSection);
    row.classList.add(list.indexOf(dragging) < index ? 'drop-after' : 'drop-before');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.classList.remove('drop-before', 'drop-after');
    if (dragging && dragging !== s && inSection(dragging)) moveTo(dragging, inSection, index);
  });

  const glyph = el('span', 'glyph');
  glyph.append(svgIcon('i-search'));
  const name = document.createElement('input');
  name.type = 'text';
  name.value = s.name;
  name.placeholder = defaultName(s);
  name.setAttribute('aria-label', `Name of ${s.name}`);
  name.addEventListener('input', () => rename(s, name.value, false));
  name.addEventListener('change', () => {
    rename(s, name.value, true);
    name.value = s.name;
  });
  name.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      name.blur();
    }
  });
  const button = (symbol, label, action, onClick, disabled = false) => {
    const b = iconButton(symbol, label, onClick);
    b.dataset.action = action;
    b.disabled = disabled;
    return b;
  };
  row.append(handle, isTopic(s) ? glyph : mark(s.country, sourceLink(s)), name,
      button('i-up', `Move ${s.name} up`, 'up', () => moveTo(s, inSection, index - 1, 'up'), index === 0),
      button('i-down', `Move ${s.name} down`, 'down', () => moveTo(s, inSection, index + 1, 'down'), index === count - 1),
      button('i-edit', `More settings for ${s.name}`, 'more', () => {
        editFromList = true;
        showEditOne(s);
      }),
      button('i-delete', `Stop following ${s.name}`, 'remove', () => { if (unfollow(s)) showEditList(); }));
  return row;
}

/** A new name, saved as it is typed; an empty one, once done, gives back the original. */
function rename(s, value, done) {
  const name = value.trim();
  if (!name && !done) return;
  s.name = name || defaultName(s);
  saveSources();
  scheduleRebuild(); // the sidebar, and articles that show their source's name
}

function moveTo(s, inSection, to, keepFocusOn) {
  const from = sources.filter(inSection).indexOf(s);
  sources = moveWithin(sources, inSection, from, to);
  saveSources();
  renderSidebar();
  // Keep a keyboard user on the arrow they pressed, unless the row reached the end it points to.
  const list = sources.filter(inSection);
  const at = list.indexOf(s);
  const action = keepFocusOn === 'up' && at === 0 ? 'down' : keepFocusOn === 'down' && at === list.length - 1 ? 'up' : keepFocusOn;
  showEditList(null, action ? { id: sid(s), action } : null);
}

/** A labelled form field. */
function field(label, control, help) {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'label', label), control);
  if (help) wrap.append(el('span', 'help small', help));
  return wrap;
}

function selectOf(id, options, value) {
  const select = document.createElement('select');
  select.id = id;
  for (const [code, label] of options) select.append(new Option(label, code));
  select.value = value;
  return select;
}

/** All the settings of one topic or source. */
function showEditOne(s) {
  addMode = 'edit-one';
  editing = s;
  setStep(`Edit “${s.name}”`, 'Save', editFromList);
  const form = el('div', 'form');
  const name = dialogInput('text', 'edit-name', defaultName(s), confirmAdd);
  name.value = s.name;
  form.append(field('Name', name, 'Leave it empty for the original name.'));
  const flags = [['', isTopic(s) ? '' : 'No flag (the site’s own icon)'],
    ...FLAGS.map(code => [code, countryName(code)]).sort((a, b) => a[1].localeCompare(b[1]))];
  let preview = null;
  if (s.kind === 'topic') {
    const topic = topicFields(s.q, topicEditions(s));
    form.append(field('Words', topic.input), ...topic.fields.slice(1));
    preview = topic.preview;
  } else if (s.kind === 'news') {
    const site = dialogInput('text', 'edit-site', 'example.com or example.com/section', confirmAdd);
    site.value = s.site;
    form.append(field('Site', site, 'Its headlines come through Google News (a site: search); a section such as theguardian.com/world works too.'),
        field('Edition', selectOf('edit-edition', EDITIONS, s.edition)),
        field('Flag', selectOf('edit-flag', flags, s.country || '')));
  } else {
    const url = dialogInput('url', 'edit-url', 'https://example.com/feed', confirmAdd);
    url.value = s.url;
    const langs = [['', 'As the feed says'], ...EDITION_LANGS];
    if (s.lang && !langs.some(([code]) => code === s.lang)) langs.push([s.lang, languageName(s.lang)]);
    form.append(field('Feed address', url, 'The RSS or Atom address it is read from.'),
        field('Flag', selectOf('edit-flag', flags, s.country || '')),
        field('Language', selectOf('edit-lang', langs, s.lang || ''), 'Used by the language filter above the list.'));
  }
  $('add-body').replaceChildren(form, ...(preview ? [preview] : []));
  if (s.kind === 'topic') renderTopicLanguages();
  name.focus();
}

/** Saves "More settings": in place, keeping its position; read again if what it reads changed. */
async function saveEdit() {
  const s = editing;
  const i = sources.indexOf(s);
  if (!s || i < 0) return showEditList();
  const typed = $('edit-name').value.trim();
  let entry;
  if (s.kind === 'topic') {
    const t = topicFromForm();
    if (!t) return $('topic-q').focus();
    // A name that was the words follows the words.
    entry = { ...t, name: !typed || (typed === s.name && s.name === s.q) ? t.q : typed };
  } else if (s.kind === 'news') {
    const edition = $('edit-edition').value;
    entry = sourceEntry({ kind: 'news', site: $('edit-site').value, edition, lang: edition.split('-')[0],
      country: $('edit-flag').value || null, name: typed || s.name });
    if (!entry) {
      toast('That isn’t a site address');
      return $('edit-site').focus();
    }
    if (!typed) entry.name = entry.site;
  } else {
    let url = $('edit-url').value.trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    entry = sourceEntry({ kind: 'rss', url, lang: $('edit-lang').value || null, country: $('edit-flag').value || null,
      name: typed || s.name });
    if (!entry) {
      toast('That isn’t a web address');
      return $('edit-url').focus();
    }
    if (!typed) entry.name = url === s.url ? defaultName(s) : hostOf(url);
  }
  const oldId = sid(s), newId = sid(entry);
  if (newId !== oldId && sources.some(x => sid(x) === newId)) return toast('You already follow that');
  sources[i] = entry;
  saveSources();
  const [kind, viewId] = splitView(prefs.view);
  if (viewId === oldId) {
    prefs.view = `${kind}:${newId}`;
    savePrefs();
  }
  if (editFromList) showEditList();
  else $('add-dialog').close();
  toast(`Saved ${entry.name}`);
  if (newId !== oldId) {
    loaded.delete(oldId);
    await refresh([entry]);
  } else {
    rebuild();
  }
}

// ---- export and import -------------------------------------------------------------------

function exportSources() {
  const data = JSON.stringify({ app: 'NewsFeed', version: 1, sources, saved: [...saved.values()] }, null, 2);
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `newsfeed-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- sync between devices -----------------------------------------------------------------
//
// Signed in (with PinPlay's Google sign-in), what you follow, what you've read and what you've
// saved are the same on every device: each change goes to NewsFeed's sync service (sync/worker.mjs,
// at the server's SYNC_URL) a moment after it's made, and the other devices' changes come back
// with every refresh, when NewsFeed comes back into view and every few minutes. The latest change
// of a read mark or saved article wins; the source list, which two devices may both edit, is
// merged (organize.js). Not signed in, nothing leaves this browser.

const SYNC_EVERY_MS = 5 * 60 * 1000;
/** The sync service's address; null when this server has none (then there's no sign-in). */
let syncUrl = null;
/**
 * While signed in: { token, email, name, expiresAt, since: the account version this device has,
 * base: the account's source list as this device last had it, sourcesV: that list's version }.
 */
let account = null;
/** Changes not sent yet. full: everything this device has goes, and all the account's comes back. */
const noChanges = () => ({ sources: 0, read: {}, saved: {}, full: false });
let pending = noChanges();
let syncing = false;
let syncAgain = false;
let syncTimer = null;
let syncError = '';
let lastSync = 0;

const saveSync = () => store(KEY_SYNC, account ? { account, pending } : null);
const hasChanges = p => Boolean(p.sources || p.full || Object.keys(p.read).length || Object.keys(p.saved).length);

function noteRead(key, isRead) {
  if (!account) return;
  pending.read[key] = [isRead ? 1 : 0, Date.now()];
  scheduleSync();
}

function noteSaved(key, article) {
  if (!account) return;
  pending.saved[key] = [article || null, Date.now()];
  scheduleSync();
}

function noteSources() {
  if (!account) return;
  pending.sources = Date.now();
  scheduleSync();
}

/** Sends a moment later, so a burst of changes (marking all read) goes in one request. */
function scheduleSync(ms = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), ms);
}

/**
 * On signing in: everything here joins the account. Read marks and saved articles the account
 * has a later change of keep it; the sources merge with the account's (from nothing in common).
 */
function queueEverything() {
  for (const key of readKeys) pending.read[key] ||= [1, 1];
  for (const [key, a] of saved) pending.saved[key] ||= [a, a.savedAt || 1];
  pending.sources = Date.now();
  pending.full = true;
  account.base = [];
  account.sourcesV = 0;
}

/** Sends this device's changes and takes the account's; one request at a time. */
async function syncNow({ keepalive = false } = {}) {
  clearTimeout(syncTimer);
  if (!account || !syncUrl) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  const sent = pending;
  pending = noChanges();
  const since = sent.full ? 0 : account.since || 0;
  // A copy: the list may change (in place) while this is on its way.
  const list = sent.sources ? JSON.parse(JSON.stringify(sources)) : null;
  renderSyncButton();
  try {
    const res = await fetch(syncUrl + '/sync', {
      method: 'POST',
      keepalive,
      headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        since,
        sources: list ? { list, base: account.sourcesV || 0 } : undefined,
        read: Object.entries(sent.read).map(([key, [state, at]]) => [key, state, at]),
        saved: Object.entries(sent.saved).map(([key, [article, at]]) => [key, article, at]),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return signOut(data.error || 'Sign in again to keep syncing');
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    applySync(data, since, list);
    syncError = '';
    lastSync = Date.now();
  } catch (e) {
    // Sent again next time, unless changed here since.
    pending = { sources: pending.sources || sent.sources, read: { ...sent.read, ...pending.read },
      saved: { ...sent.saved, ...pending.saved }, full: pending.full || sent.full };
    syncError = e.message === 'Failed to fetch' ? 'no connection' : e.message;
  } finally {
    syncing = false;
    saveSync();
    renderSyncButton();
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(100);
    }
  }
}

/**
 * Takes the account's changes, except where this device changed something since it asked. The
 * source list it sent (list) is the account's now, or was refused: then the account's comes back
 * and this device's changes (since the list both had, account.base) merge into it, to go again.
 */
function applySync(data, since, list) {
  if (data.sources) {
    const theirs = cleanSources(data.sources.list);
    const mine = list || pending.sources ? sources : null; // changed here, not in the account
    const merged = mine ? mergeLists(account.base || [], mine, theirs.list, sid) : theirs.list;
    account.base = theirs.list;
    account.sourcesV = data.sources.v;
    useSources(merged);
    if (theirs.changed || JSON.stringify(merged) !== JSON.stringify(data.sources.list)) {
      noteSources();
      scheduleSync(50); // merged: straight back, before another device changes it again
    }
  } else if (list) {
    account.base = list;
    account.sourcesV = data.sourcesVersion;
  }
  let read = false, kept = false;
  for (const [key, state] of data.read || []) {
    if (pending.read[key]) continue;
    if (state) readKeys.add(key);
    else readKeys.delete(key);
    read = true;
  }
  for (const [key, article] of data.saved || []) {
    if (pending.saved[key]) continue;
    if (article && article.key === key) saved.set(key, article);
    else saved.delete(key);
    kept = true;
  }
  if (read) saveRead();
  if (kept) saveSaved();
  account.since = data.version;
  // The account doesn't know what this device had (it was reset): everything here goes again.
  if (data.full && since > 0) {
    queueEverything();
    scheduleSync();
  }
  if (read || kept) render();
}

/** The source list from the account: kept here, and new sources fetched. */
function useSources(list) {
  const before = new Set(sources.map(sid));
  sources = list;
  store(KEY_SOURCES, sources);
  const [kind, id] = splitView(prefs.view);
  if ((kind === 'source' || kind === 'topic') && !sources.some(s => sid(s) === id)) prefs.view = 'all';
  const added = sources.filter(s => !before.has(sid(s)) && !loaded.has(sid(s)));
  // During a refresh, the refresh fetches them.
  if (added.length && !refreshing) refresh(added);
  else rebuild();
}

function signOut(message) {
  account = null;
  pending = noChanges();
  syncError = '';
  saveSync();
  renderSyncButton();
  if (addMode === 'sync' && $('add-dialog').open) showSync();
  try {
    google.accounts.id.disableAutoSelect();
  } catch (e) {
    // Google's script isn't loaded: nothing to forget.
  }
  if (message) toast(message);
}

function renderSyncButton() {
  const b = $('sync');
  b.hidden = !syncUrl;
  b.textContent = !account ? 'Sync' : syncing ? 'Syncing…' : syncError ? 'Sync ⚠' : 'Synced';
  b.title = !account ? 'Keep what you follow, read and save the same on all your devices'
    : syncError ? `Couldn’t sync: ${syncError}` : `Signed in as ${account.email}`;
}

/** The sync dialog: Google's sign-in button, or who is signed in and how syncing goes. */
function showSync() {
  addMode = 'sync';
  setStep(account ? 'Sync between devices' : 'Sync your devices', null, false);
  const body = [];
  if (account) {
    const who = account.name ? `${account.name} (${account.email})` : account.email;
    body.push(el('p', 'help', `Signed in as ${who}. What you follow, what you’ve read and what you’ve saved `
        + 'are the same on every device you sign in on.'),
    el('p', 'help', syncing ? 'Syncing…' : syncError ? `Couldn’t sync: ${syncError}. NewsFeed tries again by itself.`
      : lastSync ? `Synced ${age(lastSync)}.` : ''));
    const actions = el('div', 'sync-actions');
    actions.append(button('primary subtle', 'Sync now', async () => {
      await syncNow();
      if (addMode === 'sync' && $('add-dialog').open) showSync();
    }), button('primary-text', 'Sign out', () => signOut()));
    body.push(actions);
  } else {
    const box = el('div', 'google-button');
    const status = el('p', 'help');
    status.id = 'sync-status';
    body.push(el('p', 'help', 'Sign in with Google on each of your devices to keep what you follow, what you’ve read '
        + 'and what you’ve saved the same on all of them. What this device has joins your account.'),
    box, status, el('p', 'help small', 'NewsFeed uses PinPlay’s Google sign-in, so Google shows PinPlay’s name. '
        + `If Google says the origin isn’t allowed, ${location.origin} has to be added to that sign-in’s sites first.`));
    renderGoogleButton(box);
  }
  $('add-body').replaceChildren(...body);
  if (!$('add-dialog').open) $('add-dialog').showModal();
  closeDrawer();
}

const syncStatus = text => {
  if ($('sync-status')) $('sync-status').textContent = text;
};

let googleScript = null;

function loadGoogleScript() {
  googleScript ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => {
      googleScript = null;
      reject(new Error('check your connection'));
    };
    document.head.append(s);
  });
  return googleScript;
}

/** Google's sign-in button, for the sync service's Google client (PinPlay's). */
async function renderGoogleButton(box) {
  try {
    const [config] = await Promise.all([getJson(syncUrl + '/config'), loadGoogleScript()]);
    if (!config.ready) return syncStatus('Sync isn’t set up on this server yet.');
    google.accounts.id.initialize({ client_id: config.googleClientId, callback: r => signIn(r.credential) });
    google.accounts.id.renderButton(box, { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill' });
  } catch (e) {
    syncStatus(`Google sign-in couldn’t load: ${e.message}`);
  }
}

/** Google said who you are: the sync service checks it and signs this device in. */
async function signIn(credential) {
  syncStatus('Signing in…');
  try {
    const res = await fetch(syncUrl + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googleIdToken: credential }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    account = { token: data.token, email: data.email, name: data.name, expiresAt: data.expiresAt, since: 0, base: [], sourcesV: 0 };
    pending = noChanges();
    queueEverything();
    saveSync();
    await syncNow();
    if (addMode === 'sync' && $('add-dialog').open) showSync();
    toast(syncError ? `Signed in, but couldn’t sync yet: ${syncError}` : `Synced with ${data.email}`);
  } catch (e) {
    syncStatus(`Couldn’t sign in: ${e.message}`);
  }
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
  for (const a of savedList) {
    if (saved.has(a.key)) continue;
    saved.set(a.key, a);
    noteSaved(a.key, a);
  }
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
    const q = $('q').value.trim();
    // Other words while a search is open: back to your news, filtered as you type (Enter searches).
    if (splitView(prefs.view)[0] === 'web' && q && q !== webSearch?.q) return setView('all');
    shown = PAGE;
    renderList();
  }, 120);
}

/** Enter in the search box searches all news too, with your news, in one list. */
function onQueryKey(e) {
  if (e.key !== 'Enter' || e.isComposing) return;
  const q = $('q').value.trim();
  if (parseQuery(q).include.length) runWebSearch(q);
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
    s: () => toggleSave(), m: toggleRead, r: () => refresh(), f: () => a && loadFullText(a), w: toggleSite,
    o: () => a && a.link && window.open(articleLink(a), '_blank', 'noopener'),
    '/': () => $('q').focus(), Escape: () => (fullRead ? setFullRead(false) : closeReader()),
    '+': () => textSize(1), '=': () => textSize(1), '-': () => textSize(-1),
  };
  const action = actions[e.key];
  if (!action) return;
  e.preventDefault();
  action();
}

/**
 * Sources as stored here or by another device, checked: { list, changed }. A built-in feed that
 * has been replaced (the directory entry says which address it replaces, as The Guardian's, which
 * refuses NewsFeed) becomes its replacement.
 */
function cleanSources(stored, replaced = new Map()) {
  const out = [];
  let changed = false;
  for (const s of Array.isArray(stored) ? stored : []) {
    const replacement = s && s.url && directory.sources.find(d => d.replaces === s.url);
    const entry = sourceEntry(replacement ? { kind: 'rss', ...replacement } : s);
    changed = changed || Boolean(replacement) || !entry;
    if (replacement && entry) replaced.set(sid(s), sid(entry));
    if (entry && !out.some(x => sid(x) === sid(entry))) out.push(entry);
  }
  return { list: out, changed };
}

/** The saved view, moved to a replaced source's replacement; "all" if its source is gone. */
function upgradeView(view, replaced) {
  const [kind, id] = splitView(view);
  if (kind !== 'source' && kind !== 'topic') return view;
  if (replaced.has(id)) return `source:${replaced.get(id)}`;
  return sources.some(s => sid(s) === id) ? view : 'all';
}

async function start() {
  const config = getJson('/api/config').catch(() => ({}));
  try {
    directory = await getJson('/api/directory');
  } catch (e) {
    toast('Could not reach the NewsFeed server');
  }
  syncUrl = (await config).syncUrl || null;
  const kept = load(KEY_SYNC, null);
  if (kept && kept.account && kept.account.token && !(kept.account.expiresAt < Date.now())) {
    account = kept.account;
    pending = { ...noChanges(), ...kept.pending };
  } else if (kept && kept.account) {
    store(KEY_SYNC, null);
    if (syncUrl) toast('Your sync sign-in has expired: sign in again to keep syncing');
  }
  const replaced = new Map();
  const clean = cleanSources(load(KEY_SOURCES, []), replaced);
  sources = clean.list;
  if (clean.changed) store(KEY_SOURCES, sources);
  readKeys = new Set(load(KEY_READ, []));
  knownLinks = new Map(load(KEY_LINKS, []).filter(e => Array.isArray(e) && e.length === 2));
  saved = new Map(load(KEY_SAVED, []).filter(a => a && a.key).map(a => [a.key, a]));
  prefs = { ...prefs, ...load(KEY_PREFS, {}) };
  if (!Array.isArray(prefs.langs)) prefs.langs = [];
  if (!Array.isArray(prefs.searchLangs) && Array.isArray(prefs.searchAlso)) {
    prefs.searchLangs = [defaultEdition().split('-')[0], ...prefs.searchAlso];
  }
  delete prefs.searchAlso;
  if (prefs.view === 'web') prefs.view = 'all';
  prefs.view = upgradeView(prefs.view, replaced);

  $('q').addEventListener('input', onQuery);
  $('q').addEventListener('keydown', onQueryKey);
  $('sort').addEventListener('change', () => { prefs.sort = $('sort').value; savePrefs(); renderList(); });
  $('since').addEventListener('change', () => { prefs.since = Number($('since').value); savePrefs(); shown = PAGE; renderList(); });
  $('unread-only').addEventListener('click', () => { prefs.unreadOnly = !prefs.unreadOnly; savePrefs(); shown = PAGE; renderList(); });
  $('mark-all').addEventListener('click', markAllRead);
  $('more').addEventListener('click', () => { shown += PAGE; renderList(); });
  $('refresh').addEventListener('click', () => refresh());
  $('add-source').addEventListener('click', () => openAdd());
  $('add-topic').addEventListener('click', () => openAdd('topic'));
  $('edit-topics').addEventListener('click', () => openEditor('topics'));
  $('edit-sources').addEventListener('click', () => openEditor('sources'));
  $('edit-view').addEventListener('click', () => {
    const s = sourceById(splitView(prefs.view)[1]);
    if (s) openEditOne(s);
  });
  $('toggle-read').addEventListener('click', toggleRead);
  $('toggle-save').addEventListener('click', () => toggleSave());
  $('full-text').addEventListener('click', () => { const a = articleByKey(selectedKey); if (a) loadFullText(a); });
  $('view-site').addEventListener('click', toggleSite);
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
  $('sync').addEventListener('click', showSync);
  // Leaving (another app, a closed tab): changes not sent yet go now; back: the others' come.
  const flush = () => {
    if (!account || !hasChanges(pending)) return;
    saveSync();
    syncNow({ keepalive: true });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else if (Date.now() - lastRefresh > AUTO_REFRESH_MS) refresh();
    else syncNow();
  });
  window.addEventListener('pagehide', flush);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, AUTO_REFRESH_MS);
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, SYNC_EVERY_MS);

  setupPullToRefresh();
  $('text-smaller').addEventListener('click', () => textSize(-1));
  $('text-larger').addEventListener('click', () => textSize(1));
  $('full-screen').addEventListener('click', () => setFullRead(!fullRead));
  textSize(0);
  render();
  renderSyncButton();
  refresh();
}

start();
