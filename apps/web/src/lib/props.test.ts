import assert from 'node:assert/strict';
import test from 'node:test';

import { hitsProp, propExtent, type PlacedProp, type Prop } from './props.js';

function prop(overrides: Partial<Prop> = {}): Prop {
  return {
    template: 'object/tangible/furniture/all/frn_all_thing.iff',
    model: 'frn_all_thing',
    name: 'Thing',
    halfX: 2,
    halfZ: 1,
    height: 1,
    shape: 'box',
    collides: true,
    ...overrides,
  };
}

const put = (id: string, x: number, z: number, rotation = 0, p: Prop = prop()): PlacedProp => ({
  id,
  prop: p,
  x,
  z,
  rotation,
});

test('a quarter turn swaps a prop extent', () => {
  const flat = put('a', 0, 0, 0);
  assert.deepEqual(propExtent(flat), { halfX: 2, halfZ: 1 });
  const turned = put('a', 0, 0, Math.PI / 2);
  assert.deepEqual(propExtent(turned), { halfX: 1, halfZ: 2 });
});

test('a footprint landing on a placed prop is reported', () => {
  const hit = hitsProp(0, 0, 3, 3, [put('a', 4, 0)]);
  assert.ok(hit);
  assert.equal(hit.id, 'a');
});

test('clear of everything is not reported', () => {
  assert.equal(hitsProp(0, 0, 1, 1, [put('a', 50, 50)]), null);
});

test('a non-colliding ornament never blocks anything', () => {
  // A cup takes no room. Treating every decoration as an obstacle would make
  // a decorated plan impossible to finish.
  const cup = prop({ collides: false, halfX: 0.1, halfZ: 0.1 });
  assert.equal(hitsProp(0, 0, 3, 3, [put('a', 0, 0, 0, cup)]), null);
});

test('a prop does not collide with itself when it is being moved', () => {
  const placed = [put('a', 0, 0)];
  assert.equal(hitsProp(0, 0, 1, 1, placed, 'a'), null, 'dragging it must not self-block');
  assert.ok(hitsProp(0, 0, 1, 1, placed), 'but it still blocks anything else');
});

test('rotation is honoured when testing an existing prop', () => {
  // The prop is 4 m along x and 2 m along z. Turned a quarter, its reach along
  // z becomes 2 m instead of 1, which is the whole point of honouring yaw.
  // Placed at 2.4 m: turned it overlaps (0.5 + 2 > 2.4), flat it does not
  // (0.5 + 1 < 2.4). At exactly 2.5 the boxes would touch without overlapping,
  // which is deliberately not a collision -- see the edge test above.
  const turned = put('a', 0, 2.4, Math.PI / 2);
  assert.ok(hitsProp(0, 0, 0.5, 0.5, [turned]), 'turned: reaches 2 m along z');
  const flatOne = put('a', 0, 2.4, 0);
  assert.equal(hitsProp(0, 0, 0.5, 0.5, [flatOne]), null, 'flat: reaches only 1 m');
});
