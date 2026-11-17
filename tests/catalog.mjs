import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateSync, crc32} from 'node:zlib';
import {CATEGORIES} from '../server.js';

const seed = JSON.parse(readFileSync(new URL('../seed.json', import.meta.url), 'utf8'));
const audit = JSON.parse(readFileSync(new URL('../catalog-audit.json', import.meta.url), 'utf8'));
const seedById = new Map(seed.map(item => [item.id, item]));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function checkPng(bytes, label) {
  assert.deepEqual(bytes.subarray(0, 8), pngSignature, `${label}: PNG signature`);
  let offset = 8;
  let header;
  let ended = false;
  const compressed = [];
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, `${label}: complete PNG chunk`);
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    assert.ok(end <= bytes.length, `${label}: chunk bounds`);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, end - 4)), bytes.readUInt32BE(end - 4), `${label}: ${type} CRC`);
    if (offset === 8) {
      assert.equal(type, 'IHDR', `${label}: first chunk`);
      assert.equal(length, 13, `${label}: IHDR length`);
      header = {width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12]};
      assert.equal(data[10], 0, `${label}: PNG compression`);
      assert.equal(data[11], 0, `${label}: PNG filtering`);
    }
    if (type === 'IDAT') compressed.push(data);
    if (type === 'IEND') {
      assert.equal(length, 0, `${label}: IEND length`);
      assert.equal(end, bytes.length, `${label}: no truncated or trailing chunks`);
      ended = true;
    }
    offset = end;
  }
  assert.ok(ended && compressed.length, `${label}: image data and terminator`);
  assert.equal(header.width, 420, `${label}: width`);
  assert.equal(header.height, 420, `${label}: height`);
  assert.equal(header.interlace, 0, `${label}: non-interlaced source image`);
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[header.color];
  assert.ok(channels, `${label}: valid PNG color type`);
  assert.ok([1, 2, 4, 8, 16].includes(header.depth), `${label}: bit depth`);
  const rowLength = Math.ceil(header.width * channels * header.depth / 8) + 1;
  const decoded = inflateSync(Buffer.concat(compressed));
  assert.equal(decoded.length, rowLength * header.height, `${label}: complete pixel data`);
  for (let row = 0; row < header.height; row++) assert.ok(decoded[row * rowLength] <= 4, `${label}: scanline filter`);
}

test('catalog has 195 distinct emotes, 15 for each supported emotion, with complete searchable records', () => {
  assert.equal(seed.length, 195);
  assert.equal(seedById.size, seed.length, 'catalog IDs must be unique');
  assert.equal(CATEGORIES.length, 13);
  const counts = new Map(CATEGORIES.map(category => [category, 0]));
  for (const item of seed) {
    assert.match(item.id, /^\d{6,16}$/);
    assert.ok(counts.has(item.category), `${item.id}: predefined emotion`);
    counts.set(item.category, counts.get(item.category) + 1);
    assert.ok(typeof item.name === 'string' && item.name.trim().length >= 2, `${item.id}: name`);
    assert.ok(typeof item.creator === 'string' && item.creator.trim(), `${item.id}: creator`);
    assert.ok(typeof item.description === 'string' && item.description.trim().length >= 10 && item.description.length <= 600, `${item.id}: useful description`);
    assert.ok(Array.isArray(item.tags) && item.tags.length >= 1 && item.tags.length <= 10, `${item.id}: required keywords`);
    for (const tag of item.tags) assert.ok(typeof tag === 'string' && tag === tag.trim() && tag.length >= 1 && tag.length <= 30, `${item.id}: valid keyword`);
    assert.equal(new Set(item.tags.map(tag => tag.toLowerCase())).size, item.tags.length, `${item.id}: no duplicate keywords`);
    assert.equal(item.source, `https://www.roblox.com/catalog/${item.id}`);
    assert.equal(item.verified, true, `${item.id}: catalog checked`);
    assert.equal(item.testedInGame, false, `${item.id}: no runtime claim`);
    assert.ok(Number.isFinite(Date.parse(item.createdAt)), `${item.id}: added date`);
    assert.ok(Number.isFinite(Date.parse(item.verifiedAt)), `${item.id}: verification date`);
  }
  for (const [category, count] of counts) assert.equal(count, 15, category);
});

test('every catalog thumbnail is a distinct complete 420×420 PNG asset', () => {
  const hashes = new Set();
  for (const item of seed) {
    assert.equal(item.thumbnail, `/assets/emote-${item.id}.png`, `${item.id}: local thumbnail path`);
    const bytes = readFileSync(new URL('..' + item.thumbnail, import.meta.url));
    checkPng(bytes, item.id);
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.ok(!hashes.has(hash), `${item.id}: thumbnail must not be a duplicated fallback image`);
    hashes.add(hash);
  }
  assert.equal(hashes.size, seed.length);
});

