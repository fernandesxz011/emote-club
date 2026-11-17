import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createWorker} from '../server.js';
import {hashPassword, verifyPassword, sha256, loginAccount, SESSION_TTL} from '../auth.js';

const origin = 'https://api.emote.test';
const pages = 'https://fernandesxz011.github.io';
const password = 'uma senha longa de teste 2026';
const seed = [{id: '4849499887', name: 'Happy', category: 'Feliz'}];
const credentials = {username: 'Ana_Criativa', displayName: 'Ana do Estúdio', password, remember: false};

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0000_catalog.sql', '0001_personal_library.sql', '0002_password_auth.sql']) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const db = {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { return {results: statement.all(...args)}; },
        async first() { return statement.get(...args) || null; },
        async run() { statement.run(...args); return {success: true}; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return db;
}

function request(path, body, {token, requestOrigin = origin, ip = '203.0.113.10', method, headers = {}} = {}) {
  return new Request(origin + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {'CF-Connecting-IP': ip, ...(requestOrigin === undefined ? {} : {origin: requestOrigin}), ...(body ? {'content-type': 'application/json'} : {}), ...(token ? {authorization: 'Bearer ' + token} : {}), ...headers},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
}

async function register(worker, db, overrides = {}, options = {}) {
  const response = await worker.fetch(request('/api/auth/register', {...credentials, ...overrides}, options), {DB: db});
  assert.equal(response.status, 201);
  return response.json();
}

test('scrypt uses distinct random salts and verifies passwords without storing their plaintext', async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('uma outra senha longa incorreta', first), false);
});

test('registration creates an account, profile and hashed 12-hour session, retaining existing legacy records', async () => {
  const db = database();
  db.sqlite.prepare('INSERT INTO profiles (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('legacy-chatgpt-id', 'Perfil anterior', '2026-01-01', '2026-01-01');
  db.sqlite.prepare('INSERT INTO saved_emotes (user_id, emote_id, saved_at) VALUES (?, ?, ?)').run('legacy-chatgpt-id', seed[0].id, '2026-01-01');
  const worker = createWorker({seed});
  const started = Date.now();
  const result = await register(worker, db);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Math.abs(Date.parse(result.expiresAt) - started - SESSION_TTL.temporary) < 3000);
  assert.equal(result.user.username, 'ana_criativa');
  assert.equal(result.user.name, 'Ana do Estúdio');
  assert.equal(result.user.signedIn, true);
  assert.equal(result.user.storage, 'shared');
  assert.deepEqual(result.user.saved, []);
  const account = db.sqlite.prepare('SELECT * FROM accounts').get();
  assert.match(account.id, /^acct_[a-f0-9-]{36}$/);
  assert.equal(account.username, 'ana_criativa');
  assert.match(account.password_hash, /^scrypt\$/);
  assert.ok(!JSON.stringify(account).includes(password));
  const session = db.sqlite.prepare('SELECT * FROM sessions').get();
  assert.equal(session.token_hash, await sha256(result.token));
  assert.notEqual(session.token_hash, result.token);
  assert.equal(session.expires_at, result.expiresAt);
  assert.equal(db.sqlite.prepare('SELECT display_name FROM profiles WHERE user_id = ?').get('legacy-chatgpt-id').display_name, 'Perfil anterior');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM saved_emotes WHERE user_id = ?').get('legacy-chatgpt-id').count, 1);
  const me = await (await worker.fetch(request('/api/me', null, {token: result.token}), {DB: db})).json();
  assert.deepEqual(me, result.user);
});

