import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CITY_LIMITS,
  CITY_RANKS,
  CITY_STRUCTURES,
  METRES_PER_CELL,
  cityRadius,
  fitsInCity,
  maxCivicStructures,
  maxDecorations,
  overlaps,
  placeableOn,
  rankLocks,
  structuresForRank,
  type CityStructure,
  NO_ROOM_MESSAGE,
  footprintCells,
  probePlacement,
  quarterTurns,
  type GroundSampler,
  type StructureFootprint,
} from './city.js';

/**
 * These pin the numbers the planner draws. Every one is checked against the
 * server's own tables rather than an expectation, because a planner with the
 * wrong radius or the wrong footprint looks authoritative while misleading
 * someone about what they can build.
 */

test('rank radii match the game table', () => {
  // datatables/city/city_rank.tab
  assert.deepEqual(
    CITY_RANKS.map((r) => [r.rank, r.radius, r.citizens]),
    [
      [1, 150, 5],
      [2, 200, 10],
      [3, 300, 15],
      [4, 400, 30],
      [5, 450, 40],
    ],
  );
});

test('an out-of-range rank clamps rather than collapsing the plan', () => {
  assert.equal(cityRadius(1), 150);
  assert.equal(cityRadius(5), 450);
  // A zero radius would draw a city you cannot build anything in, which reads
  // as the tool being broken rather than the input being wrong.
  assert.equal(cityRadius(0), 150);
  assert.equal(cityRadius(99), 450);
});

test('a footprint cell is eight metres, not one', () => {
  // World.cpp builds the lot grid as LotManager(16384, 8); footprint x/z are
  // indices into it. At one metre per cell every structure would draw at an
  // eighth of its real size.
  assert.equal(METRES_PER_CELL, 8);

  const shuttleport = byStem('shuttleport_tatooine');
  assert.equal(shuttleport.footprint?.width, 5);
  assert.equal(shuttleport.footprint?.widthMetres, 40);
});

test('structures unlock cumulatively by rank', () => {
  const atOne = structuresForRank(1);
  const atFive = structuresForRank(5);
  // A rank-5 city does not lose access to what a rank-1 city could place.
  for (const structure of atOne) {
    assert.ok(
      atFive.some((s) => s.template === structure.template),
      `${structure.template} vanished at rank 5`,
    );
  }
  assert.ok(atFive.length > atOne.length, 'higher rank should unlock more');
  assert.ok(atOne.every((s) => s.cityRank <= 1));
});

test('civic structures cost no lots and housing does', () => {
  // Civic buildings are flagged NO_LOT_REQUIREMENT, which is how a city hall
  // and its facilities do not eat into a player's ten lots.
  const cityhall = byStem('cityhall_tatooine');
  assert.equal(cityhall.lots, 0);
  assert.equal(cityhall.civic, true);

  const house = byStem('player_house_tatooine_small_style_01');
  assert.equal(house.civic, false);
  assert.ok((house.lots ?? 0) > 0, 'a house should cost lots');
});

test('a structure is judged by its corners, not its centre', () => {
  const hall = byStem('cityhall_tatooine');
  const halfWidth = (hall.footprint?.widthMetres ?? 0) / 2;

  // Centred exactly on the boundary: the centre is legal, the corners are not.
  assert.equal(fitsInCity(hall, 150, 0, 150), false);
  // Pulled fully inside, corners included.
  assert.equal(fitsInCity(hall, 150 - halfWidth - 40, 0, 150), true);
  assert.equal(fitsInCity(hall, 0, 0, 150), true);
});

test('overlap is measured from footprints, not from a fixed radius', () => {
  const hall = byStem('cityhall_tatooine');
  const bank = byStem('bank_tatooine');

  const a = { structure: hall, x: 0, z: 0 };
  // Half of each width is 28 + 12 = 40, so 30 apart must collide...
  assert.equal(overlaps(a, { structure: bank, x: 30, z: 0 }), true);
  // ...and 60 apart must not.
  assert.equal(overlaps(a, { structure: bank, x: 60, z: 0 }), false);
});

test('every civic structure the palette offers can actually be drawn', () => {
  // The palette is what a user clicks. One without a footprint would place at
  // a guessed size, and one without a model would render as a grey box with no
  // explanation.
  for (const structure of structuresForRank(5)) {
    assert.ok(structure.footprint, `${structure.template} has no footprint`);
    assert.ok(structure.model, `${structure.template} has no model`);
  }
});

test('planets with cities disabled are not offered', () => {
  // city_limits.tab lists dathomir, endor and yavin with a cap of zero.
  assert.ok(CITY_LIMITS.length > 0);
  assert.ok(CITY_LIMITS.every((limit) => limit.maxCities > 0));
  const scenes = CITY_LIMITS.map((l) => l.scene);
  assert.ok(scenes.includes('tatooine'));
  assert.ok(!scenes.includes('endor'), 'endor has no player cities');
});

