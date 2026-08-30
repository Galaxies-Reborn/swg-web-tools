import assert from 'node:assert/strict';
import test from 'node:test';

import { FLAG_WATER, TerrainTile, loadSiteTerrain, type TerrainTileMeta } from './terrain.js';

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

// ---------------------------------------------------------------------------
// Cutting a site out of a planet bake.
//
// This is the part that has to agree with the planner's coordinate space. A
// plan stores its structures relative to its site and its blockers are
// re-centred onto it, so a tile handed back in WORLD terms gets indexed with
// local coordinates, clamps to its own corner, and gives every building on the
// site one identical altitude -- a row of buildings hanging in the air over the
// ground they are supposed to stand on. These tests pin the rebasing down.
// ---------------------------------------------------------------------------

/**
 * A 16x16-sample planet, 128 m across at 8 m, in 4 tiles of 8x8. Ground rises
 * 1 m per sample along +x and 10 m per sample along +z, so any mix-up between
 * the axes, the tiles or the origin shows up as a wrong number rather than as a
 * plausible one.
 */
function fakePlanet(name: string) {
  const SAMPLES = 16;
  const TILE = 8;
  const heightDm = (col: number, row: number) => col * 10 + row * 100;

  const meta = {
    mapWidth: 128,
    spacing: 8,
    samples: SAMPLES,
    tileSamples: TILE,
    tiles: 2,
    originX: -64,
    originZ: -64,
  };

  const tileBytes = (tileZ: number, tileX: number, what: 'height' | 'flags') => {
    const n = TILE * TILE;
    if (what === 'flags') return new Uint8Array(n).buffer;
    const out = new Int16Array(n);
    for (let r = 0; r < TILE; r += 1) {
      for (let c = 0; c < TILE; c += 1) {
        out[r * TILE + c] = heightDm(tileX * TILE + c, tileZ * TILE + r);
      }
    }
    return out.buffer;
  };

  const fetchStub = async (url: string) => {
    const path = String(url);
    if (path.endsWith(`/terrain/${name}/planet.json`)) {
      return { ok: true, json: async () => meta };
    }
    // Split rather than match: a tile path is `<tileZ>_<tileX>.<what>`, and
    // taking it apart by hand keeps the stub free of escaping.
    const missing = {
      ok: false,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    const file = path.split('/').pop() ?? '';
    const [stem, what] = file.split('.');
    if (!path.includes(`/terrain/${name}/`)) return missing;
    if (what !== 'height' && what !== 'flags') return missing;
    const [z, x] = stem.split('_').map(Number);
    if (!Number.isInteger(z) || !Number.isInteger(x)) return missing;
    return {
      ok: true,
      json: async () => ({}),
      arrayBuffer: async () => tileBytes(z, x, what),
    };
  };

  return { meta, heightDm, fetchStub };
}

/** Run `body` with fetch stubbed, then put the real one back. */
async function withPlanet(name: string, body: () => Promise<void>) {
  const planet = fakePlanet(name);
  const real = globalThis.fetch;
  // The stub answers the handful of URLs the cut asks for and nothing else.
  globalThis.fetch = planet.fetchStub as unknown as typeof globalThis.fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

test('a cut site puts the site itself at the origin, at zero', async () => {
  await withPlanet('alpha', async () => {
    // A site deliberately off the sample grid: 5 and -3 are not multiples of 8.
    const tile = await loadSiteTerrain('alpha', 5, -3, 64);
    assert.ok(tile, 'expected a tile');

    // Zero is the ground the site stands on, so the planner's grid, its
    // buildable circle and a building at the centre all meet there.
    assert.ok(
      Math.abs(tile.heightAt(0, 0)) <= 0.05,
      `site should read 0, read ${tile.heightAt(0, 0)}`,
    );

    // And the world altitude that zero stands for is not thrown away.
    assert.ok(tile.meta.datum !== undefined, 'datum should be recorded');
  });
});

test('a cut site reads heights relative to the site, in local coordinates', async () => {
  await withPlanet('beta', async () => {
    const tile = await loadSiteTerrain('beta', 0, 0, 64);
    assert.ok(tile, 'expected a tile');

    // Ground rises 1 m per 8 m in x and 10 m per 8 m in z, so from the site:
    assert.ok(Math.abs(tile.heightAt(8, 0) - 1) <= 0.05, `+8 x: ${tile.heightAt(8, 0)}`);
    assert.ok(Math.abs(tile.heightAt(-8, 0) + 1) <= 0.05, `-8 x: ${tile.heightAt(-8, 0)}`);
    assert.ok(Math.abs(tile.heightAt(0, 8) - 10) <= 0.05, `+8 z: ${tile.heightAt(0, 8)}`);
    assert.ok(Math.abs(tile.heightAt(0, -8) + 10) <= 0.05, `-8 z: ${tile.heightAt(0, -8)}`);

    // Reading it with WORLD coordinates instead is the bug this guards: on this
    // planet the site is at world (0,0) too, so a world-indexed tile would have
    // to agree -- it is the OFF-CENTRE case below that separates them.
    assert.ok(Math.abs(tile.heightAt(16, 16) - 22) <= 0.05, `(16,16): ${tile.heightAt(16, 16)}`);
  });
});

test('a site away from the middle of the world is still read at its own origin', async () => {
  await withPlanet('gamma', async () => {
    // 32 m east and 24 m north of the world centre. A tile left in world terms
    // would answer local (0,0) with the height at world (0,0) -- 4 m and 30 m
    // of ramp away -- or clamp to its corner entirely.
    const tile = await loadSiteTerrain('gamma', 32, 24, 64);
    assert.ok(tile, 'expected a tile');
    assert.ok(
      Math.abs(tile.heightAt(0, 0)) <= 0.05,
      `site should read 0, read ${tile.heightAt(0, 0)}`,
    );
    assert.ok(Math.abs(tile.heightAt(8, 0) - 1) <= 0.05, `+8 x: ${tile.heightAt(8, 0)}`);
    assert.ok(Math.abs(tile.heightAt(0, 8) - 10) <= 0.05, `+8 z: ${tile.heightAt(0, 8)}`);

    // The origin is stated relative to the site, which is what makes that work.
    assert.ok(tile.meta.originX < 0 && tile.meta.originZ < 0);
    assert.ok(Math.abs(tile.meta.originX + tile.meta.span / 2) <= 8);
  });
});

test('a site at the edge of the world gets a window that shifts inwards', async () => {
  await withPlanet('delta', async () => {
    const tile = await loadSiteTerrain('delta', 60, 60, 64);
    assert.ok(tile, 'expected a tile');
    // Still zeroed on the site, and still 9x9 samples rather than torn short.
    assert.equal(tile.meta.samples, 9);
    assert.ok(Math.abs(tile.heightAt(0, 0)) <= 0.6, `edge site: ${tile.heightAt(0, 0)}`);
  });
});
