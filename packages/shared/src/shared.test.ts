import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crc, CRC_NULL, crcNormalized } from './crc.js';
import { parseResourceAttributes, parseFractalSeeds, resourceSatisfies } from './resources.js';
import { decodeObjVarValue, ObjVarType, nestObjVars } from './objvars.js';
import { worldToMap, mapToWorld, planetExtent } from './planets.js';
import { GameClock, isPermanent, END_OF_TIME } from './game-clock.js';
import { readAttributes } from './attributes.js';
import { cleanStringId, askingPrice, classifyListing } from './auctions.js';

test('crc matches the engine', () => {
  // Crc::calculate("") returns init ^ init.
  assert.equal(CRC_NULL, 0);
  // CRC-32/BZIP2 check value for "123456789".
  assert.equal(crc('123456789') >>> 0, 0xfc891918);
  // Normalisation lowercases and flips separators before hashing.
  assert.equal(crcNormalized('Object\\Weapon\\Foo.IFF'), crc('object/weapon/foo.iff'));
});

test('resource attributes unpack from the colon-terminated blob', () => {
  const parsed = parseResourceAttributes('res_quality 812:res_decay_resist 447:');
  assert.deepEqual(parsed, { res_quality: 812, res_decay_resist: 447 });
  // An empty set is stored as a single space, not NULL.
  assert.deepEqual(parseResourceAttributes(' '), {});
  assert.deepEqual(parseResourceAttributes(null), {});
});

test('fractal seeds yield the planet object ids', () => {
  assert.deepEqual(parseFractalSeeds('8589934592 12345:8589934593 67890:'), [
    '8589934592',
    '8589934593',
  ]);
});

test('resource class ancestry drives schematic substitution', () => {
  assert.equal(resourceSatisfies('steel_arveshian', 'steel'), true);
  assert.equal(resourceSatisfies('steel_arveshian', 'metal'), true);
  assert.equal(resourceSatisfies('steel_arveshian', 'steel_arveshian'), true);
  assert.equal(resourceSatisfies('steel_arveshian', 'aluminum'), false);
});

test('objvar arrays honour escapes', () => {
  assert.deepEqual(decodeObjVarValue(ObjVarType.IntArray, '1:2:3:'), [1, 2, 3]);
  assert.deepEqual(decodeObjVarValue(ObjVarType.StringArray, 'a\\:b:c:'), ['a:b', 'c']);
  assert.equal(decodeObjVarValue(ObjVarType.Int, '42'), 42);
  assert.deepEqual(decodeObjVarValue(ObjVarType.Location, '1.5 2.5 3.5 tatooine 0'), {
    x: 1.5,
    y: 2.5,
    z: 3.5,
    scene: 'tatooine',
    cell: '0',
  });
});

test('objvars nest on dots', () => {
  const nested = nestObjVars([
    { name: 'vendor.setup.name', type: ObjVarType.String, raw: 'Shop', value: 'Shop' },
    { name: 'vendor.setup.tax', type: ObjVarType.Int, raw: '5', value: 5 },
  ]);
  assert.deepEqual(nested, { vendor: { setup: { name: 'Shop', tax: 5 } } });
});

test('map coordinates round-trip', () => {
  assert.equal(planetExtent('tatooine'), 8192);
  const { u, v } = worldToMap('tatooine', -8192, 8192);
  assert.deepEqual([u, v], [0, 0]);
  const back = mapToWorld('tatooine', u, v);
  assert.equal(Math.round(back.x), -8192);
  assert.equal(Math.round(back.z), 8192);
});

test('game clock recovers the wall-clock offset', () => {
  const lastSaveAt = new Date('2026-08-15T12:00:00.000Z');
  const clock = new GameClock({ lastSaveTime: 1_000_000, lastSaveAt });
  assert.equal(clock.toDate(1_000_000).toISOString(), lastSaveAt.toISOString());
  assert.equal(clock.toDate(1_000_060).getTime() - lastSaveAt.getTime(), 60_000);
  assert.equal(isPermanent(END_OF_TIME), true);
  assert.equal(isPermanent(1_000_000), false);
});

test('creature attributes split into current and max', () => {
  const row: Record<string, unknown> = {};
  for (let i = 0; i < 9; i += 1) row[`attribute_${i}`] = 100 + i;
  for (let i = 0; i < 9; i += 1) row[`attribute_${9 + i}`] = 200 + i;
  const stats = readAttributes(row);
  assert.equal(stats.length, 9);
  assert.equal(stats[0]?.name, 'health');
  assert.equal(stats[0]?.current, 100);
  assert.equal(stats[0]?.max, 200);
  assert.equal(stats[0]?.deficit, 100);
  assert.equal(stats[0]?.isPool, true);
  assert.equal(stats[1]?.isPool, false);
});

test('auction helpers', () => {
  assert.equal(cleanStringId('@obj_attr_n:armor_effectiveness'), 'Armor Effectiveness');
  assert.equal(askingPrice(1, 50_000), 50_000);
  assert.equal(askingPrice(2_500, 0), 2_500);
  assert.equal(
    classifyListing({ minBid: 0, buyNowPrice: 100, ended: false, isVendorLocation: false }),
    'instant',
  );
  assert.equal(
    classifyListing({ minBid: 10, buyNowPrice: 0, ended: true, isVendorLocation: true }),
    'stockroom',
  );
});