test('audit covers exactly the catalog and retains official catalog and thumbnail evidence for each ID', () => {
  assert.equal(audit.total, seed.length);
  assert.equal(audit.entries.length, seed.length);
  assert.equal(new Set(audit.entries.map(entry => entry.id)).size, seed.length);
  assert.deepEqual(audit.entries.map(entry => entry.id).sort(), [...seedById.keys()].sort());
  assert.equal(audit.catalogType61Confirmed, seed.length);
  assert.equal(audit.completedThumbnails, seed.length);
  for (const category of CATEGORIES) assert.equal(audit.perEmotion[category], 15);
  for (const entry of audit.entries) {
    const item = seedById.get(entry.id);
    assert.equal(entry.name, item.name);
    assert.equal(entry.category, item.category);
    assert.equal(entry.creator, item.creator);
    assert.equal(entry.catalogSource, `https://catalog.roblox.com/v1/catalog/items/${entry.id}/details?itemType=Asset`);
    const thumbnail = new URL(entry.thumbnailSource);
    assert.equal(thumbnail.origin + thumbnail.pathname, 'https://thumbnails.roblox.com/v1/assets');
    assert.equal(thumbnail.searchParams.get('assetIds'), entry.id);
    assert.equal(thumbnail.searchParams.get('size'), '420x420');
    assert.equal(thumbnail.searchParams.get('format'), 'Png');
    assert.equal(entry.assetType, 61);
    assert.equal(entry.thumbnailState, 'Completed');
    assert.deepEqual(entry.itemStatus, [], `${entry.id}: no catalog status flags`);
    assert.deepEqual(entry.itemRestrictions, [], `${entry.id}: no catalog restriction flags`);
    assert.ok(Number.isFinite(entry.listedPrice) && entry.listedPrice >= 0, `${entry.id}: listed price, including free emotes`);
    assert.notEqual(entry.isPurchasable, false, `${entry.id}: not reported unavailable`);
    assert.equal(item.validation.assetType, 61);
    assert.equal(item.validation.thumbnailState, 'Completed');
    assert.equal(item.validation.listedPrice, entry.listedPrice);
  }
});

test('payload audit distinguishes 46 verified containers from 149 authenticated assets without claiming in-game tests', () => {
  const counts = {verified: 0, 'authentication-required': 0};
  const checkPayload = (payload, id) => {
    assert.equal(payload.source, `https://assetdelivery.roblox.com/v1/asset/?id=${id}`);
    assert.equal(payload.status, 200);
    assert.ok(Number.isInteger(payload.bytes) && payload.bytes > 0);
    assert.match(payload.sha256, /^[a-f0-9]{64}$/);
    assert.equal(payload.robloxContainer, true);
    assert.equal(payload.error, null);
  };
  assert.equal(audit.testedInGame, false);
  assert.ok(audit.notes.some(note => /autenticação/i.test(note)), 'protected asset limitation is documented');
  assert.ok(audit.notes.some(note => /não constituem teste/i.test(note)), 'catalog checks are distinguished from runtime tests');
  for (const entry of audit.entries) {
    const delivery = entry.deliveryAudit;
    const item = seedById.get(entry.id);
    assert.equal(delivery.id, entry.id);
    assert.equal(delivery.metadata.source, `https://assetdelivery.roblox.com/v2/assetId/${entry.id}`);
    assert.equal(delivery.metadata.status, 200);
    assert.equal(delivery.metadata.isArchived, false);
    assert.equal(delivery.parseError, null);
    for (const record of [entry, delivery, item.validation]) assert.equal(record.testedInGame, false);
    assert.ok(Object.hasOwn(counts, delivery.payloadAuditStatus), `${entry.id}: documented audit status`);
    counts[delivery.payloadAuditStatus]++;
    assert.equal(item.validation.payloadAccess, delivery.payloadAuditStatus);
    assert.equal(item.validation.payloadAuditPassed, delivery.payloadAuditPassed);
    assert.deepEqual(item.validation.animationIds, delivery.animationIds);
    if (delivery.payloadAuditStatus === 'verified') {
      assert.equal(delivery.payloadAuditPassed, true);
      assert.equal(delivery.metadata.assetTypeId, 61);
      assert.equal(delivery.metadata.hasLocations, true);
      checkPayload(delivery.payload, entry.id);
      assert.ok(delivery.animationIds.length > 0, `${entry.id}: referenced animations`);
      assert.deepEqual(delivery.animations.map(animation => animation.id), delivery.animationIds);
      for (const animation of delivery.animations) {
        assert.equal(animation.metadata.source, `https://assetdelivery.roblox.com/v2/assetId/${animation.id}`);
        assert.equal(animation.metadata.status, 200);
        assert.equal(animation.metadata.assetTypeId, 24);
        assert.equal(animation.metadata.isArchived, false);
        assert.equal(animation.metadata.hasLocations, true);
        checkPayload(animation.payload, animation.id);
      }
    } else {
      assert.equal(delivery.payloadAuditPassed, false);
      assert.equal(delivery.payload.source, `https://assetdelivery.roblox.com/v1/asset/?id=${entry.id}`);
      assert.equal(delivery.payload.status, 401);
      assert.match(delivery.payload.error, /Authentication required/i);
      assert.equal(delivery.payload.sha256, null);
      assert.equal(delivery.payload.bytes, 0);
      assert.equal(delivery.payload.robloxContainer, false);
      assert.deepEqual(delivery.animationIds, []);
      assert.deepEqual(delivery.animations, []);
    }
  }
  assert.deepEqual(counts, {verified: 46, 'authentication-required': 149});
  assert.equal(audit.publicPayloadAuditPassed, counts.verified);
  assert.equal(audit.payloadAuthenticationRequired, counts['authentication-required']);
});
