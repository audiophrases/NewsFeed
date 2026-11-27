// NewsFeed in the NewsFeed app (android/): no server. The app serves this page from inside itself
// and can read any site (a web page can't: browsers keep sites apart), so the API the server runs
// for the browser (lib/api.js) runs here, on the phone, with the same code, and the app fetches
// what it asks for. On the web this file does nothing; there the server answers /api/….
'use strict';

/**
 * In the app, a promise of { fetch(url, init), iconUrl(origin) }: the API's answer to a request
 * for /api/… (as a Response), and a site's icon (an address for an <img>, or null). Elsewhere null.
 */
const localApi = (() => {
  /** Where the NewsFeed app serves this page from. */
  const APP_ORIGIN = 'https://appassets.androidplatform.net';
  if (location.origin !== APP_ORIGIN) return null;

  async function start() {
    const config = await fetch('/app/config.json', { cache: 'no-store' }).then(r => r.json());
    moveOldData(config);
    const [require, directory] = await Promise.all([loadModules(['lib/api.js', 'lib/web.js']),
      fetch('/sources.json').then(r => r.json())]);
    const web = require('lib/web.js');
    const api = require('lib/api.js').createApi({
      fetcher: phoneFetcher(config.token, web),
      directory,
      env: { SYNC_URL: config.syncUrl || '' },
      gunzip,
      warn: text => console.warn(text),
    });

    async function apiFetch(url, init = {}) {
      const result = await api.handle((init.method || 'GET').toUpperCase(), new URL(url, location.href), init.body);
      if (!result) return fetch(url, init);
      if (result.json !== undefined) {
        return new Response(JSON.stringify(result.json), { status: result.status, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(result.bytes || null, { status: result.status, headers: { 'Content-Type': result.type || 'text/plain' } });
    }

    return { fetch: apiFetch, iconUrl: iconFinder(api) };
  }

  /**
   * What the app had kept when it showed NewsFeed from its server (what you follow, read and saved,
   * and your settings): the app hands it over once, and it's kept here unless this page already
   * has its own.
   */
  function moveOldData(config) {
    if (!config.moved) return;
    try {
      for (const [key, value] of Object.entries(config.moved)) {
        if (key.startsWith('newsfeed.') && typeof value === 'string' && localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
        }
      }
    } catch (e) {
      return; // storage unavailable: the app offers it again next time
    }
    fetch('/app/moved', { headers: { 'X-NewsFeed': config.token }, cache: 'no-store' }).catch(() => {});
  }

  // ---- the server's modules, here ----------------------------------------------------------

  /** A module's address in the app (which serves public/ as its root, and lib/ under /lib/). */
  const moduleUrl = path => '/' + path.replace(/^public\//, '');

  /** A module's path (as in the repository: lib/api.js) from the module that requires it. */
  function resolveModule(from, spec) {
    const parts = from.split('/').slice(0, -1);
    for (const part of spec.split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    }
    const path = parts.join('/');
    return /\.(js|json)$/.test(path) ? path : path + '.js';
  }

  /**
   * The server's CommonJS modules (lib/), loaded with every module they require: a require() for
   * them. Only modules that need nothing of Node's can come; these do.
   */
  async function loadModules(roots) {
    const texts = new Map();
    let wave = roots;
    while (wave.length) {
      const got = await Promise.all(wave.map(path => fetch(moduleUrl(path)).then(r => {
        if (!r.ok) throw new Error(`${path} isn’t in the app`);
        return r.text();
      })));
      const next = [];
      wave.forEach((path, i) => {
        texts.set(path, got[i]);
        for (const [, spec] of got[i].matchAll(/\brequire\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
          const dep = resolveModule(path, spec);
          if (!texts.has(dep) && !wave.includes(dep) && !next.includes(dep)) next.push(dep);
        }
      });
      wave = next;
    }
    const modules = new Map();
    function requireModule(path) {
      if (modules.has(path)) return modules.get(path).exports;
      if (!texts.has(path)) throw new Error(`${path} isn’t in the app`);
      const module = { exports: {} };
      modules.set(path, module);
      // The app's own files, each run as a module of its own.
      new Function('module', 'exports', 'require', `${texts.get(path)}\n//# sourceURL=${location.origin}${moduleUrl(path)}`)(
          module, module.exports, spec => {
            if (!/^\.{1,2}\//.test(spec)) throw new Error(`${spec} isn’t available in the app`);
            return requireModule(resolveModule(path, spec));
          });
      return module.exports;
    }
    return requireModule;
  }

  // ---- fetching, by the phone --------------------------------------------------------------

  /**
   * The phone's fetching, for lib/api.js: the same answers and errors as the server's
   * (lib/fetch.js), from the app, which fetches as the phone's browser does (with its cookies)
   * without browsers' rule that a page may only read its own site. token: the app's word that
   * the request is NewsFeed's own.
   */
  function phoneFetcher(token, web) {
    const { MAX_BYTES, FetchError, decoderFor, frameAllowed, statusError, postError, reason } = web;

    /** A request the app makes: { status, url, headers, bytes } (url: the address after redirects). */
    async function viaPhone(url, { method = 'GET', body = null, headers = {}, max = MAX_BYTES, follow = true } = {}) {
      const ask = new URLSearchParams({
        url, method, max: String(max), follow: follow ? '1' : '0',
        headers: JSON.stringify({ 'Accept-Language': 'en,*;q=0.5', ...headers }),
      });
      if (body !== null) ask.set('body', body);
      const res = await fetch('/app/net?' + ask, { headers: { 'X-NewsFeed': token }, cache: 'no-store' });
      if (!res.ok) throw new FetchError(`The app wouldn’t fetch it (HTTP ${res.status})`);
      // The app's answer: a line of JSON about the response, then its bytes.
      const all = new Uint8Array(await res.arrayBuffer());
      const end = all.indexOf(10);
      const meta = JSON.parse(new TextDecoder().decode(end < 0 ? all : all.subarray(0, end)));
      if (meta.error) {
        const error = new FetchError(meta.error);
        if (meta.timeout) error.name = 'TimeoutError';
        error.requestUrl = meta.url || url;
        throw error;
      }
      const names = meta.headers || {};
      return {
        status: meta.status, url: meta.url || url, bytes: end < 0 ? new Uint8Array(0) : all.subarray(end + 1),
        headers: { get: name => names[name.toLowerCase()] ?? null },
      };
    }

    const ok = status => status >= 200 && status < 300;

    async function getText(url, headers, maxBytes = MAX_BYTES) {
      const r = await viaPhone(url, { headers, max: maxBytes });
      if (!ok(r.status)) throw statusError(r.status, r.headers, r.url);
      return {
        text: decoderFor(r.bytes, r.headers).decode(r.bytes), url: r.url, type: r.headers.get('content-type') || '',
        frameable: frameAllowed(r.headers),
      };
    }

    async function getBytes(url, headers, maxBytes) {
      const r = await viaPhone(url, { headers, max: maxBytes + 1 });
      if (!ok(r.status)) throw statusError(r.status, r.headers, r.url);
      if (r.bytes.length > maxBytes) return null;
      return { bytes: r.bytes, url: r.url, type: r.headers.get('content-type') || '' };
    }

    async function postText(url, body, headers = {}) {
      const r = await viaPhone(url, {
        method: 'POST', body, follow: false,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', ...headers },
      });
      if (!ok(r.status)) throw postError(r.status, r.headers, url);
      return new TextDecoder().decode(r.bytes).slice(0, MAX_BYTES);
    }

    return { getText, getBytes, postText, reason, FetchError };
  }

  /** A gzipped file's bytes, unpacked. */
  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---- icons -------------------------------------------------------------------------------

  /** How long a site's icon is kept, and how long that it has none (as the server's answers say). */
  const ICON_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
  const NO_ICON_KEEP_MS = 24 * 60 * 60 * 1000;

  /**
   * Sites' icons, kept on the phone (as a browser keeps the server's), so each is looked for once a
   * week rather than every time the app opens: iconUrl(origin) gives an address for an <img>, or null.
   */
  function iconFinder(api) {
    const found = new Map();
    async function find(origin) {
      const key = `${location.origin}/api/icon?url=${encodeURIComponent(origin)}`;
      let store = null;
      try {
        store = await caches.open('newsfeed-icons');
      } catch (e) {
        // not kept, then
      }
      let hit = store && await store.match(key).catch(() => null);
      const keep = hit && (hit.ok ? ICON_KEEP_MS : NO_ICON_KEEP_MS);
      if (hit && !(Date.now() - Number(hit.headers.get('X-Kept-At')) < keep)) hit = null;
      if (!hit) {
        const icon = await api.handle('GET', new URL(key));
        hit = new Response(icon.status === 200 ? icon.bytes : null, {
          status: icon.status === 200 ? 200 : 404,
          headers: { 'Content-Type': icon.type || 'text/plain', 'X-Kept-At': String(Date.now()) },
        });
        if (store) await store.put(key, hit.clone()).catch(() => {});
      }
      return hit.ok ? URL.createObjectURL(await hit.blob()) : null;
    }
    return origin => {
      if (!found.has(origin)) found.set(origin, find(origin).catch(() => null));
      return found.get(origin);
    };
  }

  return start();
})();
