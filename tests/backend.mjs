import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createWorker, parseAssetId} from '../server.js';

const origin = 'https://emote.test';
const seed = [{id: '4849499887', name: 'Happy', category: 'Feliz'}];
const input = {id: '1234567890', name: 'Emote da equipe', category: 'Feliz', description: 'Uma comemoração para a gravação.', tags: ['alegria', 'festa']};
const testToken = id => createHash('sha256').update(`test-session:${id}`).digest('base64url');
const req = (path, body, extra = {}) => new Request(origin + path, {
  method: body ? 'POST' : 'GET',
  headers: {...(body ? {'content-type': 'application/json', 'origin': origin, authorization: `Bearer ${testToken('user-123')}`} : {}), ...extra},
  ...(body ? {body: JSON.stringify(body)} : {}),
});
const remote = async url => url.includes('thumbnails.roblox.com')
  ? Response.json({data: [{targetId: 1234567890, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/test/420/420/Image/Png'}]})
  : Response.json({id: 1234567890, name: 'Official Happy Dance', assetType: 61, creatorName: 'Roblox'});
function fakeDB() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL('../drizzle/0000_catalog.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../drizzle/0001_personal_library.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../drizzle/0002_password_auth.sql', import.meta.url), 'utf8'));
  for (const [id, username] of [['user-123', 'ana123'], ['user-456', 'user456'], ['other-user', 'otheruser']]) {
    database.prepare('INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, username, 'not-used-by-session-tests', '2026-01-01T00:00:00.000Z');
    database.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(createHash('sha256').update(testToken(id)).digest('hex'), id, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  }
  return {
    database,
    rows: {get size() { return database.prepare('SELECT COUNT(*) AS count FROM emotes').get().count; }},
    async batch(statements) {
      database.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { return {results: statement.all(...args)}; },
        async first() { return statement.get(...args) || null; },
        async run() { statement.run(...args); return {success: true}; },
      };
    },
  };
}

test('parses catalog IDs and rejects lookalike hosts and animation links', () => {
  assert.equal(parseAssetId('4849499887'), '4849499887');
  assert.equal(parseAssetId('https://www.roblox.com/catalog/4849499887/Happy'), '4849499887');
  assert.equal(parseAssetId('https://roblox.com.evil.test/catalog/4849499887'), null);
  assert.equal(parseAssetId('javascript:123456'), null);
  assert.equal(parseAssetId('https://www.roblox.com/asset/?id=12345678'), null);
});

test('authentication and same-origin checks precede validation and storage', async () => {
  const worker = createWorker({seed, fetcher: () => { throw new Error('must not call Roblox'); }});
  assert.equal((await worker.fetch(req('/api/emotes', input, {authorization: '', 'oai-authenticated-user-id': 'user-123'}), {})).status, 401);
  assert.equal((await worker.fetch(req('/api/emotes', input, {origin: 'https://evil.test'}), {})).status, 403);
});

test('shared additions persist across requests and preserve official metadata', async () => {
  const db = fakeDB();
  const worker = createWorker({seed, fetcher: remote});
  const response = await worker.fetch(req('/api/emotes', {...input, tags: ['  ALEGRIA  ', 'festa', 'alegria']}), {DB: db});
  assert.equal(response.status, 201);
  const {item} = await response.json();
  assert.equal(item.name, 'Official Happy Dance');
  assert.equal(item.creator, 'Roblox');
  assert.equal(item.addedBy, 'ana123');
  assert.equal(item.verified, true);
  assert.equal(item.source, 'https://www.roblox.com/catalog/1234567890');
  assert.equal(item.category, 'Feliz');
  assert.deepEqual(item.tags, ['alegria', 'festa']);
  const listed = await (await worker.fetch(req('/api/emotes'), {DB: db})).json();
  assert.equal(listed.storage, 'shared');
  assert.equal(listed.items.length, 2);
  assert.deepEqual(listed.items[1], item);
  assert.equal((await worker.fetch(req('/api/emotes', input), {DB: db})).status, 409);
});

test('missing, empty and invalid keywords and emotions are rejected before remote requests or database access', async () => {
  let fetchCalls = 0;
  let databaseCalls = 0;
  const worker = createWorker({seed, fetcher: () => { fetchCalls++; throw new Error('Invalid input must not reach Roblox'); }});
  const sessions = fakeDB();
  const db = {prepare(sql) { if (sql.includes('FROM sessions')) return sessions.prepare(sql); databaseCalls++; throw new Error('Invalid input must not reach catalog storage'); }};
  const {tags, ...withoutTags} = input;
  const keywordError = 'Adicione de 1 a 10 palavras-chave, com até 30 caracteres cada.';
  const invalidCases = [
    [withoutTags, keywordError],
    [{...input, tags: []}, keywordError],
    [{...input, tags: ['   ']}, keywordError],
    [{...input, tags: ['alegria', '\n\t']}, keywordError],
    [{...input, tags: ['palavra', 123]}, keywordError],
    [{...input, tags: ['x'.repeat(31)]}, keywordError],
    [{...input, tags: Array.from({length: 11}, (_, index) => `tag${index}`)}, keywordError],
    [{...input, category: ''}, 'Selecione uma das emoções da lista.'],
    [{...input, category: 'Outra'}, 'Selecione uma das emoções da lista.'],
  ];
  for (const [body, expectedError] of invalidCases) {
    const response = await worker.fetch(req('/api/emotes', body), {DB: db});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, expectedError);
  }
  assert.equal(fetchCalls, 0);
  assert.equal(databaseCalls, 0);
});

test('seed duplicate, invalid emotions and oversized tags cannot be added', async () => {
  const worker = createWorker({seed, fetcher: remote});
  const db = fakeDB();
  assert.equal((await worker.fetch(req('/api/emotes', {...input, id: seed[0].id}), {DB: db})).status, 409);
  assert.equal((await worker.fetch(req('/api/emotes', {...input, category: 'Outra'}), {DB: db})).status, 400);
  assert.equal((await worker.fetch(req('/api/emotes', {...input, tags: ['x'.repeat(31)]}), {DB: db})).status, 400);
  assert.equal(db.rows.size, 0);
});

test('Roblox asset type must be an emote and failures never save records', async () => {
  const db = fakeDB();
  const worker = createWorker({seed, fetcher: async () => Response.json({name: 'Hat', assetType: 8})});
  const response = await worker.fetch(req('/api/emotes', input), {DB: db});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /não é um emote/);
  assert.equal(db.rows.size, 0);
  const offline = createWorker({seed, fetcher: async () => { throw new Error('Network'); }});
  assert.equal((await offline.fetch(req('/api/validate', {id: input.id}), {DB: db})).status, 503);
});

