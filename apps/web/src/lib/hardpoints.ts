import * as THREE from 'three';

/**
 * A hardpoint's transform in the frame that CONTAINS its model.
 *
 * Composed from local matrices walking up the parent chain rather than read off
 * matrixWorld, for two reasons. It is correct on the first render, before three
 * has updated any world matrix -- and it deliberately excludes whatever the
 * model's own group is doing, which is the point: a part mounted on a wing is
 * drawn inside that wing's group, so it must be positioned in the wing's frame
 * and then inherit the roll, rather than have the roll baked into its position
 * and applied a second time.
 *
 * The walk includes the root's own transform and stops there, because the
 * caller renders as a sibling of the root and that is the frame it lands in.
 */
export function transformWithinModel(
  node: THREE.Object3D,
  root: THREE.Object3D,
): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  let current: THREE.Object3D | null = node;
  while (current) {
    current.updateMatrix();
    matrix.premultiply(current.matrix);
    if (current === root) break;
    current = current.parent;
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// Resolving a hardpoint to the model that carries it.
//
// The canvas keeps every model it has mounted in one registry, which outlives a
// change of chassis: it is a ref, so looking at one ship and then another
// leaves the first ship's wings in it. Hardpoint names are not unique between
// ships -- `engine1`, `booster1` and `weapon1` are on most of them -- so a
// lookup across the whole registry can answer with a model belonging to a ship
// that is no longer on screen.
//
// That is not a cosmetic mistake. The canvas draws a part inside its owning
// structural model, or against the hull when nothing else owns its hardpoint.
// An owner from another chassis matches neither, so the part is dropped by both
// and never drawn at all -- which is exactly how engines, boosters and weapons
// went missing on hutt ships after a blacksun ship had been looked at.
//
// Both lookups therefore take the set of models the CURRENT ship is made of,
// and ignore everything else in the registry.
// ---------------------------------------------------------------------------

/** What a model contributes: its hardpoints, by lowercased name. */
export type HardpointRegistry<T> = Iterable<readonly [string, ReadonlyMap<string, T>]>;

/**
 * Which of this ship's models carries a hardpoint, or null when the hull does.
 *
 * Null is meaningful: it is what tells the canvas to draw the part against the
 * hull rather than inside a structural model.
 */
export function ownerOfHardpoint<T>(
  registry: HardpointRegistry<T>,
  shipModels: ReadonlySet<string>,
  hull: string,
  hardpoint: string,
): string | null {
  const key = hardpoint.toLowerCase();
  for (const [model, points] of registry) {
    if (model === hull) continue;
    if (!shipModels.has(model)) continue;
    if (points.has(key)) return model;
  }
  return null;
}

/**
 * A hardpoint anywhere on this ship, preferring one model's own copy.
 *
 * `preferred` matters where the same name appears on more than one of a ship's
 * models -- an X-wing has `contrail1` on both wings -- and the part belongs to
 * the one it is being drawn inside.
 */
export function findHardpoint<T>(
  registry: HardpointRegistry<T>,
  shipModels: ReadonlySet<string>,
  hardpoint: string,
  preferred?: string | null,
): T | null {
  const key = hardpoint.toLowerCase();
  const entries = [...registry];
  if (preferred) {
    for (const [model, points] of entries) {
      if (model !== preferred) continue;
      const hit = points.get(key);
      if (hit !== undefined) return hit;
    }
  }
  for (const [model, points] of entries) {
    if (!shipModels.has(model)) continue;
    const hit = points.get(key);
    if (hit !== undefined) return hit;
  }
  return null;
}
