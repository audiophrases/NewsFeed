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

const sid = s => (s.kind === 'topic' ? `topic|${s.lang}-${s.country}|${s.q.toLowerCase()}` : 'rss|' + s.url);
const sourceById = id => sources.find(s => sid(s) === id) || (webSearch && sid(webSearch) === id ? webSearch : null);

function apiUrl(s) {
  if (s.kind === 'topic') {
    return `/api/search?q=${encodeURIComponent(s.q)}&lang=${s.lang}&country=${s.country}`;
  }
  return `/api/feed?url=${encodeURIComponent(s.url)}`;
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
    loaded.set(id, { items: feed.items, title: feed.title, language: feed.language, error: null, at: Date.now() });
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

const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
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
        sourceName: item.publisher || s.name, country: item.publisher ? null : s.country,
        lang: s.lang || got.language || null,
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
      sourceName: item.publisher || webSearch.name, country: null, lang: webSearch.lang,
    };
  });
}

const articleByKey = key => byKey.get(key) || saved.get(key) || webArticles().find(a => a.key === key) || null;

// ---- search and filters ------------------------------------------------------------------

/** "climate -sport "north sea"" -> include [climate, north sea], exclude [sport]. */
function parseQuery(q) {
  const include = [], exclude = [];
  for (const m of (q || '').matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const neg = m[1] || m[3];
    const term = fold(m[2] || m[4]);
    if (!term || /^(or|and)$/.test(term) || /^(when|site|intitle|source):/.test(term)) continue;
    (neg ? exclude : include).push(term);
  }
  return { include, exclude };
}

const haystack = a => fold([a.title, a.summary, a.author, a.sourceName, ...a.categories].join(' \n '));

function matches(a, query) {
  if (!query.include.length && !query.exclude.length) return true;
  const text = haystack(a);
  return query.include.every(t => text.includes(t)) && !query.exclude.some(t => text.includes(t));
}

