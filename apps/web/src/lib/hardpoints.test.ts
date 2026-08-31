import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { findHardpoint, ownerOfHardpoint, transformWithinModel } from './hardpoints.js';

/**
 * Rebuild what ShipModel draws: a hull, a wing mounted on it that rolls when
 * the S-foils open, and a cannon whose hardpoint lives on the wing.
 */
function assemble(hardpointLocal: THREE.Vector3, roll: number) {
  const hull = new THREE.Object3D();

  // The wing, drawn inside a group that carries the roll.
  const rolled = new THREE.Group();
  rolled.rotation.set(0, 0, roll);
  hull.add(rolled);

  const wing = new THREE.Object3D();
  rolled.add(wing);

  const hardpoint = new THREE.Object3D();
  hardpoint.position.copy(hardpointLocal);
  wing.add(hardpoint);

  // The cannon: a sibling of the wing inside the same rolled group, placed by
  // the mount read in the wing's frame.
  const cannon = new THREE.Object3D();
  const matrix = transformWithinModel(hardpoint, wing);
  matrix.decompose(cannon.position, cannon.quaternion, cannon.scale);
  rolled.add(cannon);

  hull.updateMatrixWorld(true);
  return { hull, hardpoint, cannon };
}

const CLOSED = 0;
const OPEN = 0.28;

test('a part sits exactly on the hardpoint it mounts to', () => {
  for (const local of [new THREE.Vector3(0, 0, 0), new THREE.Vector3(-4.42, 0, 0)]) {
    const { hardpoint, cannon } = assemble(local, CLOSED);
    const want = hardpoint.getWorldPosition(new THREE.Vector3());
    const got = cannon.getWorldPosition(new THREE.Vector3());
    assert.ok(want.distanceTo(got) < 1e-9, `${local.toArray()}: ${want.toArray()} vs ${got.toArray()}`);
  }
});

test('opening the S-foils carries the part with the wing', () => {
  // The X-wing: every wing hardpoint is at the model origin.
  const closed = assemble(new THREE.Vector3(0, 0, 0), CLOSED);
  const open = assemble(new THREE.Vector3(0, 0, 0), OPEN);
  const hardpointMoved = closed.hardpoint
    .getWorldPosition(new THREE.Vector3())
    .distanceTo(open.hardpoint.getWorldPosition(new THREE.Vector3()));
  const partMoved = closed.cannon
    .getWorldPosition(new THREE.Vector3())
    .distanceTo(open.cannon.getWorldPosition(new THREE.Vector3()));
  assert.equal(
    Math.round(partMoved * 1e6),
    Math.round(hardpointMoved * 1e6),
    'the part must move exactly as far as its hardpoint',
  );

  // Orientation has to follow too, or a cannon points where the wing no longer does.
  assert.ok(
    Math.abs(open.cannon.getWorldQuaternion(new THREE.Quaternion()).angleTo(
      open.hardpoint.getWorldQuaternion(new THREE.Quaternion()),
    )) < 1e-9,
  );
});

test('the B-wing case: an off-origin mount still tracks the roll', () => {
  const local = new THREE.Vector3(-4.42, 0, 0);
  const open = assemble(local, OPEN);
  const want = open.hardpoint.getWorldPosition(new THREE.Vector3());
  const got = open.cannon.getWorldPosition(new THREE.Vector3());
  assert.ok(want.distanceTo(got) < 1e-9, `${want.toArray()} vs ${got.toArray()}`);
  // And it is genuinely rolled, not accidentally still at rest.
  assert.ok(Math.abs(got.y) > 1, `expected the mount to have swung, got y=${got.y}`);
});

test('reading the mount in world space instead would double-count the roll', () => {
  // The bug this replaced: using the hardpoint's WORLD transform for a part
  // that is then drawn inside the rolled group applies the roll twice.
  const local = new THREE.Vector3(-4.42, 0, 0);
  const { hull, hardpoint } = assemble(local, OPEN);
  hull.updateMatrixWorld(true);
  const world = hardpoint.getWorldPosition(new THREE.Vector3());

  const rolled = new THREE.Group();
  rolled.rotation.set(0, 0, OPEN);
  const wrong = new THREE.Object3D();
  wrong.position.copy(world);
  rolled.add(wrong);
  rolled.updateMatrixWorld(true);

  const got = wrong.getWorldPosition(new THREE.Vector3());
  assert.ok(
    got.distanceTo(world) > 0.5,
    'expected the doubled roll to visibly displace the part',
  );
});

// ---------------------------------------------------------------------------
// Resolving a hardpoint to the model that carries it.
//
// The registry outlives a change of chassis, and hardpoint names repeat across
// ships. These pin the scoping that keeps one ship's answer out of another's.
// ---------------------------------------------------------------------------

function reg(entries: Record<string, string[]>): [string, Map<string, string>][] {
  return Object.entries(entries).map(([model, names]) => [
    model,
    new Map(names.map((n) => [n.toLowerCase(), `${model}:${n}`])),
  ]);
}