test('database outage retains searchable seed catalog but does not accept additions', async () => {
  const worker = createWorker({seed});
  const result = await (await worker.fetch(req('/api/emotes'))).json();
  assert.deepEqual(result.items, seed.map(item => ({...item, createdAt: '2026-11-16T23:47:52.897Z'})));
  assert.equal(result.storage, 'unavailable');
  assert.equal((await worker.fetch(req('/api/emotes', input))).status, 503);
});

test('embedded assets return UTF-8 bytes and unknown assets return 404', async () => {
  const html = '<h1>Emoções da equipe</h1>';
  const worker = createWorker({assets: {'/index.html': {body: Buffer.from(html).toString('base64'), type: 'text/html; charset=utf-8'}}});
  const response = await worker.fetch(req('/'));
  assert.equal(await response.text(), html);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal((await worker.fetch(req('/missing.png'))).status, 404);
});

const userHeaders = (id = 'user-123') => ({authorization: `Bearer ${testToken(id)}`});

test('personal library requires authentication, same-origin requests and an existing profile', async () => {
  const worker = createWorker({seed});
  const db = fakeDB();
  for (const [path, body] of [['/api/profile', {displayName: 'Ana'}], ['/api/saved', {id: seed[0].id, saved: true}]]) {
    assert.equal((await worker.fetch(req(path, body, {authorization: '', 'oai-authenticated-user-id': 'user-123'}), {DB: db})).status, 401);
    assert.equal((await worker.fetch(req(path, body, {origin: 'https://evil.test'}), {DB: db})).status, 403);
  }
  const missing = await worker.fetch(req('/api/saved', {id: seed[0].id, saved: true}), {DB: db});
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).code, 'PROFILE_REQUIRED');
});

