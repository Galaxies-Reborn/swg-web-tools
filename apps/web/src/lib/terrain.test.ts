import assert from 'node:assert/strict';
import test from 'node:test';

import { FLAG_WATER, TerrainTile, type TerrainTileMeta } from './terrain.js';

/** A 3x3 tile at 8 m spacing centred on the origin, with a known ramp. */
function tile(heightsDm: number[], flags: number[] = []): TerrainTile {
  const meta: TerrainTileMeta = {
    planet: 'tatooine',
    originX: -8,
    originZ: -8,
    centreX: 0,
    centreZ: 0,
    span: 16,
    spacing: 8,
    samples: 3,
    minHeight: Math.min(...heightsDm) / 10,
    maxHeight: Math.max(...heightsDm) / 10,
    height: 'x.height',
    flags: 'x.flags',
  };
  return new TerrainTile(
    meta,
    Int16Array.from(heightsDm),
    Uint8Array.from(flags.length ? flags : heightsDm.map(() => 0)),
  );
}

/** A ramp rising 1 m (10 dm) per sample along +x, flat in z. */
const RAMP = tile([0, 10, 20, 0, 10, 20, 0, 10, 20]);

test('a baked sample reads back exactly', () => {
  assert.equal(RAMP.heightAt(-8, -8), 0);
  assert.equal(RAMP.heightAt(0, 0), 1);
  assert.equal(RAMP.heightAt(8, 8), 2);
});

test('between samples it interpolates rather than stepping', () => {
  // Halfway along one 8 m cell of a 1 m rise.
  assert.equal(RAMP.heightAt(-4, 0), 0.5);
  assert.equal(RAMP.heightAt(4, 0), 1.5);
  // Nearest-sample lookup would give a whole metre here; that is the visible
  // stair-stepping this exists to avoid.
  assert.notEqual(RAMP.heightAt(-4, 0), RAMP.heightAt(-8, 0));
});

test('it interpolates in both axes at once', () => {
  // Rises along x AND z, so the centre of a cell is the average of its corners.
  const bowl = tile([0, 0, 0, 0, 0, 0, 0, 0, 40]);
  assert.equal(bowl.heightAt(4, 4), 1);
});

test('sampling outside the tile clamps instead of reading past the edge', () => {
  // Off the west edge: an unclamped index would read the previous row, giving
  // a plausible height from the wrong place.
  assert.equal(RAMP.heightAt(-1000, 0), 0);
  assert.equal(RAMP.heightAt(1000, 0), 2);
  assert.equal(RAMP.contains(-1000, 0), false);
  assert.equal(RAMP.contains(0, 0), true);
});

test('contains covers the tile edges, which are real samples', () => {
  assert.equal(RAMP.contains(-8, -8), true);
  assert.equal(RAMP.contains(8, 8), true);
  assert.equal(RAMP.contains(8.01, 8), false);
});

test('water is read per cell, not blended between cells', () => {
  const lake = tile([0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, FLAG_WATER, 0, 0, 0, 0]);
  assert.equal(lake.isWater(0, 0), true);
  // Three metres away is still nearest to the wet sample, so still water.
  assert.equal(lake.isWater(3, 0), true);
  // Five metres away is nearer the dry one. A blended flag would give a
  // meaningless half-wet cell instead.
  assert.equal(lake.isWater(5, 0), false);
});

test('the format reaches the highest ground the game actually has', () => {
  // Tatooine peaks above 345 m. In centimetres an int16 stops at 327.67 and
  // silently shaved 17.7 m off 1.2% of that planet, flattening its summits.
  // Decimetres reach 3,276 m, so this must round-trip untouched.
  const peak = tile([3454, 3454, 3454, 3454, 3454, 3454, 3454, 3454, 3454]);
  assert.equal(peak.heightAt(0, 0), 345.4);
});
