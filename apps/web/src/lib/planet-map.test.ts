import assert from 'node:assert/strict';
import test from 'node:test';

import { FLAG_WATER, PlanetOverview, type PlanetMeta } from './planet-map.js';

/**
 * A 4x4 overview at 32 m over a 128 m world, laid out exactly like a real bake:
 * the world is centred on the origin, so the south-west corner is -64, and
 * sample c is the aggregate of everything in [-64 + 32c, -64 + 32c + 32).
 */
function overview(heightsDm: number[], flags: number[] = []): PlanetOverview {
  const meta: PlanetMeta = {
    planet: 'test',
    mapWidth: 128,
    spacing: 8,
    samples: 16,
    tileSamples: 8,
    tiles: 2,
    minHeight: Math.min(...heightsDm) / 10,
    maxHeight: Math.max(...heightsDm) / 10,
    originX: -64,
    originZ: -64,
    overview: 'overview.height',
    overviewFlags: 'overview.flags',
    overviewSamples: 4,
    overviewSpacing: 32,
  };
  return new PlanetOverview(
    meta,
    Int16Array.from(heightsDm),
    Uint8Array.from(flags.length ? flags : heightsDm.map(() => 0)),
  );
}

/** Rises 10 m (100 dm) per sample along +x, flat in z. */
const RAMP = overview([
  0, 100, 200, 300,
  0, 100, 200, 300,
  0, 100, 200, 300,
  0, 100, 200, 300,
]);

/**
 * The bug this guards against: `cell()` used Math.round, which anchors a sample
 * at its block's near edge rather than naming the block a coordinate is in. The
 * mesh draws each sample at its block CENTRE, so the lookup came out half a
 * cell -- one whole sample, for anything past the first -- ahead of the ground
 * actually drawn. The site marker floated, and the panel described a spot 32 m
 * from the one clicked.
 */
test('a coordinate reads the sample whose block it is inside', () => {
  // Sample 1 covers [-32, 0). Every coordinate in it must read 10 m.
  for (const x of [-32, -31, -17, -16, -15, -1]) {
    assert.equal(RAMP.heightAt(x, 0), 10, `x=${x} should be inside sample 1`);
  }
  // And the moment it crosses into sample 2, it reads 20 m -- not before.
  assert.equal(RAMP.heightAt(0, 0), 20);
  assert.equal(RAMP.heightAt(31, 0), 20);
});

test('the block centre reads its own block, which is what the mesh draws there', () => {
  // The mesh puts sample c at originX + 32c + 16. Looking that point up has to
  // return sample c, or the drawn ground and the read ground disagree.
  for (let c = 0; c < 4; c += 1) {
    assert.equal(RAMP.heightAt(-64 + 32 * c + 16, 0), c * 10);
  }
});

test('the map edges stay inside the map', () => {
  assert.equal(RAMP.heightAt(-64, 0), 0);
  // +64 is one past the last block; it clamps rather than reading off the end.
  assert.equal(RAMP.heightAt(64, 0), 30);
  assert.equal(RAMP.heightAt(-1e6, 0), 0);
  assert.equal(RAMP.heightAt(1e6, 0), 30);
});

test('rows and columns are not transposed', () => {
  // Rises along +z instead, so a mix-up shows up as a constant.
  const byRow = overview([
    0, 0, 0, 0,
    100, 100, 100, 100,
    200, 200, 200, 200,
    300, 300, 300, 300,
  ]);
  assert.equal(byRow.heightAt(0, -48), 0);
  assert.equal(byRow.heightAt(0, 16), 20);
  // Height must not depend on x at all here, whichever block x lands in.
  for (const x of [-48, -16, 0, 48]) assert.equal(byRow.heightAt(x, -16), 10);
});

test('water is read per block, with the same registration as height', () => {
  const wet = overview(
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, FLAG_WATER, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(wet.isWater(-32, -64), true);
  assert.equal(wet.isWater(-1, -64), true);
  assert.equal(wet.isWater(-33, -64), false);
  assert.equal(wet.isWater(0, -64), false);
});

test('contains covers the whole map, including the last block', () => {
  assert.equal(RAMP.contains(0, 0), true);
  assert.equal(RAMP.contains(-64, -64), true);
  assert.equal(RAMP.contains(64, 64), true);
  assert.equal(RAMP.contains(65, 0), false);
  assert.equal(RAMP.contains(0, -65), false);
});
