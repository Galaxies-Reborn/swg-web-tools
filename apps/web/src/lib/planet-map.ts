/**
 * A whole planet's ground, at the resolution a whole planet can be looked at.
 *
 * The full bake is 2048 x 2048 samples -- 8.4 MB, which is not something to
 * hand a browser that wants to see a world. So a planet ships an overview
 * alongside its tiles: the same ground at 32 m, 512 x 512, about a third of a
 * megabyte. That is 32 m per sample across 16 km, which is plenty to pick out
 * coastlines, mountain ranges and the flats worth building on.
 *
 * The overview is downsampled by MINIMUM rather than mean, which is why a river
 * still reads as a river here: averaging a valley against its banks lifts the
 * water out of it until the channel disappears.
 */

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE ?? '/assets';

export const FLAG_WATER = 0x01;
export const FLAG_SLOPE = 0x02;

export interface PlanetMeta {
  planet: string;
  mapWidth: number;
  spacing: number;
  samples: number;
  tileSamples: number;
  tiles: number;
  minHeight: number;
  maxHeight: number;
  originX: number;
  originZ: number;
  overview: string;
  overviewFlags: string;
  overviewSamples: number;
  overviewSpacing: number;
}

export class PlanetOverview {
  constructor(
    readonly meta: PlanetMeta,
    /** Decimetres, row-major from the south-west corner. */
    private readonly heights: Int16Array,
    private readonly flags: Uint8Array,
  ) {}

  get samples(): number {
    return this.meta.overviewSamples;
  }

  get spacing(): number {
    return this.meta.overviewSpacing;
  }

  /**
   * Sample column/row for a world coordinate, clamped into the map.
   *
   * Floor, not round. An overview sample is not a point measured at its own
   * coordinate -- it is the aggregate of a 32 m BLOCK of the 8 m bake, so
   * sample c covers [originX + 32c, originX + 32c + 32) and floor is what
   * names the block a coordinate falls in.
   *
   * Rounding instead treated the sample as a point sitting on the block's near
   * edge, which put the lookup half a cell out of step with the mesh, whose
   * vertices sit at the block CENTRES. Measured over all 512 columns, round
   * resolved 511 of them to the neighbouring cell; floor resolves all 512
   * correctly. That misregistration is why the site marker hung above or sank
   * into the ground under it, and why the ground/relief/water readings
   * described a spot 32 m away from the one clicked.
   */
  private cell(world: number, origin: number): number {
    const index = Math.floor((world - origin) / this.spacing);
    return Math.min(Math.max(index, 0), this.samples - 1);
  }

  heightAt(x: number, z: number): number {
    const col = this.cell(x, this.meta.originX);
    const row = this.cell(z, this.meta.originZ);
    return this.heights[row * this.samples + col] / 10;
  }

  isWater(x: number, z: number): boolean {
    const col = this.cell(x, this.meta.originX);
    const row = this.cell(z, this.meta.originZ);
    return (this.flags[row * this.samples + col] & FLAG_WATER) !== 0;
  }

  /** True while the coordinate is on the planet at all. */
  contains(x: number, z: number): boolean {
    const half = this.meta.mapWidth / 2;
    return x >= -half && x <= half && z >= -half && z <= half;
  }

  get grid(): { samples: number; spacing: number; heights: Int16Array; flags: Uint8Array } {
    return {
      samples: this.samples,
      spacing: this.spacing,
      heights: this.heights,
      flags: this.flags,
    };
  }
}

export async function loadPlanetOverview(planet: string): Promise<PlanetOverview | null> {
  const base = `${ASSET_BASE}/terrain/${planet}`;
  try {
    const metaResponse = await fetch(`${base}/planet.json`);
    if (!metaResponse.ok) return null;
    const meta = (await metaResponse.json()) as PlanetMeta;

    const [heightBuffer, flagBuffer] = await Promise.all([
      fetch(`${base}/${meta.overview}`).then((r) => r.arrayBuffer()),
      fetch(`${base}/${meta.overviewFlags}`).then((r) => r.arrayBuffer()),
    ]);

    const expected = meta.overviewSamples * meta.overviewSamples;
    const heights = new Int16Array(heightBuffer);
    const flags = new Uint8Array(flagBuffer);
    if (heights.length !== expected || flags.length !== expected) {
      console.error(
        `planet overview ${planet} is the wrong size: ${heights.length}/${flags.length}, ` +
          `expected ${expected}`,
      );
      return null;
    }
    return new PlanetOverview(meta, heights, flags);
  } catch {
    // No bake for this planet yet.
    return null;
  }
}

/**
 * Every planet a bake might exist for.
 *
 * Listed rather than discovered because a static asset tree has no index to
 * read, and a fetch per planet to find out is worse than a list that goes
 * stale slowly.
 */
export const MAPPABLE_PLANETS = [
  'tatooine',
  'naboo',
  'corellia',
  'rori',
  'talus',
  'dantooine',
  'dathomir',
  'endor',
  'lok',
  'yavin4',
  // Baked from the same client, but not Pre-CU ground. Kashyyyk is 8 km rather
  // than the usual 16, which the map reads from each planet's own bake rather
  // than assuming. Mustafar's terrain covers the full 16 km while the travel
  // table gives its playable width as 8,000 -- so the outer ground it draws is
  // real terrain that a player could never stand on.
  'taanab',
  'mustafar',
  'kashyyyk',
] as const;
