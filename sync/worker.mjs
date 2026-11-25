// NewsFeed sync: the same sources and topics, read marks and saved articles on every device you
// sign in on. Sign-in is PinPlay's Google sign-in (the same Google OAuth client, so Google shows
// PinPlay's name), but nothing here touches PinPlay or its roster: this worker checks Google's
// token itself, as PinPlay's does, and keeps each account's data in a Durable Object of its own.
//
// Settings (see the README, "Sync between devices"):
//   GOOGLE_CLIENT_ID  PinPlay's OAuth client ID (wrangler.toml; public, PinPlay's page shows it)
//   SESSION_KEY       secret: signs NewsFeed's own sign-in tokens (openssl rand -hex 32)
//   ALLOWED_EMAILS    secret, optional: who may sync, addresses or bare domains, comma-separated;
//                     unset, any Google account may

/** How long a sign-in lasts on a device. */
const TOKEN_DAYS = 180;
const MAX_BODY = 4 * 1024 * 1024;
/** Most read marks and saved articles kept per account (the oldest changes go first). */
export const LIMITS = { marks: 10000, saved: 2000, key: 600, article: 20000, sources: 300000 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

const failure = (status, message) => Object.assign(new Error(message), { status });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/config' && request.method === 'GET') {
        return reply({ googleClientId: env.GOOGLE_CLIENT_ID || '', ready: Boolean(env.GOOGLE_CLIENT_ID && env.SESSION_KEY) });
      }
      if (request.method !== 'POST' || !['/login', '/sync'].includes(url.pathname)) return reply({ error: 'Not found' }, 404);
      if (Number(request.headers.get('Content-Length')) > MAX_BODY) return reply({ error: 'Too much to sync at once' }, 413);
      const raw = await request.text();
      if (raw.length > MAX_BODY) return reply({ error: 'Too much to sync at once' }, 413);
      if (!env.GOOGLE_CLIENT_ID || !env.SESSION_KEY) return reply({ error: 'Sync isn’t set up on this server yet' }, 503);

      if (url.pathname === '/login') {
        const who = await verifyGoogle(JSON.parse(raw || '{}').googleIdToken, env.GOOGLE_CLIENT_ID);
        if (!who) return reply({ error: 'Google sign-in could not be verified. Please try again.' }, 401);
        if (!allowed(who.email, env.ALLOWED_EMAILS)) {
          return reply({ error: `${who.email} can’t sync on this NewsFeed.`, reason: 'not-allowed' }, 403);
        }
        const exp = Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400;
        const token = await signToken(env.SESSION_KEY, { aud: 'newsfeed-sync', email: who.email, name: who.name, exp });
        return reply({ token, email: who.email, name: who.name, expiresAt: exp * 1000 });
      }

      const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const claim = await readToken(env.SESSION_KEY, bearer);
      // Taking an address off ALLOWED_EMAILS signs it out everywhere.
      if (!claim || !allowed(claim.email, env.ALLOWED_EMAILS)) {
        return reply({ error: 'Sign in again to keep syncing.', reason: 'signin' }, 401);
      }
      const account = env.USERS.get(env.USERS.idFromName(claim.email));
      const res = await account.fetch('https://account/sync', { method: 'POST', body: raw });
      return reply(await res.json(), res.status);
    } catch (e) {
      if (e instanceof SyntaxError) return reply({ error: 'Not JSON' }, 400);
      console.error(e);
      return reply({ error: 'The sync service failed' }, 500);
    }
  },
};

/** One account's sources, read marks and saved articles, in its own SQLite database. */
export class SyncUser {
  constructor(state) {
    this.sql = state.storage.sql;
    setup(this.sql);
  }

  async fetch(request) {
    try {
      return Response.json(syncAccount(this.sql, JSON.parse(await request.text())));
    } catch (e) {
      return Response.json({ error: e.status ? e.message : 'The sync service failed' }, { status: e.status || 500 });
    }
  }
}

// ---- an account's data -------------------------------------------------------------------
//
// Every change carries the time it was made on its device; the latest change of each read mark,
// saved article and of the source list wins. Each stored change also carries the account version
// it arrived in, so a device that has everything up to version N gets only what changed after.