test('profile registration and updates retain creation time and cannot target another user', async () => {
  const worker = createWorker({seed});
  const db = fakeDB();
  const created = await (await worker.fetch(req('/api/profile', {displayName: '  Ana  Criativa  ', userId: 'other-user'}), {DB: db})).json();
  assert.deepEqual(Object.keys(created.profile).sort(), ['createdAt', 'displayName']);
  assert.equal(created.profile.displayName, 'Ana Criativa');
  assert.deepEqual(created.saved, []);
  const updated = await (await worker.fetch(req('/api/profile', {displayName: 'Ana do Estúdio'}), {DB: db})).json();
  assert.equal(updated.profile.createdAt, created.profile.createdAt);
  assert.equal(updated.profile.displayName, 'Ana do Estúdio');
  const me = await (await worker.fetch(req('/api/me', null, userHeaders()), {DB: db})).json();
  assert.equal(me.signedIn, true);
  assert.equal(me.name, 'Ana do Estúdio');
  assert.deepEqual(me.profile, updated.profile);
  assert.equal(me.storage, 'shared');
  const other = await (await worker.fetch(req('/api/me', null, userHeaders('other-user')), {DB: db})).json();
  assert.equal(other.profile, null);
  assert.deepEqual(other.saved, []);
});

test('shared contributions use the profile display name and fail safely if the profile cannot be read', async () => {
  const db = fakeDB();
  const worker = createWorker({seed, fetcher: remote});
  await worker.fetch(req('/api/profile', {displayName: 'Ana do Estúdio'}), {DB: db});
  const response = await worker.fetch(req('/api/emotes', input), {DB: db});
  assert.equal(response.status, 201);
  assert.equal((await response.json()).item.addedBy, 'Ana do Estúdio');
  const unavailableProfile = {
    prepare(sql) {
      if (sql.includes('FROM profiles')) throw new Error('profile query failed');
      return fakeDB().prepare(sql);
    },
  };
  const failure = await worker.fetch(req('/api/emotes', input), {DB: unavailableProfile});
  assert.equal(failure.status, 503);
  assert.match((await failure.json()).error, /perfil/);
});

test('profile names, saved flags and emote IDs are validated', async () => {
  const worker = createWorker({seed});
  const db = fakeDB();
  for (const displayName of ['', 'A', 'x'.repeat(51), 123, 'An\u0000a']) {
    assert.equal((await worker.fetch(req('/api/profile', {displayName}), {DB: db})).status, 400);
  }
  await worker.fetch(req('/api/profile', {displayName: 'Ana'}), {DB: db});
  assert.equal((await worker.fetch(req('/api/saved', {id: 'invalid', saved: true}), {DB: db})).status, 400);
  assert.equal((await worker.fetch(req('/api/saved', {id: seed[0].id, saved: 'true'}), {DB: db})).status, 400);
  assert.equal((await worker.fetch(req('/api/saved', {id: '9999999999', saved: true}), {DB: db})).status, 404);
});