function byStem(stem: string): CityStructure {
  const found = CITY_STRUCTURES.find((s) => s.stem === stem);
  assert.ok(found, `${stem} missing from generated city data`);
  return found;
}

test('the civic and decoration caps match getMaxCivicCount in city.java', () => {
  // 1 + rank * 9, raised to 1 + rank * 12 by the decoration specialisation.
  assert.equal(maxCivicStructures(1), 10);
  assert.equal(maxCivicStructures(5), 46);
  assert.equal(maxCivicStructures(5, true), 61);

  // rank * 15, or rank * 20 with the specialisation. Zero at rank 0, so an
  // unranked city may place none at all.
  assert.equal(maxDecorations(0), 0);
  assert.equal(maxDecorations(3), 45);
  assert.equal(maxDecorations(3, true), 60);
});

test('the palette offers a structure above the rank, so it can be shown locked', () => {
  const palette = placeableOn('corellia');
  const stems = new Set(palette.map((s) => s.stem));

  // The three shuttleports are the only rows in the table gated above rank 3,
  // so hiding rank-locked entries removed exactly one building from a list that
  // otherwise looked complete.
  assert.ok(stems.has('shuttleport_corellia'), 'the shuttleport must be listed');
  assert.ok(stems.has('theater_corellia'), 'the theatre must be listed');

  // Nothing from another planet leaks in.
  assert.ok(!stems.has('shuttleport_tatooine'));
  assert.ok(!stems.has('theater_naboo'));
});

test('rank decides whether a structure is locked, not whether it exists', () => {
  const shuttleport = placeableOn('corellia').find((s) => s.stem === 'shuttleport_corellia');
  const theater = placeableOn('corellia').find((s) => s.stem === 'theater_corellia');
  assert.ok(shuttleport && theater);

  // Both are rank 4. The theatre is civic=false and used to escape the rank
  // gate entirely, which is what let it be placed at rank 3 and then painted
  // red; the shuttleport is civic=true and used to be hidden outright.
  for (const structure of [shuttleport, theater]) {
    assert.equal(rankLocks(structure, 3), true);
    assert.equal(rankLocks(structure, 4), false);
    assert.equal(rankLocks(structure, 5), false);
  }
});

test('a theatre at the city centre is not rejected for size', () => {
  const theater = placeableOn('corellia').find((s) => s.stem === 'theater_corellia');
  assert.ok(theater);
  // 40 x 48 m, so its corner reaches 31.24 m -- inside even a rank-1 radius.
  for (const rank of [1, 2, 3, 4, 5]) {
    assert.equal(fitsInCity(theater, 0, 0, cityRadius(rank)), true, `rank ${rank}`);
  }
});

// ---------------------------------------------------------------------------
// Standing a structure on real ground -- the port of LotManager::canPlace.
// ---------------------------------------------------------------------------



/** An asymmetric 3x5, so a rotation that is merely plausible still fails. */
const ASYMMETRIC: StructureFootprint = {
  width: 3,
  height: 5,
  pivotX: 1,
  pivotZ: 2,
  rows: ['HHH', 'H.H', 'FFF', 'F.F', 'HHH'],
  widthMetres: 24,
  depthMetres: 40,
  structureTolerance: 8,
  hardTolerance: 8,
  boxTest: [0, 0, 3, 5],
};

/** Flat ground at a fixed height, with an optional wet square. */
function flat(height: number, wet?: { x: number; z: number; r: number }): GroundSampler {
  return {
    heightAt: () => height,
    isWater: (x, z) => (wet ? Math.hypot(x - wet.x, z - wet.z) <= wet.r : false),
  };
}

/** Ground rising `perMetre` along +x. */
function ramp(perMetre: number): GroundSampler {
  return { heightAt: (x) => x * perMetre, isWater: () => false };
}

test('a rotation in radians becomes one of the four rotation types', () => {
  assert.equal(quarterTurns(0), 0);
  assert.equal(quarterTurns(Math.PI / 2), 1);
  assert.equal(quarterTurns(Math.PI), 2);
  assert.equal(quarterTurns(-Math.PI / 2), 3);
  assert.equal(quarterTurns(2 * Math.PI), 0);
  // Anything between snaps to the nearest quarter, as the game's placement does.
  assert.equal(quarterTurns(Math.PI / 2 + 0.1), 1);
});