test('login returns a fresh remembered session with saved data, and logout revokes only the presented session', async () => {
  const db = database();
  const worker = createWorker({seed});
  const initial = await register(worker, db);
  await worker.fetch(request('/api/saved', {id: seed[0].id, saved: true}, {token: initial.token}), {DB: db});
  const started = Date.now();
  const response = await worker.fetch(request('/api/auth/login', {username: '  ANA_CRIATIVA  ', password, remember: true}), {DB: db});
  assert.equal(response.status, 200);
  const login = await response.json();
  assert.notEqual(login.token, initial.token);
  assert.ok(Math.abs(Date.parse(login.expiresAt) - started - SESSION_TTL.remembered) < 3000);
  assert.equal(login.user.saved.length, 1);
  assert.equal(login.user.saved[0].id, seed[0].id);
  assert.equal(login.user.name, 'Ana do Estúdio');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
  const logout = await worker.fetch(request('/api/auth/logout', {}, {token: initial.token}), {DB: db});
  assert.equal(logout.status, 200);
  const oldMe = await (await worker.fetch(request('/api/me', null, {token: initial.token}), {DB: db})).json();
  const newMe = await (await worker.fetch(request('/api/me', null, {token: login.token}), {DB: db})).json();
  assert.equal(oldMe.signedIn, false);
  assert.equal(newMe.signedIn, true);
  assert.equal(newMe.saved.length, 1);
  db.sqlite.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
  const expired = await (await worker.fetch(request('/api/me', null, {token: login.token}), {DB: db})).json();
  assert.equal(expired.signedIn, false);
  assert.equal((await worker.fetch(request('/api/saved', {id: seed[0].id, saved: false}, {token: login.token}), {DB: db})).status, 401);
});

test('invalid credentials share one generic error, while duplicate usernames are case-insensitively rejected', async () => {
  const db = database();
  const worker = createWorker({seed});
  await register(worker, db);
  const wrong = await worker.fetch(request('/api/auth/login', {username: 'ana_criativa', password: 'senha errada longa 123'}), {DB: db});
  const unknown = await worker.fetch(request('/api/auth/login', {username: 'sem_conta', password: 'senha errada longa 123'}), {DB: db});
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  const duplicate = await worker.fetch(request('/api/auth/register', {...credentials, username: 'ANA_CRIATIVA'}), {DB: db});
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'USERNAME_TAKEN');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
});

test('registration rejects invalid usernames, names, short or oversized passwords and invalid remember values', async () => {
  const db = database();
  const worker = createWorker({seed});
  const invalid = [{username: 'ab'}, {username: 'nome com espaço'}, {username: 'ábc'}, {username: 'a'.repeat(25)}, {displayName: 'A'}, {displayName: 'A'.repeat(51)}, {password: '12345678901'}, {password: 'a'.repeat(129)}, {password: 123456789012}, {remember: 'true'}];
  for (const overrides of invalid) assert.equal((await worker.fetch(request('/api/auth/register', {...credentials, ...overrides}), {DB: db})).status, 400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 0);
});

test('public authentication rejects oversized chunked JSON before database access or password hashing', async () => {
  const worker = createWorker({seed});
  let databaseCalls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"username":"ana","password":"'));
      controller.enqueue(new Uint8Array(13 * 1024).fill(65));
    },
    cancel() { cancelled = true; },
  });
  const oversized = new Request(origin + '/api/auth/register', {method: 'POST', headers: {origin: pages, 'content-type': 'application/json'}, body: stream, duplex: 'half'});
  const response = await worker.fetch(oversized, {DB: {prepare() { databaseCalls++; throw new Error('must not access storage'); }}});
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'BODY_TOO_LARGE');
  assert.equal(response.headers.get('access-control-allow-origin'), pages);
  assert.equal(cancelled, true);
  assert.equal(databaseCalls, 0);
});

test('real account tokens isolate saved libraries and spoofed identity headers do not authorize writes', async () => {
  const db = database();
  const worker = createWorker({seed});
  const ana = await register(worker, db);
  const bruno = await register(worker, db, {username: 'bruno', displayName: 'Bruno'});
  const brunoId = db.sqlite.prepare('SELECT id FROM accounts WHERE username = ?').get('bruno').id;
  await worker.fetch(request('/api/saved', {id: seed[0].id, saved: true, userId: brunoId}, {token: ana.token}), {DB: db});
  const anaMe = await (await worker.fetch(request('/api/me', null, {token: ana.token}), {DB: db})).json();
  const brunoMe = await (await worker.fetch(request('/api/me', null, {token: bruno.token}), {DB: db})).json();
  assert.equal(anaMe.saved.length, 1);
  assert.deepEqual(brunoMe.saved, []);
  const spoofed = await worker.fetch(request('/api/saved', {id: seed[0].id, saved: false}, {headers: {'oai-authenticated-user-id': brunoId, 'oai-authenticated-user-email': 'bruno@example.com'}}), {DB: db});
  assert.equal(spoofed.status, 401);
});

