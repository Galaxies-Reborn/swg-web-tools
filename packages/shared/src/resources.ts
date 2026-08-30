/**
 * Resource class tree and attribute helpers.
 *
 * The tree is generated from dsrc datatables/resource/resource_tree.tab by
 * scripts/generate-domain-data.mjs — 845 classes, 725 of which can spawn.
 * A spawned resource in `resource_types` names its leaf class; everything the
 * dashboard shows (which classes it satisfies, what caps its stats) comes from
 * walking this tree.
 */
import rawTree from '../data/resource-tree.json' with { type: 'json' };
import rawAttributes from '../data/resource-attributes.json' with { type: 'json' };

export interface ResourceAttributeRange {
  readonly min: number;
  readonly max: number;
}

export interface ResourceClass {
  readonly index: number;
  /** Datatable ENUM, e.g. `steel_arveshian`. Matches `resource_types.resource_class`. */
  readonly id: string;
  /** Display name, e.g. `Hardened Arveshium Steel`. */
  readonly name: string;
  readonly depth: number;
  readonly parent: string | null;
  /** True when the class has pools, i.e. concrete resources of it can spawn. */
  readonly spawnable: boolean;
  readonly minPools: number;
  readonly maxPools: number;
  readonly recycled: boolean;
  readonly permanent: boolean;
  readonly container: string | null;
  readonly attributes: Readonly<Record<string, ResourceAttributeRange>>;
}

export interface ResourceAttributeMeta {
  /** Two-letter code players use, e.g. `OQ`. */
  readonly code: string;
  readonly label: string;
}

export const RESOURCE_CLASSES: readonly ResourceClass[] = rawTree as readonly ResourceClass[];

export const RESOURCE_ATTRIBUTES: Readonly<Record<string, ResourceAttributeMeta>> =
  rawAttributes as Readonly<Record<string, ResourceAttributeMeta>>;

/** Attribute keys in the canonical display order players expect. */
export const RESOURCE_ATTRIBUTE_ORDER = [
  'res_cold_resist',
  'res_conductivity',
  'res_decay_resist',
  'entangle_resistance',
  'res_flavor',
  'res_heat_resist',
  'res_malleability',
  'res_quality',
  'res_potential_energy',
  'res_shock_resistance',
  'res_toughness',
] as const;

const classById = new Map(RESOURCE_CLASSES.map((c) => [c.id, c]));
const childrenByParent = new Map<string | null, ResourceClass[]>();
for (const c of RESOURCE_CLASSES) {
  const list = childrenByParent.get(c.parent);
  if (list) list.push(c);
  else childrenByParent.set(c.parent, [c]);
}

const codeToKey = new Map(
  Object.entries(RESOURCE_ATTRIBUTES).map(([key, meta]) => [meta.code, key]),
);

export function getResourceClass(id: string | null | undefined): ResourceClass | undefined {
  if (!id) return undefined;
  return classById.get(id);
}

export function resourceClassName(id: string | null | undefined): string {
  return getResourceClass(id)?.name ?? id ?? 'Unknown';
}

export function resourceChildren(id: string | null): readonly ResourceClass[] {
  return childrenByParent.get(id) ?? [];
}

/** Root-to-leaf chain, e.g. resource → inorganic → mineral → … → steel_arveshian. */
export function resourceAncestry(id: string): readonly ResourceClass[] {
  const chain: ResourceClass[] = [];
  let cursor = classById.get(id);
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parent ? classById.get(cursor.parent) : undefined;
  }
  return chain;
}

/**
 * True when a resource of class `leaf` can be used wherever `required` is
 * asked for — i.e. `required` is `leaf` or one of its ancestors. This is the
 * check that answers "does this Arveshium Steel work in my schematic?".
 */
export function resourceSatisfies(leaf: string, required: string): boolean {
  if (leaf === required) return true;
  let cursor = classById.get(leaf);
  while (cursor?.parent) {
    if (cursor.parent === required) return true;
    cursor = classById.get(cursor.parent);
  }
  return false;
}

/** Every spawnable leaf beneath `id`, inclusive. */
export function spawnableDescendants(id: string): readonly ResourceClass[] {
  const out: ResourceClass[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const node = classById.get(current);
    if (node?.spawnable) out.push(node);
    for (const child of resourceChildren(current)) stack.push(child.id);
  }
  return out;
}

/**
 * Parse the packed attribute blob from `resource_types.attributes`.
 *
 * ResourceTypeBuffer writes each entry as `"<name> <value>:"`, so the column
 * looks like `res_quality 812:res_decay_resist 447:`. An empty set is stored as
 * a single space, not NULL. Attributes the class does not define are simply
 * absent — that is how a resource ends up with no Cold Resistance at all.
 */
export function parseResourceAttributes(blob: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!blob) return out;
  for (const entry of blob.split(':')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.lastIndexOf(' ');
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = Number.parseInt(trimmed.slice(sep + 1), 10);
    if (key && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Parse `resource_types.fractal_seeds`, packed the same way as attributes but
 * keyed by planet object id: `"<planetObjectId> <seed>:"`.
 *
 * The keys are the planets the resource actually spawned on, which is the one
 * fact players want most and the client never shows them directly. Resolving
 * ids to names needs a lookup against the planet objects; see
 * `@precu/db`'s `getPlanetObjectMap`.
 */
export function parseFractalSeeds(blob: string | null | undefined): string[] {
  const out: string[] = [];
  if (!blob) return out;
  for (const entry of blob.split(':')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(' ');
    const planetId = (sep === -1 ? trimmed : trimmed.slice(0, sep)).trim();
    if (planetId && planetId !== '0') out.push(planetId);
  }
  return out;
}

/**
 * Score an attribute 0..1 against the class's own min/max, not the global
 * 1..1000 range. A 700 Overall Quality is excellent on a class capped at 750
 * and mediocre on one capped at 1000 — the dashboard shows the former.
 */
export function attributeQuality(
  classId: string,
  attribute: string,
  value: number,
): number | undefined {
  const range = classById.get(classId)?.attributes[attribute];
  if (!range) return undefined;
  if (range.max <= range.min) return 1;
  const q = (value - range.min) / (range.max - range.min);
  return q < 0 ? 0 : q > 1 ? 1 : q;
}

export function attributeCode(attribute: string): string {
  return RESOURCE_ATTRIBUTES[attribute]?.code ?? attribute;
}

export function attributeFromCode(code: string): string | undefined {
  return codeToKey.get(code.toUpperCase());
}

export function attributeLabel(attribute: string): string {
  return RESOURCE_ATTRIBUTES[attribute]?.label ?? attribute;
}

/** The classes a resource dashboard should offer as top-level filters. */
export const RESOURCE_ROOTS: readonly ResourceClass[] = resourceChildren('resource');