test('every rotation reserves the same lots, just turned', () => {
  const seen = footprintCells(ASYMMETRIC, 0)
    .map((c) => c.lot)
    .sort()
    .join('');
  for (const turns of [1, 2, 3]) {
    const cells = footprintCells(ASYMMETRIC, turns);
    assert.equal(cells.length, 15, `turn ${turns} should still cover 15 lots`);
    assert.equal(
      cells.map((c) => c.lot).sort().join(''),
      seen,
      `turn ${turns} should reserve the same lot types`,
    );
  }
});

test('a quarter turn swaps the footprint the long way round', () => {
  const spanOf = (turns: number) => {
    const cells = footprintCells(ASYMMETRIC, turns);
    const xs = cells.map((c) => c.dx);
    const zs = cells.map((c) => c.dz);
    return [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...zs) - Math.min(...zs) + 1];
  };
  // 3 wide by 5 deep unturned; 5 by 3 on its side.
  assert.deepEqual(spanOf(0), [3, 5]);
  assert.deepEqual(spanOf(1), [5, 3]);
  assert.deepEqual(spanOf(2), [3, 5]);
  assert.deepEqual(spanOf(3), [5, 3]);
});

test('the pivot is where the structure is placed, not its corner', () => {
  const cells = footprintCells(ASYMMETRIC, 0);
  // pivotX 1 of 3 and pivotZ 2 of 5, so the anchor lot has one lot west and
  // two north of it.
  assert.equal(Math.min(...cells.map((c) => c.dx)), -1);
  assert.equal(Math.min(...cells.map((c) => c.dz)), -2);
  assert.ok(cells.some((c) => c.dx === 0 && c.dz === 0));
});

test('flat ground takes a structure, at the height of the ground', () => {
  const verdict = probePlacement(ASYMMETRIC, 0, 0, 0, flat(12));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.height, 12);
  assert.equal(verdict.relief, 0);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.message, null);
});

test('the structure stands at the TOP of the ground under it, not the middle', () => {
  // Rising 0.25 m per metre. The footprint is 3 lots wide -- 24 m -- so the
  // measured ground spans 6 m, inside the 8 m tolerance.
  const verdict = probePlacement(ASYMMETRIC, 0, 0, 0, ramp(0.25));
  assert.equal(verdict.ok, true);
  assert.ok(verdict.relief > 0, 'a ramp is not flat');
  // Highest measured corner, which is the east edge of the eastmost lot.
  const cells = footprintCells(ASYMMETRIC, 0).filter((c) => c.lot !== '.');
  const eastEdge = (Math.max(...cells.map((c) => c.dx)) + 1) * 8;
  assert.equal(verdict.height, eastEdge * 0.25);
});

test('ground too uneven for the footprint is refused, in the game s words', () => {
  // 0.5 m per metre across 24 m of footprint is 12 m of relief against an 8 m
  // tolerance.
  const verdict = probePlacement(ASYMMETRIC, 0, 0, 0, ramp(0.5));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too-steep');
  assert.equal(verdict.message, NO_ROOM_MESSAGE);
  assert.ok(verdict.relief > verdict.tolerance);
});

test('the tolerance is a limit, not a threshold to exceed', () => {
  const tight: StructureFootprint = { ...ASYMMETRIC, structureTolerance: 6 };
  // Exactly 6 m of relief across the 24 m footprint.
  const exact = probePlacement(tight, 0, 0, 0, ramp(0.25));
  assert.equal(exact.relief, 6);
  assert.equal(exact.ok, true, 'relief equal to the tolerance still fits');

  const over = probePlacement({ ...tight, structureTolerance: 5.9 }, 0, 0, 0, ramp(0.25));
  assert.equal(over.ok, false);
});

test('a footprint with a bigger tolerance takes ground a smaller one will not', () => {
  const ground = ramp(0.25);
  assert.equal(probePlacement({ ...ASYMMETRIC, structureTolerance: 8 }, 0, 0, 0, ground).ok, true);
  assert.equal(probePlacement({ ...ASYMMETRIC, structureTolerance: 3 }, 0, 0, 0, ground).ok, false);
});

test('water anywhere under the footprint refuses the site', () => {
  // A puddle on a lot the footprint only buffers, never builds on.
  const verdict = probePlacement(ASYMMETRIC, 0, 0, 0, flat(4, { x: 0, z: -16, r: 3 }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'water');
  assert.equal(verdict.message, NO_ROOM_MESSAGE);
});

test('ground outside the box test rect is not measured', () => {
  // Reserve the full 3x5 but measure only the middle column.
  const narrow: StructureFootprint = { ...ASYMMETRIC, boxTest: [1, 0, 2, 5] };
  const wide = probePlacement(ASYMMETRIC, 0, 0, 0, ramp(0.25));
  const narrowed = probePlacement(narrow, 0, 0, 0, ramp(0.25));
  assert.ok(
    narrowed.relief < wide.relief,
    `measuring one column of three should see less relief: ${narrowed.relief} vs ${wide.relief}`,
  );
});

test('a footprint that measures nothing is refused rather than called flat', () => {
  const nothing: StructureFootprint = { ...ASYMMETRIC, boxTest: [0, 0, 0, 0] };
  const verdict = probePlacement(nothing, 0, 0, 0, flat(3));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'nothing-measured');
});

