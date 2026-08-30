import assert from 'node:assert/strict';
import test from 'node:test';

import { BlockerSet, hitsBlocker, type Blocker } from './blockers.js';

function set(rows: Array<[number, number, number, number]>): BlockerSet {
  return BlockerSet.fromFile({
    planet: 'tatooine',
    count: rows.length,
    models: ['thing'],
    model: rows.map(() => 0),
    x: rows.map((r) => r[0]),
    z: rows.map((r) => r[1]),
    yaw: rows.map(() => 0),
    halfX: rows.map((r) => r[2]),
    halfZ: rows.map((r) => r[3]),
    height: rows.map(() => 5),
  });
}

const one = (x: number, z: number, hx: number, hz: number, yaw = 0): Blocker => ({
  model: 'thing',
  x,
  z,
  yaw,
  halfX: hx,
  halfZ: hz,
  height: 5,
});

test('near() returns positions relative to the site, not the planet', () => {
  const found = set([[1000, -2000, 4, 4]]).near(1000, -2000, 50);
  assert.equal(found.length, 1);
  // The planner's origin is the city centre, so a blocker on top of the site
  // is at (0,0) there. Leaving it in world metres would put it 2 km away.
  assert.equal(found[0].x, 0);
  assert.equal(found[0].z, 0);
});

test('a blocker just outside the radius still counts if its bulk reaches in', () => {
  // Centre is 60 m out, radius 50 -- but it is 20 m across, so it overlaps.
  const found = set([[60, 0, 20, 20]]).near(0, 0, 50);
  assert.equal(found.length, 1, 'its extent has to be considered, not just its centre');
});

test('a blocker genuinely out of reach is dropped', () => {
  assert.equal(set([[500, 0, 2, 2]]).near(0, 0, 50).length, 0);
});

test('a footprint overlapping something already standing is reported', () => {
  const blocked = hitsBlocker(0, 0, 20, 24, [one(10, 10, 5, 5)]);
  assert.ok(blocked, 'a theatre dropped on a hut must be refused');
});

test('a footprint clear of everything is not reported', () => {
  assert.equal(hitsBlocker(0, 0, 20, 24, [one(100, 100, 5, 5)]), null);
});

test('touching exactly at the edge is not an overlap', () => {
  // 20 + 5 = 25: the boxes meet but do not intersect. Rejecting this would
  // refuse a building placed flush against a wall, which is legal and common.
  assert.equal(hitsBlocker(0, 0, 20, 20, [one(25, 0, 5, 5)]), null);
  assert.ok(hitsBlocker(0, 0, 20, 20, [one(24.9, 0, 5, 5)]));
});

test('a quarter-turned blocker swaps its extents', () => {
  // 2 m across, 30 m long, turned across the approach. Ignoring the yaw would
  // test the 2 m side and let a building sit through a long wall.
  const wall = one(0, 22, 1, 15, Math.PI / 2);
  assert.equal(hitsBlocker(0, 0, 5, 5, [wall]), null, 'end-on: 5 + 1 < 22');
  const alongZ = one(0, 18, 1, 15, 0);
  assert.ok(hitsBlocker(0, 0, 5, 5, [alongZ]), 'broadside: 5 + 15 > 18');
});
