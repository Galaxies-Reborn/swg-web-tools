/**
 * What is already standing on the ground a city is going onto.
 *
 * Exported per planet from the world snapshot, reduced to the things a plan has
 * to go around -- buildings, walls, rocks -- with the litter, the furniture and
 * the sound emitters removed. A planet is a few thousand of these, so the file
 * is fetched once and the handful near a site are picked out of it.
 *
 * Footprints are the converted model's own bounds. The snapshot also carries a
 * `radius`, which is tempting and wrong: it is the server's network update
 * range and reaches hundreds of metres for a fence post.
 */

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE ?? '/assets';

/** Parallel arrays, as written by `tre-extract blockers`. */
interface BlockerFile {
  planet: string;
  count: number;
  models: string[];
  model: number[];
  x: number[];
  z: number[];
  yaw: number[];
  halfX: number[];
  halfZ: number[];
  height: number[];
}

export interface Blocker {
  model: string;
  x: number;
  z: number;
  yaw: number;
  /** Half-extents in metres, before rotation. */
  halfX: number;
  halfZ: number;
  height: number;
}

export class BlockerSet {
  private constructor(
    readonly planet: string,
    private readonly all: Blocker[],
  ) {}

  static fromFile(file: BlockerFile): BlockerSet {
    const all: Blocker[] = [];
    for (let i = 0; i < file.count; i += 1) {
      all.push({
        model: file.models[file.model[i]] ?? '',
        x: file.x[i],
        z: file.z[i],
        yaw: file.yaw[i],
        halfX: file.halfX[i],
        halfZ: file.halfZ[i],
        height: file.height[i],
      });
    }
    return new BlockerSet(file.planet, all);
  }

  get size(): number {
    return this.all.length;
  }

  /**
   * Those within `radius` of a point, in the plan's own space.
   *
   * Returned relative to the site, because that is the space the planner works
   * in -- its origin is the city centre, not the planet's. Doing the shift here
   * keeps world coordinates out of the canvas entirely.
   */
  near(centreX: number, centreZ: number, radius: number): Blocker[] {
    const out: Blocker[] = [];
    for (const blocker of this.all) {
      const dx = blocker.x - centreX;
      const dz = blocker.z - centreZ;
      // Its own extent counts: a building whose centre is outside the radius
      // can still have a wall inside it.
      const reach = radius + Math.max(blocker.halfX, blocker.halfZ);
      if (dx * dx + dz * dz > reach * reach) continue;
      out.push({ ...blocker, x: dx, z: dz });
    }
    return out;
  }
}

export async function loadBlockers(planet: string): Promise<BlockerSet | null> {
  try {
    const response = await fetch(`${ASSET_BASE}/blockers/${planet}.json`);
    if (!response.ok) return null;
    return BlockerSet.fromFile((await response.json()) as BlockerFile);
  } catch {
    // Not exported for this planet. The planner works without them; it simply
    // cannot warn about what it does not know is there.
    return null;
  }
}

/**
 * Does a footprint of this size at this spot hit something already standing?
 *
 * Axis-aligned on both sides. Rotation is quantised to quarter turns in the
 * planner, and a blocker's yaw is arbitrary, so an exact oriented-box test
 * would be more precise than the data deserves -- the footprints are model
 * bounding boxes, not the buildings themselves. Erring towards "occupied" is
 * the right way to be wrong here: it warns about a spot that might be fine,
 * rather than staying quiet about one that is not.
 */
export function hitsBlocker(
  x: number,
  z: number,
  halfWidth: number,
  halfDepth: number,
  blockers: Blocker[],
): Blocker | null {
  for (const blocker of blockers) {
    // A quarter-turned blocker swaps its extents; anything else is bounded by
    // the larger of the two, which keeps this conservative.
    const quarter = Math.abs(Math.round(blocker.yaw / (Math.PI / 2)) % 2) === 1;
    const bx = quarter ? blocker.halfZ : blocker.halfX;
    const bz = quarter ? blocker.halfX : blocker.halfZ;
    if (Math.abs(x - blocker.x) < halfWidth + bx && Math.abs(z - blocker.z) < halfDepth + bz) {
      return blocker;
    }
  }
  return null;
}