function score(a, query) {
  const title = fold(a.title), rest = haystack(a);
  return query.include.reduce((n, t) => n + (title.includes(t) ? 3 : 0) + (rest.includes(t) ? 1 : 0), 0);
}

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
  if (kind === 'source') li.firstChild.replaceWith(flag(s.country));
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
    li.title = kind === 'topic' ? `${s.q} · ${s.lang}-${s.country}` : s.url;
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
  if (a.country) meta.append(flag(a.country));
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
  for (const t of query.include) {
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
    const got = kind === 'web' || kind === 'source' || kind === 'topic' ? loaded.get(splitView(prefs.view)[1] || sid(webSearch)) : null;
    empty.append(el('p', '', got && got.error ? `Could not load: ${got.error}` : kind === 'unread' ? 'All caught up.' : 'No articles yet.'));
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
  if (a.country) meta.append(flag(a.country));
  meta.append(el('strong', '', a.sourceName));
  if (a.author && a.author !== a.sourceName) meta.append(el('span', '', a.author));
  if (a.publishedAt) {
    const time = el('time', '', new Date(a.publishedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
    time.dateTime = new Date(a.publishedAt).toISOString();
    time.title = age(a.publishedAt);
    meta.append(time);
  }
  const parts = [meta, el('h2', '', a.title)];
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
  else if (prefs.fullText && a.link && canFetch(a.link)) loadFullText(a);
  else readerActions(a, a.link && !canFetch(a.link) ? 'This outlet’s full text is not available here.' : '');
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

function readerActions(a, message) {
  const note = $('reader-note');
  if (!note) return;
  note.replaceChildren();
  if (message) note.append(el('p', '', message));
  const actions = el('div', 'actions');
  if (a.link) {
    const open = el('a', 'primary', 'Read on ' + (hostOf(a.link) || 'the site'));
    open.href = a.link;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    actions.append(open);
  }
  if (a.link && canFetch(a.link) && !fullTexts.has(a.key)) {
    actions.append(button('primary subtle', 'Load full text', () => loadFullText(a)));
  }
  note.append(actions);
}

const hostOf = link => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

async function loadFullText(a) {
  if (!a.link || !canFetch(a.link)) return;
  const note = $('reader-note');
  if (note) note.replaceChildren(el('p', '', 'Loading the full article…'));
  let result;
  try {
    result = await getJson(`/api/article?url=${encodeURIComponent(a.link)}`);
  } catch (e) {
    if (selectedKey === a.key) readerActions(a, `Couldn’t load the full article (${e.message}).`);
    return;
  }
  fullTexts.set(a.key, result);
  if (selectedKey === a.key) showFullText(a, result);
}

function showFullText(a, result) {
  const text = $('reader-text');
  // Only replace the feed's summary with something longer.
  const summaryLength = (a.summary || '').length;
  const fullLength = result.blocks.reduce((n, b) => n + b.text.length, 0);
  if (!text || fullLength < Math.max(300, summaryLength * 1.2)) {
    readerActions(a, 'The site didn’t share more than this summary.');
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
  const minutes = Math.max(1, Math.round(result.words / 230));
  readerActions(a, `Full text from ${result.site} · ${minutes} min read`);
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
  const entry = s.kind === 'topic'
      ? { kind: 'topic', q: s.q, lang: s.lang, country: s.country, name: s.name || s.q }
      : { kind: 'rss', url: s.url, name: s.name, lang: s.lang || null, country: s.country || null };
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

function showGroups() {
  addMode = null;
  setStep('Add sources', null, false);
  const have = new Set(sources.map(sid));
  $('add-body').replaceChildren(
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
    name.append(el('span', 'detail', following ? 'Following' : hostOf(s.url)));
    row.append(box, flag(s.country), name);
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

function showTopicForm(q = '') {
  addMode = 'topic';
  setStep('Follow a topic', 'Follow', true);
  const form = el('div', 'form');
  const input = dialogInput('text', 'topic-q', 'e.g. climate, "champions league", AI -crypto', previewTopic);
  input.value = typeof q === 'string' ? q : '';
  const edition = document.createElement('select');
  edition.id = 'topic-edition';
  edition.setAttribute('aria-label', 'News edition');
  for (const [code, name] of EDITIONS) edition.append(new Option(name, code));
  edition.value = defaultEdition();
  const help = el('p', 'help', 'Headlines about this from outlets everywhere, via Google News. '
      + 'Use quotes for exact phrases and - to leave words out. Press Enter to preview.');
  help.id = 'topic-help';
  const preview = el('ul', 'preview');
  preview.id = 'topic-preview';
  form.append(input, edition, help);
  $('add-body').replaceChildren(form, preview);
  input.focus();
}

let previewRequest = 0;

function topicFromForm() {
  const q = $('topic-q').value.trim();
  if (!q) return null;
  const [lang, country] = $('topic-edition').value.split('-');
  return { kind: 'topic', q, lang, country, name: q };
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
    $('topic-help').textContent = feed.items.length ? `${feed.items.length} recent articles, for example:` : 'No news found for this right now.';
    $('topic-preview').replaceChildren(...feed.items.slice(0, 6).map(item => {
      const li = el('li', '', item.title);
      li.append(el('div', 'detail', [item.publisher, item.publishedAt ? age(item.publishedAt) : ''].filter(Boolean).join(' · ')));
      return li;
    }));
  } catch (e) {
    if (request === previewRequest) $('topic-help').textContent = `Search failed: ${e.message}`;
  }
}

function showAddressForm() {
  addMode = 'address';
  setStep('Website or feed', 'Find feeds', true);
  const form = el('div', 'form');
  const input = dialogInput('url', 'address', 'https://example.com or a feed address', discoverFeeds);
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
  addCandidates = found.map(f => ({ kind: 'rss', url: f.url, name: f.title || hostOf(f.url), lang: f.language, country: guessCountry(f.url, f.language) }));
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

/** A flag for a feed outside the directory, from its country domain (as Play the News does). */
function guessCountry(url, lang) {
  const tld = hostOf(url).split('.').pop();
  const flags = ['at', 'au', 'be', 'ca', 'ch', 'de', 'es', 'fr', 'gb', 'ie', 'in', 'it', 'mx', 'nl', 'nz', 'pt', 'qa', 'us'];
  if (tld === 'cat' || lang === 'ca') return 'es-ct';
  if (tld === 'uk') return 'gb';
  return flags.includes(tld) ? tld : null;
}

async function confirmAdd() {
  if (addMode === 'group' || addMode === 'found') {
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
  else showGroups();
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
    list = (Array.isArray(data) ? data : data.sources || []).filter(s => s && (s.kind === 'topic' ? s.q : s.url));
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
    const entry = s.kind === 'topic'
        ? { kind: 'topic', q: s.q, lang: s.lang || 'en', country: s.country || 'US', name: s.name || s.q }
        : { kind: 'rss', url: s.url, name: s.name || hostOf(s.url), lang: s.lang || null, country: s.country || guessCountry(s.url) };
    if (sources.some(x => sid(x) === sid(entry))) continue;
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

async function start() {
  try {
    directory = await getJson('/api/directory');
  } catch (e) {
    toast('Could not reach the NewsFeed server');
  }
  sources = load(KEY_SOURCES, []).filter(s => s && (s.kind === 'topic' ? s.q && s.lang && s.country : s.url && s.name));
  readKeys = new Set(load(KEY_READ, []));
  saved = new Map(load(KEY_SAVED, []).filter(a => a && a.key).map(a => [a.key, a]));
  prefs = { ...prefs, ...load(KEY_PREFS, {}) };
  if (!Array.isArray(prefs.langs)) prefs.langs = [];
  if (prefs.view === 'web') prefs.view = 'all';

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