export function setup(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS marks (key TEXT PRIMARY KEY, state INTEGER NOT NULL, at INTEGER NOT NULL, v INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS marks_v ON marks (v)');
  sql.exec('CREATE TABLE IF NOT EXISTS saved (key TEXT PRIMARY KEY, article TEXT, at INTEGER NOT NULL, v INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS saved_v ON saved (v)');
}

/**
 * One device's sync: { since, sources?: { list, base }, read?: [[key, 1|0, at]], saved?: [[key,
 * article|null, at]] } -> what changed after `since` (or everything, full, when since is 0 or
 * unknown here), leaving out what this device just sent and the account kept.
 *
 * The source list is one list two devices may both edit, so it isn't "latest wins": a device's
 * list is kept only if it was made from the account's current one (base: the version the device
 * last had). Otherwise the device gets the account's list back, merges its changes into it and
 * sends that.
 */
export function syncAccount(sql, body) {
  const meta = name => {
    const row = sql.exec('SELECT value FROM meta WHERE name = ?', name).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  };
  const setMeta = (name, value) => sql.exec('INSERT INTO meta (name, value) VALUES (?, ?) '
      + 'ON CONFLICT(name) DO UPDATE SET value = excluded.value', name, JSON.stringify(value));
  const version = meta('version') || 0;
  const next = version + 1;
  const since = Number.isSafeInteger(body.since) && body.since > 0 && body.since <= version ? body.since : 0;
  let changed = false;

  let stored = meta('sources');
  let sourcesRefused = false;
  const s = body.sources;
  if (s && Array.isArray(s.list)) {
    if (JSON.stringify(s.list).length > LIMITS.sources) throw failure(413, 'Too many sources to sync');
    if (s.base === (stored ? stored.v : 0)) {
      stored = { list: s.list, v: next };
      setMeta('sources', stored);
      changed = true;
    } else {
      sourcesRefused = true; // changed on another device since: this one merges and sends again
    }
  }

  // A change older than the account's (a device offline, or with its clock behind) is refused,
  // and the device gets the account's state back with the rest.
  const refusedMarks = [], refusedSaved = [];
  for (const [key, state, at] of rows(body.read)) {
    if (!validKey(key) || (state !== 0 && state !== 1) || !Number.isFinite(at)) continue;
    const kept = sql.exec('INSERT INTO marks (key, state, at, v) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET '
        + 'state = excluded.state, at = excluded.at, v = excluded.v WHERE excluded.at > marks.at RETURNING key',
        key, state, Math.round(at), next).toArray().length;
    if (kept) changed = true;
    else refusedMarks.push(key);
  }
  for (const [key, article, at] of rows(body.saved)) {
    if (!validKey(key) || !Number.isFinite(at)) continue;
    const text = article && typeof article === 'object' && !Array.isArray(article) ? JSON.stringify(article) : null;
    if (text && text.length > LIMITS.article) continue;
    const kept = sql.exec('INSERT INTO saved (key, article, at, v) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET '
        + 'article = excluded.article, at = excluded.at, v = excluded.v WHERE excluded.at > saved.at RETURNING key',
        key, text, Math.round(at), next).toArray().length;
    if (kept) changed = true;
    else refusedSaved.push(key);
  }

  if (changed) {
    setMeta('version', next);
    prune(sql);
  }
  // Rows at version `next` are exactly what this request stored: the device has them already.
  const mine = changed ? next : -1;
  const changes = (table, refused) => {
    const list = sql.exec(`SELECT * FROM ${table} WHERE v > ? AND v != ?`, since, mine).toArray();
    const have = new Set(list.map(r => r.key));
    for (const key of refused) {
      if (!have.has(key)) list.push(...sql.exec(`SELECT * FROM ${table} WHERE key = ?`, key).toArray());
      have.add(key);
    }
    return list;
  };
  return {
    version: changed ? next : version,
    full: since === 0,
    sources: stored && ((stored.v > since && stored.v !== mine) || sourcesRefused) ? { list: stored.list, v: stored.v } : null,
    // The version of the account's list (the base of this device's next one, if it just sent it).
    sourcesVersion: stored ? stored.v : 0,
    read: changes('marks', refusedMarks).map(r => [r.key, r.state, r.at]),
    saved: changes('saved', refusedSaved).map(r => [r.key, r.article ? JSON.parse(r.article) : null, r.at]),
  };
}

const rows = list => (Array.isArray(list) ? list.filter(Array.isArray) : []);
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= LIMITS.key;

/** Keeps an account within LIMITS: the oldest changes go, removed saved articles before kept ones. */
function prune(sql) {
  const marks = sql.exec('SELECT COUNT(*) AS n FROM marks').one().n;
  if (marks > LIMITS.marks) {
    sql.exec('DELETE FROM marks WHERE key IN (SELECT key FROM marks ORDER BY at LIMIT ?)', marks - LIMITS.marks);
  }
  const saved = sql.exec('SELECT COUNT(*) AS n FROM saved').one().n;
  if (saved > LIMITS.saved) {
    sql.exec('DELETE FROM saved WHERE key IN (SELECT key FROM saved ORDER BY article IS NOT NULL, at LIMIT ?)',
        saved - LIMITS.saved);
  }
}

// ---- sign-in -----------------------------------------------------------------------------

/**
 * A Google ID token's verified address and name, or null. Google's tokeninfo checks the
 * signature and expiry; the audience is pinned to the client ID, as PinPlay's worker does.
 */
export async function verifyGoogle(idToken, clientId) {
  const token = String(idToken || '').trim();
  if (!token || token.length > 8192 || !clientId) return null;
  try {
    const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
    if (!res.ok) return null;
    const p = await res.json();
    if (p.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) return null;
    if (p.email_verified !== true && p.email_verified !== 'true') return null;
    const email = String(p.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { email, name: String(p.name || '').trim().slice(0, 80) };
  } catch (e) {
    return null;
  }
}

/** Whether an address may sync: listed, or on a listed domain; anyone when nothing is listed. */
export function allowed(email, list) {
  const entries = String(list || '').toLowerCase().split(/[\s,;]+/).map(e => e.replace(/^@/, '')).filter(Boolean);
  if (!entries.length) return true;
  const domain = email.slice(email.indexOf('@') + 1);
  return entries.some(e => (e.includes('@') ? e === email : e === domain));
}

const encoder = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hmacKey = secret => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']);

export async function signToken(secret, claim) {
  const payload = b64url(encoder.encode(JSON.stringify(claim)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

/** A sign-in token's claim if this worker signed it and it hasn't expired, else null. */
export async function readToken(secret, token) {
  const [payload, sig, extra] = String(token || '').split('.');
  if (!secret || !payload || !sig || extra !== undefined) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), encoder.encode(payload)))) return null;
    const claim = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (claim.aud !== 'newsfeed-sync' || typeof claim.email !== 'string' || !(claim.exp > Date.now() / 1000)) return null;
    return claim;
  } catch (e) {
    return null;
  }
}