/**
 * A hutt ship, whose engine/weapon/booster hardpoints are all on its hull,
 * with a blacksun ship still in the registry from a moment ago. Blacksun's
 * structural model carries hardpoints of the SAME names.
 */
const AFTER_LOOKING_AT_BLACKSUN = reg({
  black_sun_fighter_light_body_s01: ['booster1', 'wing1'],
  black_sun_fighter_light_struct_s01: ['engine1', 'weapon1'],
  hutt_fighter_light_body_s01: ['booster1', 'engine1', 'weapon1', 'struct1'],
  hutt_fighter_light_struct_s01: ['contrail1', 'contrail2'],
});

const HUTT_MODELS = new Set(['hutt_fighter_light_body_s01', 'hutt_fighter_light_struct_s01']);
const HUTT_HULL = 'hutt_fighter_light_body_s01';

test('a hardpoint on the hull is owned by nobody, so the part hangs on the hull', () => {
  // This is the whole bug. Unscoped, `engine1` resolves to blacksun's wing --
  // which is neither null nor one of this ship's structural models, so the
  // canvas drops the part from BOTH render paths and draws nothing at all.
  for (const name of ['engine1', 'weapon1', 'booster1']) {
    assert.equal(
      ownerOfHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, HUTT_HULL, name),
      null,
      `${name} is on this hull, so nothing else may claim it`,
    );
  }
});

test('a hardpoint really on a structural model is owned by it', () => {
  assert.equal(
    ownerOfHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, HUTT_HULL, 'contrail1'),
    'hutt_fighter_light_struct_s01',
  );
});

test('the same lookup for the blacksun ship answers with blacksun models', () => {
  const models = new Set([
    'black_sun_fighter_light_body_s01',
    'black_sun_fighter_light_struct_s01',
  ]);
  const hull = 'black_sun_fighter_light_body_s01';
  assert.equal(
    ownerOfHardpoint(AFTER_LOOKING_AT_BLACKSUN, models, hull, 'engine1'),
    'black_sun_fighter_light_struct_s01',
  );
  // On its own hull, so unowned -- and it must not be attributed to hutt's hull.
  assert.equal(ownerOfHardpoint(AFTER_LOOKING_AT_BLACKSUN, models, hull, 'booster1'), null);
});

test('a hardpoint no model on this ship has is unowned rather than borrowed', () => {
  assert.equal(
    ownerOfHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, HUTT_HULL, 'wing1'),
    null,
    'wing1 belongs to a blacksun hull and must not be claimed here',
  );
});

test('finding a hardpoint never returns another ship s node', () => {
  // Unscoped this returns blacksun's engine1, and the part is drawn at the
  // wrong place on the wrong ship.
  assert.equal(
    findHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, 'engine1'),
    'hutt_fighter_light_body_s01:engine1',
  );
  assert.equal(
    findHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, 'weapon1'),
    'hutt_fighter_light_body_s01:weapon1',
  );
});

test('a preferred model wins where a name appears on more than one', () => {
  // An X-wing carries contrail1 on both wings; a part drawn inside one wing
  // belongs to that wing's copy.
  const xwing = reg({
    xwing_body: ['wing1'],
    xwing_wing_pos: ['contrail1', 'engine_pos1'],
    xwing_wing_neg: ['contrail1', 'engine_neg1'],
  });
  const models = new Set(['xwing_body', 'xwing_wing_pos', 'xwing_wing_neg']);
  assert.equal(
    findHardpoint(xwing, models, 'contrail1', 'xwing_wing_neg'),
    'xwing_wing_neg:contrail1',
  );
  assert.equal(
    findHardpoint(xwing, models, 'contrail1', 'xwing_wing_pos'),
    'xwing_wing_pos:contrail1',
  );
});

test('a preferred model that is not on this ship does not smuggle one in', () => {
  assert.equal(
    findHardpoint(
      AFTER_LOOKING_AT_BLACKSUN,
      HUTT_MODELS,
      'engine1',
      'black_sun_fighter_light_struct_s01',
    ),
    'black_sun_fighter_light_struct_s01:engine1',
    'an explicitly named owner is honoured -- the canvas only ever names one of this ship s own models',
  );
});

test('an unknown hardpoint is null rather than a guess', () => {
  assert.equal(findHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, 'nosuchpoint'), null);
  assert.equal(
    ownerOfHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, HUTT_HULL, 'nosuchpoint'),
    null,
  );
});

test('lookups do not care about case', () => {
  assert.equal(
    findHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, 'ENGINE1'),
    'hutt_fighter_light_body_s01:engine1',
  );
  assert.equal(
    ownerOfHardpoint(AFTER_LOOKING_AT_BLACKSUN, HUTT_MODELS, HUTT_HULL, 'Contrail1'),
    'hutt_fighter_light_struct_s01',
  );
});
