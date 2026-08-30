/**
 * GameObjectType (GOT) lookups.
 *
 * Generated from SharedObjectTemplate.h. The encoding is two-level: a category
 * root has a zero low byte (GOT_weapon = 0x20000) and its subtypes count up
 * from there (GOT_weapon_ranged_pistol = 0x2000a). The bazaar's category tree
 * is exactly this hierarchy, which is why the same table drives both the item
 * classifier and the auction search filters.
 */
import rawTypes from '../data/game-object-types.json' with { type: 'json' };

export interface GameObjectType {
  /** C++ enumerator, e.g. `GOT_armor_body`. */
  readonly name: string;
  /** Enumerator without the prefix, e.g. `armor_body`. */
  readonly id: string;
  readonly value: number;
  /** Value with the low byte masked off — the category this belongs to. */
  readonly category: number;
  readonly isCategoryRoot: boolean;
  /** SOE left placeholder entries in the enum; they never appear on live items. */
  readonly deprecated: boolean;
}

export const GAME_OBJECT_TYPES: readonly GameObjectType[] = rawTypes as readonly GameObjectType[];

const byValue = new Map(GAME_OBJECT_TYPES.map((t) => [t.value, t]));
const byId = new Map(GAME_OBJECT_TYPES.map((t) => [t.id, t]));

export function getGameObjectType(value: number | null | undefined): GameObjectType | undefined {
  if (value === null || value === undefined) return undefined;
  return byValue.get(value);
}

export function getGameObjectTypeById(id: string): GameObjectType | undefined {
  return byId.get(id);
}

/**
 * Human label for a GOT. `armor_body` becomes `Armor Body`; `misc_food_pet`
 * becomes `Misc Food Pet`. Deliberately mechanical — the client's `got_n`
 * string table has nicer names, but it lives in the TRE set and this needs to
 * work with the TRE pipeline switched off.
 */
export function gameObjectTypeLabel(value: number | null | undefined): string {
  const type = getGameObjectType(value);
  if (!type) return value ? `Type ${value}` : 'Unknown';
  return type.id
    .replace(/_DUMMY$/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** All category roots, in enum order — the top level of the bazaar tree. */
export const GOT_CATEGORIES: readonly GameObjectType[] = GAME_OBJECT_TYPES.filter(
  (t) => t.isCategoryRoot && !t.deprecated && t.value !== 0,
);

/** Subtypes of a category, excluding the root itself. */
export function gotSubtypes(category: number): readonly GameObjectType[] {
  return GAME_OBJECT_TYPES.filter(
    (t) => t.category === category && !t.isCategoryRoot && !t.deprecated,
  );
}

export interface GotCategoryNode {
  readonly type: GameObjectType;
  readonly label: string;
  readonly children: readonly { type: GameObjectType; label: string }[];
}

/** The full two-level tree, ready to render as bazaar category filters. */
export function gotCategoryTree(): readonly GotCategoryNode[] {
  return GOT_CATEGORIES.map((root) => ({
    type: root,
    label: gameObjectTypeLabel(root.value),
    children: gotSubtypes(root.value).map((child) => ({
      type: child,
      label: gameObjectTypeLabel(child.value),
    })),
  }));
}

// --- Semantic groupings the dashboards care about --------------------------

const asValue = (id: string): number => byId.get(id)?.value ?? -1;

/** Container types that show up as a player's storage in the character view. */
export const STORAGE_GOTS: readonly number[] = [
  asValue('misc_container'),
  asValue('misc_container_wearable'),
  asValue('misc_factory_crate'),
].filter((v) => v >= 0);

export const VENDOR_GOTS: readonly number[] = [
  asValue('vendor'),
  asValue('data_vendor_control_device'),
].filter((v) => v >= 0);

export const INSTALLATION_CATEGORY = asValue('installation');
export const BUILDING_CATEGORY = asValue('building');
export const CREATURE_CATEGORY = asValue('creature');

export function isInstallation(value: number | null | undefined): boolean {
  return getGameObjectType(value)?.category === INSTALLATION_CATEGORY;
}

export function isBuilding(value: number | null | undefined): boolean {
  return getGameObjectType(value)?.category === BUILDING_CATEGORY;
}

export function isVendor(value: number | null | undefined): boolean {
  return value !== null && value !== undefined && VENDOR_GOTS.includes(value);
}