test('login throttling persists across workers and resets after the fixed window', async () => {
  const db = database();
  const first = createWorker({seed});
  const second = createWorker({seed});
  await register(first, db);
  const body = {username: 'ana_criativa', password: 'senha incorreta longa 123'};
  for (let attempt = 0; attempt < 10; attempt++) {
    const worker = attempt % 2 ? first : second;
    assert.equal((await worker.fetch(request('/api/auth/login', body), {DB: db})).status, 401);
  }
  const blocked = await second.fetch(request('/api/auth/login', {username: 'ana_criativa', password}), {DB: db});
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal((await blocked.json()).code, 'RATE_LIMITED');
  const buckets = db.sqlite.prepare('SELECT * FROM auth_rate_limits').all();
  assert.ok(buckets.every(bucket => /^[a-f0-9]{64}$/.test(bucket.bucket_key)));
  assert.ok(!JSON.stringify(buckets).includes('203.0.113.10'));
  const future = Date.now() + 16 * 60 * 1000;
  const recovered = await loginAccount(db, request('/api/auth/login', {}), {username: 'ana_criativa', password}, future);
  assert.match(recovered.token, /^[A-Za-z0-9_-]{43}$/);
});

test('registration permits an office-sized group and persistently throttles after twenty attempts per hour', async () => {
  const db = database();
  const worker = createWorker({seed});
  await register(worker, db);
  for (let attempt = 1; attempt < 20; attempt++) assert.equal((await worker.fetch(request('/api/auth/register', credentials), {DB: db})).status, 409);
  const blocked = await createWorker({seed}).fetch(request('/api/auth/register', {...credentials, username: 'novo_usuario'}), {DB: db});
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('authentication removes expired session and throttle records while retaining current sessions', async () => {
  const db = database();
  const worker = createWorker({seed});
  const registered = await register(worker, db);
  const accountId = db.sqlite.prepare('SELECT id FROM accounts').get().id;
  db.sqlite.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run('a'.repeat(64), accountId, '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z');
  db.sqlite.prepare('INSERT INTO auth_rate_limits (bucket_key, window_start, attempts, expires_at) VALUES (?, ?, ?, ?)').run('b'.repeat(64), 0, 10, 1000);
  const response = await worker.fetch(request('/api/auth/login', {username: 'ana_criativa', password}), {DB: db});
  assert.equal(response.status, 200);
  assert.equal(db.sqlite.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get('a'.repeat(64)), undefined);
  assert.equal(db.sqlite.prepare('SELECT bucket_key FROM auth_rate_limits WHERE bucket_key = ?').get('b'.repeat(64)), undefined);
  assert.ok(db.sqlite.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(await sha256(registered.token)));
});

test('GitHub Pages CORS works for success and errors, rejects null and lookalike origins and handles preflight', async () => {
  const db = database();
  const worker = createWorker({seed});
  const preflight = await worker.fetch(request('/api/auth/login', null, {requestOrigin: pages, method: 'OPTIONS', headers: {'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type'}}), {DB: db});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), pages);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal(preflight.headers.get('vary'), 'Origin');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  for (const requestOrigin of ['null', 'https://evil.example', 'https://fernandesxz011.github.io.evil.example', 'http://fernandesxz011.github.io']) {
    const rejected = await worker.fetch(request('/api/auth/register', credentials, {requestOrigin}), {DB: db});
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  }
  const created = await worker.fetch(request('/api/auth/register', credentials, {requestOrigin: pages}), {DB: db});
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), pages);
  const failure = await worker.fetch(request('/api/auth/login', {username: 'ana_criativa', password: 'senha incorreta longa 123'}, {requestOrigin: pages}), {DB: db});
  assert.equal(failure.status, 401);
  assert.equal(failure.headers.get('access-control-allow-origin'), pages);
  const unavailable = await worker.fetch(request('/api/auth/login', {username: 'ana_criativa', password}, {requestOrigin: pages}), {});
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('access-control-allow-origin'), pages);
  const configured = await worker.fetch(request('/api/health', null, {requestOrigin: 'https://another.example'}), {DB: db, ALLOWED_ORIGINS: 'https://another.example'});
  assert.equal(configured.headers.get('access-control-allow-origin'), 'https://another.example');
});

test('registration is transactional if storing its initial session fails', async () => {
  const db = database();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => sql.startsWith('INSERT INTO sessions') ? {bind() { return this; }, async run() { throw new Error('simulated session persistence failure'); }} : originalPrepare(sql);
  const response = await createWorker({seed}).fetch(request('/api/auth/register', credentials), {DB: db});
  assert.equal(response.status, 503);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});
