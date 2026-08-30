/**
 * Decorations a player can put down, and the room each one takes.
 *
 * The volume is the object's own collision extent where it has one, and its
 * render bounds where it does not -- which is what the engine falls back to,
 * not a guess of ours. `shape` says which you got, because they are not equally
 * exact and a planner should not present them as though they were.
 */

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE ?? '/assets';

export interface Prop {
  template: string;
  model: string;
  name: string;
  /** Half-extents in metres, before rotation. */
  halfX: number;
  halfZ: number;
  height: number;
  /**
   * Where the volume came from.
   *
   * `box`, `sphere`, `cylinder` are the object's real collision extent.
   * `bounds` is its render extent standing in for one.
   * `mesh`, `cmpt`, `dtal` are complex shapes reduced outward to a box.
   */
  shape: 'box' | 'sphere' | 'cylinder' | 'bounds' | 'mesh' | 'cmpt' | 'dtal';
  /** False for ornaments too small to obstruct anything. */
  collides: boolean;
}

/** A prop put down in a plan. */
export interface PlacedProp {
  id: string;
  prop: Prop;
  x: number;
  z: number;
  rotation: number;
}

export async function loadProps(): Promise<Prop[]> {
  try {
    const response = await fetch(`${ASSET_BASE}/props.json`);
    if (!response.ok) return [];
    const body = (await response.json()) as { props: Prop[] };
    return body.props ?? [];
  } catch {
    // Not exported. The planner simply offers no props.
    return [];
  }
}

/** Half-extents with a quarter turn applied, matching how structures rotate. */
export function propExtent(placed: PlacedProp): { halfX: number; halfZ: number } {
  const quarter = Math.abs(Math.round(placed.rotation / (Math.PI / 2)) % 2) === 1;
  return quarter
    ? { halfX: placed.prop.halfZ, halfZ: placed.prop.halfX }
    : { halfX: placed.prop.halfX, halfZ: placed.prop.halfZ };
}

/**
 * Does a footprint here hit a prop already put down?
 *
 * Only props that collide are considered. A cup on a table is placeable and
 * takes no room, and treating it as an obstacle would make a decorated plan
 * impossible to finish.
 */
export function hitsProp(
  x: number,
  z: number,
  halfWidth: number,
  halfDepth: number,
  placed: PlacedProp[],
  ignoreId?: string,
): PlacedProp | null {
  for (const other of placed) {
    if (other.id === ignoreId) continue;
    if (!other.prop.collides) continue;
    const extent = propExtent(other);
    if (
      Math.abs(x - other.x) < halfWidth + extent.halfX &&
      Math.abs(z - other.z) < halfDepth + extent.halfZ
    ) {
      return other;
    }
  }
  return null;
}
