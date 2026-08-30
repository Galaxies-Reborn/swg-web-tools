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
