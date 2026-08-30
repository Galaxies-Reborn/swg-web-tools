import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { transformWithinModel } from './hardpoints.js';

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
