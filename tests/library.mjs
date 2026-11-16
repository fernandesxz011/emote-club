import test from 'node:test';
import assert from 'node:assert/strict';
import {getRecency, formatAddedDate, listSavedItems} from '../library.js';

const now = Date.parse('2026-11-16T12:00:00Z');
const hour = 60 * 60 * 1000;
const itemWithAge = age => ({createdAt: new Date(now - age).toISOString()});

test('new includes the exact 48-hour boundary; recent ends at seven days', () => {
  assert.deepEqual(getRecency(itemWithAge(0), now), {label: 'Novo', kind: 'new'});
  assert.deepEqual(getRecency(itemWithAge(48 * hour), now), {label: 'Novo', kind: 'new'});
  assert.deepEqual(getRecency(itemWithAge(48 * hour + 1), now), {label: 'Recente', kind: 'recent'});
  assert.deepEqual(getRecency(itemWithAge(7 * 24 * hour), now), {label: 'Recente', kind: 'recent'});
  assert.equal(getRecency(itemWithAge(7 * 24 * hour + 1), now), null);
});

test('future, missing and invalid dates never receive recency labels', () => {
  assert.equal(getRecency(itemWithAge(-1), now), null);
  for (const createdAt of [null, undefined, '', '  ', 'invalid', new Date(NaN), false, Infinity]) {
    assert.equal(getRecency({createdAt}, now), null);
  }
  assert.equal(getRecency(null, now), null);
  assert.equal(getRecency(itemWithAge(0), NaN), null);
  assert.equal(getRecency({verifiedAt: new Date(now).toISOString()}, now), null);
});

test('added dates use Brazilian formatting and the browser local timezone', () => {
  const createdAt = '2026-11-16T23:30:00Z';
  assert.equal(formatAddedDate({createdAt}), new Date(createdAt).toLocaleDateString('pt-BR'));
  for (const createdAt of [null, undefined, '', 'invalid']) {
    assert.equal(formatAddedDate({createdAt}), 'Data de inclusão não informada');
  }
  assert.equal(formatAddedDate({verifiedAt: createdAt}), 'Data de inclusão não informada');
});

test('saved items preserve catalog order and exclude removed or unknown IDs', () => {
  const items = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
  const saved = new Set(['c', 'missing', 'a']);
  assert.deepEqual(listSavedItems(items, saved), [items[0], items[2]]);
  assert.deepEqual(listSavedItems(items, new Set()), []);
  assert.deepEqual(listSavedItems([], saved), []);
  assert.deepEqual(items, [{id: 'a'}, {id: 'b'}, {id: 'c'}]);
  assert.deepEqual([...saved], ['c', 'missing', 'a']);
});
