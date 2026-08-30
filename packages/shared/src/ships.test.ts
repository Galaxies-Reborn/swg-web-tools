import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SHIP_CHASSIS,
  SHIP_COMPONENTS,
  chassisByName,
  componentsForSlot,
  hardpointCandidates,
  isVisibleSlot,
  shipPartFor,
  totalsFor,
} from './ships.js';

/**
 * The engine enforces exactly two things when installing a component
 * (`ShipObject::canInstallComponent`): slot compatibility, then total mass.
 * These pin both, plus the honesty properties the viewer depends on.
 */

test('the chassis set is the player-flyable one', () => {
  assert.ok(SHIP_CHASSIS.length > 50, 'expected the full player chassis list');
  assert.ok(SHIP_CHASSIS.every((c) => c.name.startsWith('player_')));

  const xwing = chassisByName('player_xwing');
  assert.ok(xwing);
  assert.equal(xwing.model, 'xwing_body');

  // The budget is the one the engine checks: getChassisComponentMassMaximum,
  // set from the chassis deed out of the shipwright's draft schematic. NOT
  // shiptype.tab, which lists a flat 10000 for every player hull alike and is
  // roughly ten times too low. This test previously asserted the placeholder.
  assert.equal(xwing.massMax, 97_500);
  assert.ok(!xwing.massMaxIsFallback);

  const bwing = chassisByName('player_bwing');
  assert.ok(bwing);
  assert.equal(bwing.massMax, 234_000, 'each hull has its own budget, not a shared one');
});

test('a component is only hidden when it truly cannot be installed', () => {
  const xwing = chassisByName('player_xwing');
  assert.ok(xwing);

  // On a real X-wing budget nothing in the game is individually too heavy, so
  // the mass filter must hide nothing here. Filtering against shiptype.tab's
  // placeholder removed 67 of 185 weapons that fit with room to spare.
  const heaviest = SHIP_COMPONENTS.filter((c) => c.mass !== null).reduce((max, c) =>
    (c.mass ?? 0) > (max.mass ?? 0) ? c : max,
  );
  assert.ok((heaviest.mass ?? 0) < xwing.massMax, 'heaviest component should fit the budget');

  const offered = componentsForSlot(xwing, 'weapon_0');
  const compatible = SHIP_COMPONENTS.filter((c) => c.compatibility === 'wpn_0');
  assert.equal(offered.length, compatible.length, 'nothing should be hidden on this hull');
});

test('a slot accepts by compatibility token, not by component type', () => {
  const xwing = chassisByName('player_xwing');
  assert.ok(xwing);

  // weapon_3 is wpn_1 and weapon_4 is cms_0 on an X-wing. Both hold components
  // whose type is "weapon", so matching on type would offer countermeasures in
  // a cannon slot.
  const cannon = componentsForSlot(xwing, 'weapon_0');
  const last = componentsForSlot(xwing, 'weapon_4');
  assert.ok(cannon.length > 0);
  assert.ok(last.length > 0);
  assert.ok(
    cannon.every((c) => c.compatibility === 'wpn_0'),
    'weapon_0 should only accept wpn_0',
  );
  assert.notDeepEqual(
    cannon.map((c) => c.name).sort(),
    last.map((c) => c.name).sort(),
    'different tokens should not offer the same components',
  );
});

test('totals flag an over-budget loadout', () => {
  const xwing = chassisByName('player_xwing');
  assert.ok(xwing);
  const heavy = SHIP_COMPONENTS.filter((c) => c.compatibility === 'wpn_0' && c.mass !== null).reduce(
    (max, c) => ((c.mass ?? 0) > (max.mass ?? 0) ? c : max),
  );

  // One component no longer breaks the budget on a real hull — the heaviest
  // weapon masses 87,550 against 97,500 — so the total is what has to be
  // exercised. Two of them is decisively over.
  const one = totalsFor(xwing, { weapon_0: heavy.name });
  assert.equal(one.overweight, false, 'a single component should fit a real budget');

  const totals = totalsFor(xwing, { weapon_0: heavy.name, weapon_1: heavy.name });
  assert.equal(totals.overweight, true);
  assert.ok(totals.massRemaining < 0);
  assert.deepEqual(totals.incompatible, []);
});

test('a component in a slot that does not accept it is reported', () => {
  const xwing = chassisByName('player_xwing');
  assert.ok(xwing);
  const engine = SHIP_COMPONENTS.find((c) => c.type === 'engine');
  assert.ok(engine);

  // Installed into a weapon slot: the mass still counts, but the loadout is
  // not legal and the tool must say which slot is wrong.
  const totals = totalsFor(xwing, { weapon_0: engine.name });
  assert.deepEqual(totals.incompatible, ['weapon_0']);
});

