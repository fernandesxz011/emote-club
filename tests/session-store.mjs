import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore} from '../session-store.js';

const key = 'emoteclub.session.v1';
const now = Date.parse('2026-11-17T12:00:00Z');
const active = {token: 'abc_DEF-123'.repeat(5), expiresAt: '2026-11-18T12:00:00.000Z'};
function storage() {
  const data = new Map();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}
function store(persistent, temporary = storage()) {
  return createSessionStore({persistent, temporary, now: () => now});
}

test('remembered sessions survive a new store and a fresh tab adapter', () => {
  const persistent = storage(), temporary = storage();
  assert.equal(store(persistent, temporary).save(active, true), true);
  assert.equal(temporary.getItem(key), null);
  assert.deepEqual(store(persistent).read(), active);
});

test('unchecked sessions stay in this tab and remove a previous remembered session', () => {
  const persistent = storage(), temporary = storage();
  assert.equal(store(persistent, temporary).save(active, true), true);
  const tabSession = {...active, token: 'b'.repeat(64)};
  assert.equal(store(persistent, temporary).save(tabSession, false), true);
  assert.equal(persistent.getItem(key), null);
  assert.deepEqual(store(persistent, temporary).read(), tabSession);
  assert.equal(store(persistent, storage()).read(), null);
});

test('temporary sessions take priority while invalid copies are cleaned', () => {
  const persistent = storage(), temporary = storage();
  persistent.setItem(key, JSON.stringify(active));
  const tabSession = {...active, token: 'c'.repeat(32)};
  temporary.setItem(key, JSON.stringify(tabSession));
  assert.deepEqual(store(persistent, temporary).read(), tabSession);
  persistent.setItem(key, '{bad json');
  assert.deepEqual(store(persistent, temporary).read(), tabSession);
  assert.equal(persistent.getItem(key), null);
});

test('expired, malformed and unsafe session records are removed', () => {
  for (const invalid of [
    {...active, expiresAt: new Date(now).toISOString()},
    {...active, expiresAt: new Date(now - 1).toISOString()},
    {...active, expiresAt: 'not a date'},
    {...active, expiresAt: '2027'},
    {...active, token: 'a'.repeat(31)},
    {...active, token: 'a'.repeat(129)},
    {...active, token: '<script>'.repeat(8)},
    {password: 'not a session'},
    null,
  ]) {
    const persistent = storage(), temporary = storage();
    persistent.setItem(key, JSON.stringify(invalid));
    temporary.setItem(key, JSON.stringify(invalid));
    assert.equal(store(persistent, temporary).read(), null);
    assert.equal(persistent.getItem(key), null);
    assert.equal(temporary.getItem(key), null);
  }
});

test('password and other extra fields are never saved or returned', () => {
  const persistent = storage(), temporary = storage();
  const extra = {...active, password: 'never persist me', email: 'private@example.test'};
  assert.equal(store(persistent, temporary).save(extra, true), true);
  assert.deepEqual(JSON.parse(persistent.getItem(key)), active);
  temporary.setItem(key, JSON.stringify(extra));
  assert.deepEqual(store(persistent, temporary).read(), active);
});

test('storage failures never throw and failed writes return false', () => {
  const unavailable = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('blocked'); },
  };
  const blocked = store(unavailable, unavailable);
  assert.equal(blocked.read(), null);
  assert.equal(blocked.save(active, true), false);
  assert.doesNotThrow(() => blocked.clear());
  const writeOnlyFailure = {...storage(), setItem: unavailable.setItem};
  assert.equal(store(writeOnlyFailure).save(active, true), false);
  const readable = storage();
  readable.setItem(key, JSON.stringify(active));
  assert.deepEqual(store(readable, unavailable).read(), active);
});

test('clear removes both locations without touching unrelated storage keys', () => {
  const persistent = storage(), temporary = storage();
  for (const adapter of [persistent, temporary]) {
    adapter.setItem(key, JSON.stringify(active));
    adapter.setItem('other', 'keep');
  }
  store(persistent, temporary).clear();
  for (const adapter of [persistent, temporary]) {
    assert.equal(adapter.getItem(key), null);
    assert.equal(adapter.getItem('other'), 'keep');
  }
});