test('the shipped footprints all carry a tolerance the rule can use', () => {
  const withFootprints = CITY_STRUCTURES.filter((s) => s.footprint !== null);
  assert.ok(withFootprints.length > 100, 'expected the real catalogue');
  for (const structure of withFootprints) {
    const footprint = structure.footprint as StructureFootprint;
    assert.ok(
      footprint.structureTolerance > 0,
      `${structure.stem} has no structure tolerance`,
    );
    assert.equal(footprint.boxTest.length, 4, `${structure.stem} has no box test rect`);
    // Every cell the rotation code will index must exist.
    for (const turns of [0, 1, 2, 3]) {
      const cells = footprintCells(footprint, turns);
      assert.equal(
        cells.length,
        footprint.width * footprint.height,
        `${structure.stem} lost cells at turn ${turns}`,
      );
    }
  }
});

test('a real city hall needs flatter ground than its own tolerance suggests is generous', () => {
  const cityhall = CITY_STRUCTURES.find((s) => s.stem === 'cityhall_tatooine');
  assert.ok(cityhall?.footprint, 'expected the tatooine city hall');
  const footprint = cityhall.footprint as StructureFootprint;
  assert.equal(footprint.structureTolerance, 8);
  // 7 lots by 9 is 56 m by 72 m. A 1-in-10 slope across 56 m is 5.6 m, which
  // fits; 1 in 5 is 11.2 m, which does not.
  assert.equal(probePlacement(footprint, 0, 0, 0, ramp(0.1)).ok, true);
  assert.equal(probePlacement(footprint, 0, 0, 0, ramp(0.2)).ok, false);
});

/**
 * One marked cell in an otherwise uniform 3x5, so a rotation can be checked by
 * where the mark lands rather than by an invariant a wrong rotation would also
 * satisfy.
 *
 * The four expected positions are worked through by hand from the four branches
 * of LotManager::canPlace, not from this implementation. With width 3, height 5,
 * pivot (1, 2) and the F at footprint cell (0, 0):
 *
 *   RT_0    rows[h-1-j][i]      => j=4, i=0  => dx=-1, dz= 2
 *   RT_90   rows[h-1-i][w-1-j]  => i=4, j=2  => dx= 2, dz= 1
 *   RT_180  rows[j][w-1-i]      => j=0, i=2  => dx= 1, dz=-2
 *   RT_270  rows[i][j]          => i=0, j=0  => dx=-2, dz=-1
 *
 * Those four are a consistent quarter turn about the pivot -- each is the last
 * mapped by (dx, dz) -> (dz, -dx) -- which is the cross-check that the
 * transcription is a rotation at all and not four unrelated index errors.
 */
const MARKED: StructureFootprint = {
  width: 3,
  height: 5,
  pivotX: 1,
  pivotZ: 2,
  rows: ['FHH', 'HHH', 'HHH', 'HHH', 'HHH'],
  widthMetres: 24,
  depthMetres: 40,
  structureTolerance: 8,
  hardTolerance: 8,
  boxTest: [0, 0, 3, 5],
};

test('each rotation puts the footprint cells exactly where the game puts them', () => {
  const expected: [number, [number, number]][] = [
    [0, [-1, 2]],
    [1, [2, 1]],
    [2, [1, -2]],
    [3, [-2, -1]],
  ];

  for (const [turns, [dx, dz]] of expected) {
    const marks = footprintCells(MARKED, turns).filter((c) => c.lot === 'F');
    assert.equal(marks.length, 1, `turn ${turns} should keep exactly one marked lot`);
    assert.deepEqual(
      [marks[0]?.dx, marks[0]?.dz],
      [dx, dz],
      `turn ${turns} put the marked lot in the wrong place`,
    );
  }
});

test('the quarter turns really are turns of each other', () => {
  // (dx, dz) -> (dz, -dx) takes each rotation to the next, which a set of
  // independently wrong index expressions would not satisfy.
  for (const turns of [0, 1, 2]) {
    const from = footprintCells(MARKED, turns).filter((c) => c.lot === 'F')[0];
    const to = footprintCells(MARKED, turns + 1).filter((c) => c.lot === 'F')[0];
    assert.deepEqual([to?.dx, to?.dz], [from?.dz, -(from?.dx ?? 0)], `turn ${turns} -> ${turns + 1}`);
  }
});
