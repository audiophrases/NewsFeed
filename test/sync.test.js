'use strict';

// The sync worker (sync/worker.mjs) end to end: sign-in, then devices syncing one account, each
// account's data in a real SQLite database shaped like a Durable Object's storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

let worker, SyncUser, LIMITS, signToken;
test.before(async () => {
  ({ default: worker, SyncUser, LIMITS, signToken } = await import('../sync/worker.mjs'));
});

/** A Durable Object's ctx.storage.sql, over node:sqlite. */
function sqlStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...params) {
      const rows = db.prepare(query).all(...params);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
}

/** The worker's env: settings, and one SyncUser per account name, as Durable Objects are. */
function makeEnv(settings = {}) {
  const accounts = new Map();
  return {
    GOOGLE_CLIENT_ID: 'client-1.apps.googleusercontent.com',
    SESSION_KEY: 'test-secret',
    accounts,
    USERS: {
      idFromName: name => name,
      get: id => ({
        fetch: (url, init) => {
          if (!accounts.has(id)) accounts.set(id, new SyncUser({ storage: { sql: sqlStorage() } }));
          return accounts.get(id).fetch(new Request(url, init));
        },
      }),
    },
    ...settings,
  };
}

/** Google's tokeninfo, standing in: tokens are "good:<email>", or anything else (refused). */
const realFetch = global.fetch;
test.beforeEach(() => {
  global.fetch = async url => {
    const token = new URL(url).searchParams.get('id_token');
    if (!new URL(url).href.startsWith('https://oauth2.googleapis.com/tokeninfo') || !token.startsWith('good:')) {
      return new Response('{"error":"invalid_token"}', { status: 400 });
    }
    const [, email, aud = 'client-1.apps.googleusercontent.com'] = token.split(':');
    return Response.json({ aud, iss: 'https://accounts.google.com', email, email_verified: 'true', name: 'Ana Pérez' });
  };
});
test.afterEach(() => { global.fetch = realFetch; });

