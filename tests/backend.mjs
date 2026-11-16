import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker, parseAssetId} from '../server.js';

const origin = 'https://emote.test';
const seed = [{id: '4849499887', name: 'Happy', category: 'Feliz'}];
const input = {id: '1234567890', name: 'Emote da equipe', category: 'Feliz', description: 'Uma comemoração para a gravação.', tags: ['alegria', 'festa']};
const req = (path, body, extra = {}) => new Request(origin + path, {
  method: body ? 'POST' : 'GET',
  headers: {...(body ? {'content-type': 'application/json', 'origin': origin, 'oai-authenticated-user-id': 'user-123', 'oai-authenticated-user-email': 'ana@example.com'} : {}), ...extra},
  ...(body ? {body: JSON.stringify(body)} : {}),
});
const remote = async url => url.includes('thumbnails.roblox.com')
  ? Response.json({data: [{targetId: 1234567890, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/test/420/420/Image/Png'}]})
  : Response.json({id: 1234567890, name: 'Official Happy Dance', assetType: 61, creatorName: 'Roblox'});
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { assert.match(sql, /^SELECT item_json/); return {results: [...rows.values()]}; },
        async first() { assert.match(sql, /^SELECT id/); return rows.get(args[0]) || null; },
        async run() {
          assert.match(sql, /^INSERT INTO emotes/);
          if (rows.has(args[0])) throw new Error('UNIQUE constraint failed');
          rows.set(args[0], {id: args[0], item_json: args[1], created_at: args[2]});
          return {success: true};
        },
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
  assert.equal((await worker.fetch(req('/api/emotes', input, {'oai-authenticated-user-id': ''}), {})).status, 401);
  assert.equal((await worker.fetch(req('/api/emotes', input, {origin: 'https://evil.test'}), {})).status, 403);
});

test('shared additions persist across requests and preserve official metadata', async () => {
  const db = fakeDB();
  const worker = createWorker({seed, fetcher: remote});
  const response = await worker.fetch(req('/api/emotes', input), {DB: db});
  assert.equal(response.status, 201);
  const {item} = await response.json();
  assert.equal(item.name, 'Official Happy Dance');
  assert.equal(item.creator, 'Roblox');
  assert.equal(item.addedBy, 'ana@example.com');
  assert.equal(item.verified, true);
  assert.equal(item.source, 'https://www.roblox.com/catalog/1234567890');
  const listed = await (await worker.fetch(req('/api/emotes'), {DB: db})).json();
  assert.equal(listed.storage, 'shared');
  assert.equal(listed.items.length, 2);
  assert.deepEqual(listed.items[1], item);
  assert.equal((await worker.fetch(req('/api/emotes', input), {DB: db})).status, 409);
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
  assert.deepEqual(result.items, seed);
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
