import assert from 'node:assert/strict';
import test from 'node:test';

import { handleSchematicRequest, isSchematicPath } from './schematics.js';

/**
 * These check the interceptor against the API it stands in for. The same pages
 * run unmodified against the full stack, so anything answered here has to have
 * the shape the API returns -- and where it cannot answer, it has to say so
 * rather than answering with a zero that means something else.
 */

interface Summary {
  id: string;
  group: string;
  label: string;
  category: string | null;
  resourceSlots: number;
}
interface ListResult {
  items: Summary[];
  total: number;
  groups: string[];
}
interface Slot {
  name: string;
  kind: string;
  ingredient: string;
  optional: boolean;
  count: number;
  available: number | null;
  matches: unknown[];
}
interface Detail {
  id: string;
  group: string;
  label: string;
  slots: Slot[];
  craftableNow: boolean | null;
  missingSlots: string[];
}

const list = (path: string) => handleSchematicRequest<ListResult>(path);

test('it recognises the paths it answers, and only those', () => {
  assert.equal(isSchematicPath('/api/schematics'), true);
  assert.equal(isSchematicPath('/api/schematics?q=rifle'), true);
  assert.equal(isSchematicPath('/api/schematics/armor/armor_x'), true);
  assert.equal(isSchematicPath('/api/designs/city_plan'), false);
  assert.equal(isSchematicPath('/api/resources'), false);
  // Not a prefix match on the segment: a sibling route must not be swallowed.
  assert.equal(isSchematicPath('/api/schematicsomething'), false);
});

test('the whole set is there, with its groups', () => {
  const all = list('/api/schematics');
  assert.ok(all.total > 3000, `expected the real set, got ${all.total}`);
  assert.ok(all.groups.length > 1);
  assert.deepEqual(all.groups, [...all.groups].sort(), 'groups should be sorted');
  assert.equal(new Set(all.groups).size, all.groups.length, 'groups should be unique');
});

test('the page size defaults to 60 and is clamped, as the API clamps it', () => {
  assert.equal(list('/api/schematics').items.length, 60);
  assert.equal(list('/api/schematics?limit=5').items.length, 5);
  assert.equal(list('/api/schematics?limit=500').items.length, 200);
  // Nonsense falls back to the default rather than returning nothing. Note
  // limit=0 gives 60, not 1: the API reads it as `parseInt(x) || 60`, and 0 is
  // falsy, so a zero is indistinguishable from an absent value. Reproduced
  // rather than corrected -- the point of this module is to answer the way the
  // real endpoint does.
  assert.equal(list('/api/schematics?limit=0').items.length, 60);
  assert.equal(list('/api/schematics?limit=abc').items.length, 60);
  assert.equal(list('/api/schematics?limit=-5').items.length, 1);
});

test('total counts the matches, not the page', () => {
  const page = list('/api/schematics?limit=5');
  assert.equal(page.items.length, 5);
  assert.ok(page.total > 5, 'total should be the match count, not the page size');
});

test('a group filter narrows to that group', () => {
  const all = list('/api/schematics');
  const group = all.groups[0];
  assert.ok(group, 'expected at least one group');
  const filtered = list(`/api/schematics?group=${encodeURIComponent(group)}&limit=200`);
  assert.ok(filtered.total > 0, `no schematics in ${group}`);
  assert.ok(filtered.total < all.total, 'a group should be narrower than everything');
  for (const item of filtered.items) assert.equal(item.group, group);
});

test('search matches the label, case-insensitively', () => {
  const lower = list('/api/schematics?q=armor&limit=200');
  const upper = list('/api/schematics?q=ARMOR&limit=200');
  assert.ok(lower.total > 0);
  assert.equal(lower.total, upper.total, 'search should not care about case');
  for (const item of lower.items) {
    assert.ok(
      item.label.includes('armor') || item.id.includes('armor'),
      `${item.id} does not match the search`,
    );
  }
});

test('an unmatched search is empty rather than everything', () => {
  const none = list('/api/schematics?q=zzzzzzzznotathing');
  assert.equal(none.total, 0);
  assert.equal(none.items.length, 0);
  // The group list still comes from the whole set, so the filter stays usable.
  assert.ok(none.groups.length > 1);
});

test('one schematic comes back with its slots', () => {
  const first = list('/api/schematics?limit=1').items[0];
  assert.ok(first, 'expected a schematic to ask for');
  const detail = handleSchematicRequest<Detail>(`/api/schematics/${first.id}`);
  assert.equal(detail.id, first.id);
  assert.equal(detail.group, first.group);
  assert.ok(detail.slots.length > 0, 'a schematic should want something');
  assert.equal(
    detail.slots.filter((s) => s.kind === 'resource').length,
    first.resourceSlots,
    'the summary and the detail should agree on the resource slot count',
  );
});

test('what needs a live galaxy comes back null, never zero', () => {
  const first = list('/api/schematics?limit=1').items[0];
  assert.ok(first);
  const detail = handleSchematicRequest<Detail>(`/api/schematics/${first.id}`);
  // This is the whole point: 0 spawned and nobody asked are different facts,
  // and rendering the second as the first tells a crafter a recipe is dead
  // when it may be perfectly makeable.
  assert.equal(detail.craftableNow, null);
  assert.deepEqual(detail.missingSlots, []);
  for (const slot of detail.slots) {
    assert.equal(slot.available, null, `${slot.name} should report no count, not zero`);
    assert.deepEqual(slot.matches, []);
  }
});

test('ids containing slashes resolve, since every id has one', () => {
  const first = list('/api/schematics?limit=1').items[0];
  assert.ok(first);
  assert.ok(first.id.includes('/'), 'ids are directory-qualified');
  assert.doesNotThrow(() => handleSchematicRequest<Detail>(`/api/schematics/${first.id}`));
});

test('a query string on a detail path is ignored, not treated as part of the id', () => {
  const first = list('/api/schematics?limit=1').items[0];
  assert.ok(first);
  const detail = handleSchematicRequest<Detail>(`/api/schematics/${first.id}?cb=1`);
  assert.equal(detail.id, first.id);
});

test('an unknown schematic is an error rather than an empty one', () => {
  assert.throws(() => handleSchematicRequest<Detail>('/api/schematics/nope/not_a_thing'));
});