async function call(env, path, body, token) {
  const res = await worker.fetch(new Request('https://sync.example' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const login = async (env, email) => (await call(env, '/login', { googleIdToken: 'good:' + email })).body.token;

test('signing in: a verified Google account for this client gets a token', async () => {
  const env = makeEnv();
  const ok = await call(env, '/login', { googleIdToken: 'good:ana@example.com' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, 'ana@example.com');
  assert.ok(ok.body.expiresAt > Date.now() + 100 * 86400e3, 'lasts months');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');

  assert.equal((await call(env, '/login', { googleIdToken: 'forged' })).status, 401);
  assert.equal((await call(env, '/login', { googleIdToken: 'good:ana@example.com:another-client' })).status, 401,
      'a token made for another Google client is refused');
  assert.equal((await call(env, '/config')).body.googleClientId, 'client-1.apps.googleusercontent.com');
  assert.equal((await call(makeEnv({ SESSION_KEY: '' }), '/login', { googleIdToken: 'good:a@b.cc' })).status, 503);
});

test('ALLOWED_EMAILS: listed addresses and domains only; unlisting signs out', async () => {
  const env = makeEnv({ ALLOWED_EMAILS: 'ana@example.com, school.cat' });
  assert.equal((await call(env, '/login', { googleIdToken: 'good:ana@example.com' })).status, 200);
  assert.equal((await call(env, '/login', { googleIdToken: 'good:pupil@school.cat' })).status, 200);
  const refused = await call(env, '/login', { googleIdToken: 'good:someone@example.com' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /someone@example\.com can’t sync/);

  const token = await login(env, 'pupil@school.cat');
  assert.equal((await call(env, '/sync', { since: 0 }, token)).status, 200);
  env.ALLOWED_EMAILS = 'ana@example.com';
  assert.equal((await call(env, '/sync', { since: 0 }, token)).status, 401);
});

test('syncing needs a token this worker signed, still valid', async () => {
  const env = makeEnv();
  const token = await login(env, 'ana@example.com');
  assert.equal((await call(env, '/sync', { since: 0 })).status, 401);
  assert.equal((await call(env, '/sync', { since: 0 }, token.slice(0, -2) + 'xx')).status, 401, 'tampered');
  const other = await signToken('another-secret', { aud: 'newsfeed-sync', email: 'ana@example.com', exp: 2e9 });
  assert.equal((await call(env, '/sync', { since: 0 }, other)).status, 401, 'signed elsewhere');
  const old = await signToken('test-secret', { aud: 'newsfeed-sync', email: 'ana@example.com', exp: 1 });
  assert.equal((await call(env, '/sync', { since: 0 }, old)).status, 401, 'expired');
});

test('two devices: each gets what the other changed, the latest change of each thing wins', async () => {
  const env = makeEnv();
  const token = await login(env, 'ana@example.com');
  const sync = async body => (await call(env, '/sync', body, token)).body;
  const sources = [{ kind: 'rss', url: 'https://a.example/feed', name: 'A' }];
  const article = { key: 'a.example/2', title: 'Two' };

  // The laptop signs in first: everything it has goes up; nothing comes back that it sent.
  const laptop = await sync({ since: 0, sources: { list: sources, base: 0 },
    read: [['a.example/1', 1, 1], ['a.example/3', 1, 1]], saved: [['a.example/2', article, 50]] });
  assert.deepEqual(laptop, { version: 1, full: true, sources: null, sourcesVersion: 1, read: [], saved: [] });

  // The phone signs in: it gets it all, and its own read mark joins.
  const phone = await sync({ since: 0, read: [['b.example/9', 1, 1]] });
  assert.equal(phone.version, 2);
  assert.deepEqual(phone.sources, { list: sources, v: 1 });
  assert.deepEqual(phone.read.sort(), [['a.example/1', 1, 1], ['a.example/3', 1, 1]]);
  assert.deepEqual(phone.saved, [['a.example/2', article, 50]]);

  // The phone marks one unread and unsaves; the laptop's next sync gets just those and the new mark.
  assert.deepEqual(await sync({ since: 2, read: [['a.example/1', 0, 200]], saved: [['a.example/2', null, 200]] }),
      { version: 3, full: false, sources: null, sourcesVersion: 1, read: [], saved: [] });
  const later = await sync({ since: 1 });
  assert.equal(later.version, 3);
  assert.deepEqual(later.read.sort(), [['a.example/1', 0, 200], ['b.example/9', 1, 1]]);
  assert.deepEqual(later.saved, [['a.example/2', null, 200]]);

  // An older change (a device that was offline) loses, and the device gets the newer state back.
  const stale = await sync({ since: 3, read: [['a.example/1', 1, 150]] });
  assert.deepEqual(stale.read, [['a.example/1', 0, 200]]);
  assert.deepEqual(await sync({ since: stale.version }),
      { version: stale.version, full: false, sources: null, sourcesVersion: 1, read: [], saved: [] },
      'nothing new: nothing comes back');
});

test('the source list: kept only if made from the account’s current one, else the device gets that', async () => {
  const env = makeEnv();
  const token = await login(env, 'ana@example.com');
  const sync = async body => (await call(env, '/sync', body, token)).body;
  const laptops = [{ kind: 'topic', q: 'climate' }];
  const phones = [{ kind: 'topic', q: 'housing' }];
  assert.equal((await sync({ since: 0, sources: { list: laptops, base: 0 } })).sourcesVersion, 1);

  // The phone made its list without knowing the laptop's: refused, it gets the laptop's to merge.
  const refused = await sync({ since: 0, sources: { list: phones, base: 0 } });
  assert.deepEqual(refused.sources, { list: laptops, v: 1 });
  assert.equal(refused.version, 1, 'nothing stored');
  const merged = await sync({ since: 1, sources: { list: [...laptops, ...phones], base: 1 } });
  assert.deepEqual([merged.sources, merged.sourcesVersion], [null, 2], 'kept: the phone has it');

  // The laptop, still on version 1, gets the merged list; its own edit from version 1 is refused.
  assert.deepEqual((await sync({ since: 1 })).sources, { list: [...laptops, ...phones], v: 2 });
  assert.deepEqual((await sync({ since: 2, sources: { list: [], base: 1 } })).sources, { list: [...laptops, ...phones], v: 2 });
});

test('a device that knows a version the account doesn’t gets everything', async () => {
  const env = makeEnv();
  const token = await login(env, 'ana@example.com');
  await call(env, '/sync', { since: 0, read: [['k', 1, 5]] }, token);
  const body = (await call(env, '/sync', { since: 99 }, token)).body;
  assert.equal(body.full, true);
  assert.deepEqual(body.read, [['k', 1, 5]]);
});

test('each account is its own; bad entries are skipped; accounts stay within their limits', async () => {
  const env = makeEnv();
  const ana = await login(env, 'ana@example.com');
  const ben = await login(env, 'ben@example.com');
  await call(env, '/sync', { since: 0, read: [['x', 1, 1], ['', 1, 1], ['y', 2, 1], ['z'.repeat(700), 1, 1], 'junk'] }, ana);
  assert.deepEqual((await call(env, '/sync', { since: 0 }, ben)).body.read, []);
  assert.deepEqual((await call(env, '/sync', { since: 0 }, ana)).body.read, [['x', 1, 1]]);

  const was = { ...LIMITS };
  try {
    LIMITS.marks = 3;
    LIMITS.saved = 2;
    await call(env, '/sync', { since: 0, read: [1, 2, 3, 4, 5].map(i => [`m${i}`, 1, 100 + i]),
      saved: [['s1', null, 300], ['s2', { key: 's2' }, 100], ['s3', { key: 's3' }, 200]] }, ben);
    const all = (await call(env, '/sync', { since: 0 }, ben)).body;
    assert.deepEqual(all.read.map(r => r[0]).sort(), ['m3', 'm4', 'm5'], 'the newest marks stay');
    assert.deepEqual(all.saved.map(r => r[0]).sort(), ['s2', 's3'], 'a removal goes before saved articles');
  } finally {
    Object.assign(LIMITS, was);
  }
});