test('unknown mass is reported, never counted as free', () => {
  const xwing = chassisByName('player_xwing');
  assert.ok(xwing);
  const massless = SHIP_COMPONENTS.find((c) => c.mass === null);
  if (!massless) return; // every component has a stat row; nothing to prove

  const slot = xwing.slots.find((s) => s.compatibility.includes(massless.compatibility));
  if (!slot) return;

  const totals = totalsFor(xwing, { [slot.slot]: massless.name });
  // Treating unknown mass as zero would show a loadout as fitting when nobody
  // can say whether it does.
  assert.deepEqual(totals.unknownMass, [slot.slot]);
  assert.equal(totals.mass, 0);
});

test('internal slots are not treated as failures to place', () => {
  // A reactor or shield has no external part in the game either, so a viewer
  // must not report it as a component it could not position.
  assert.equal(isVisibleSlot('reactor'), false);
  assert.equal(isVisibleSlot('shield_0'), false);
  assert.equal(isVisibleSlot('armor_1'), false);
  assert.equal(hardpointCandidates('reactor').length, 0);

  assert.equal(isVisibleSlot('weapon_0'), true);
  assert.equal(isVisibleSlot('engine'), true);
  assert.equal(isVisibleSlot('booster'), true);
});

test('hardpoint candidates use the names the models actually carry', () => {
  // Slots are zero-based and hardpoints one-based; an off-by-one here silently
  // hangs every weapon on the wrong point.
  assert.deepEqual(hardpointCandidates('weapon_0')[0], 'weapon1');
  assert.deepEqual(hardpointCandidates('weapon_3')[0], 'weapon4');
  assert.ok(hardpointCandidates('droid_interface').includes('astromech'));
});

test('an inventory appearance is never bolted to a hull', () => {
  // A component's own model is almost always its container appearance --
  // `ship_component_engine_s01` is a crate, not an engine. Attaching one to a
  // hardpoint is the difference between a viewer that looks like the game and
  // one that looks broken.
  const xwing = chassisByName('player_xwing');
  assert.ok(xwing);

  const crate = SHIP_COMPONENTS.find((c) => c.model?.includes('ship_component_'));
  assert.ok(crate, 'expected at least one component with an inventory model');
  assert.equal(shipPartFor(xwing, crate), null);

  // A real chassis part is accepted.
  const part = SHIP_COMPONENTS.find((c) => c.model?.startsWith('xwing_'));
  if (part) assert.equal(shipPartFor(xwing, part), part.model);
});

test('a part belonging to another hull is refused', () => {
  const tie = SHIP_CHASSIS.find((c) => c.name.includes('tie'));
  const xwingPart = SHIP_COMPONENTS.find((c) => c.model?.startsWith('xwing_'));
  if (!tie || !xwingPart) return;
  // bst_tiefighter_basic points at xwing_booster_s01 in the data; drawing an
  // X-wing booster on a TIE would be worse than drawing nothing.
  assert.equal(shipPartFor(tie, xwingPart), null);
});

test('a slot accepts every token it lists, not the raw cell', () => {
  // A gunship reactor slot is "rct_0,rct_gunship". Comparing the cell as one
  // opaque string emptied 26 slots across 4 chassis.
  const multi = SHIP_CHASSIS.flatMap((c) =>
    c.slots.filter((s) => s.compatibility.length > 1).map((s) => ({ chassis: c, slot: s })),
  );
  assert.ok(multi.length > 0, 'expected multi-token slots in the data');

  for (const { chassis, slot } of multi.slice(0, 5)) {
    const offered = componentsForSlot(chassis, slot.slot);
    assert.ok(offered.length > 0, `${chassis.name}.${slot.slot} offered nothing`);
    assert.ok(offered.every((c) => slot.compatibility.includes(c.compatibility)));
  }
});

test('a hull whose name ends in "ship" still rejects inventory crates', () => {
  // player_hutt_turret_ship and player_y8_mining_ship end in the word every
  // inventory appearance starts with, so a naive last-word stem matched all
  // 1,191 of them.
  const shipNamed = SHIP_CHASSIS.filter((c) => c.name.endsWith('_ship'));
  const crate = SHIP_COMPONENTS.find((c) => c.model?.startsWith('ship_component_'));
  if (shipNamed.length === 0 || !crate) return;
  for (const chassis of shipNamed) {
    assert.equal(shipPartFor(chassis, crate), null, `${chassis.name} accepted a crate`);
  }
});