test('saving is idempotent and timestamps remain stable across requests', async () => {
  const worker = createWorker({seed});
  const db = fakeDB();
  await worker.fetch(req('/api/profile', {displayName: 'Ana'}), {DB: db});
  const first = await (await worker.fetch(req('/api/saved', {id: seed[0].id, saved: true}), {DB: db})).json();
  assert.equal(first.saved, true);
  assert.equal(first.id, seed[0].id);
  const stableTime = '2026-11-16T10:00:00.000Z';
  db.database.prepare('UPDATE saved_emotes SET saved_at = ? WHERE user_id = ?').run(stableTime, 'user-123');
  const second = await (await worker.fetch(req('/api/saved', {id: seed[0].id, saved: true}), {DB: db})).json();
  assert.equal(second.savedAt, stableTime);
  const me = await (await worker.fetch(req('/api/me', null, userHeaders()), {DB: db})).json();
  assert.deepEqual(me.saved, [{id: seed[0].id, savedAt: stableTime}]);
});

test('saved emotes are isolated per authenticated user and removal cannot affect another account', async () => {
  const worker = createWorker({seed});
  const db = fakeDB();
  for (const userId of ['user-123', 'user-456']) {
    await worker.fetch(req('/api/profile', {displayName: userId}, userHeaders(userId)), {DB: db});
    const saved = await worker.fetch(req('/api/saved', {id: seed[0].id, saved: true, userId: 'user-456'}, userHeaders(userId)), {DB: db});
    assert.equal(saved.status, 200);
  }
  const removed = await (await worker.fetch(req('/api/saved', {id: seed[0].id, saved: false, userId: 'user-456'}), {DB: db})).json();
  assert.deepEqual(removed, {id: seed[0].id, saved: false, savedAt: null});
  const me = await (await worker.fetch(req('/api/me', null, userHeaders()), {DB: db})).json();
  const other = await (await worker.fetch(req('/api/me', null, userHeaders('user-456')), {DB: db})).json();
  assert.deepEqual(me.saved, []);
  assert.equal(other.saved.length, 1);
  assert.equal(other.saved[0].id, seed[0].id);
  assert.equal((await worker.fetch(req('/api/saved', {id: seed[0].id, saved: false}), {DB: db})).status, 200);
});

test('personal library can save shared additions without a remote Roblox request', async () => {
  const db = fakeDB();
  const item = {...input, createdAt: '2026-11-16T12:00:00Z'};
  db.database.prepare('INSERT INTO emotes (id, item_json, created_at) VALUES (?, ?, ?)').run(item.id, JSON.stringify(item), item.createdAt);
  const worker = createWorker({seed, fetcher: () => { throw new Error('Must not fetch Roblox for saved items'); }});
  await worker.fetch(req('/api/profile', {displayName: 'Ana'}), {DB: db});
  assert.equal((await worker.fetch(req('/api/saved', {id: input.id, saved: true}), {DB: db})).status, 200);
});

test('database and session query failures return 503 instead of pretending the session is signed out', async () => {
  const worker = createWorker({seed});
  const brokenDB = {prepare() { throw new Error('database down'); }};
  for (const env of [{}, {DB: brokenDB}]) {
    const me = await worker.fetch(req('/api/me', null, userHeaders()), env);
    assert.equal(me.status, 503);
    assert.equal((await me.json()).signedIn, undefined);
    assert.equal((await worker.fetch(req('/api/profile', {displayName: 'Ana'}), env)).status, 503);
    assert.equal((await worker.fetch(req('/api/saved', {id: seed[0].id, saved: true}), env)).status, 503);
  }
  const anonymous = await (await worker.fetch(req('/api/me'), {DB: fakeDB()})).json();
  assert.deepEqual(anonymous, {signedIn: false, name: null, username: null, profile: null, saved: [], storage: 'shared'});
});

test('initial catalog dates are filled only when absent and shared additions keep their true date', async () => {
  const existingDate = '2026-01-01T12:00:00Z';
  const worker = createWorker({seed: [...seed, {id: '2345678901', name: 'Old', createdAt: existingDate}]});
  const items = (await (await worker.fetch(req('/api/emotes'))).json()).items;
  assert.equal(items[0].createdAt, '2026-11-16T23:47:52.897Z');
  assert.equal(items[1].createdAt, existingDate);
});
