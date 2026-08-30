/**
 * Player city rules, as the server enforces them.
 *
 * Every number here comes from the game's own tables via
 * `scripts/generate-city-data.mjs` — a planner that guessed at radii or
 * footprints would be worse than no planner, because it would look
 * authoritative while quietly misleading someone about what fits.
 */

import rawRanks from '../data/city-ranks.json' with { type: 'json' };
import rawStructures from '../data/city-structures.json' with { type: 'json' };

/**
 * Metres per footprint cell.
 *
 * A footprint's width and height are indices into the world's lot grid, and
 * `World.cpp` builds that grid with a chunk width of 8 metres. Treating a cell
 * as one metre draws every structure at an eighth of its real size.
 */
export const METRES_PER_CELL: number = rawRanks.metresPerCell;

export interface CityRank {
  rank: number;
  /** Buildable radius in metres — the circle a planner draws. */
  radius: number;
  /** Citizens required to reach this rank. */
  citizens: number;
  nameKey: string | null;
}

export interface CityLimit {
  scene: string;
  maxCities: number;
  mediumCityLimit: number;
  bigCityLimit: number;
}

export interface StructureFootprint {
  width: number;
  height: number;
  pivotX: number;
  pivotZ: number;
  /** One string per row: 'F' occupied, 'H' reserved buffer, '.' free. */
  rows: string[];
  widthMetres: number;
  depthMetres: number;
}

export interface CityStructure {
  template: string;
  stem: string;
  civic: boolean;
  /**
   * Planets this may be placed on, or null when nothing restricts it.
   *
   * The rule is on the deed, not the structure: player_structure.java refuses a
   * placement unless the current scene appears in the deed's
   * `player_structure.deed.scene` list. Corellian styles are
   * corellia+talus, Naboo styles naboo+rori+dantooine, Tatooine styles
   * tatooine+lok+dantooine.
   */
  scenes: string[] | null;
  /** City rank that unlocks this. 0 means no rank gate. */
  cityRank: number;
  cityCost: number;
  /** Lots consumed, or null when the footprint could not be read. */
  lots: number | null;
  maintenanceRate: number;
  powerRate: number;
  isShuttleport: boolean;
  isCloningFacility: boolean;
  isGarage: boolean;
  footprint: StructureFootprint | null;
  nameTable: string | null;
  nameKey: string | null;
  /** Manifest key of the converted model, or null when none resolved. */
  model: string | null;
}

export const CITY_RANKS: CityRank[] = rawRanks.ranks;
export const CITY_LIMITS: CityLimit[] = rawRanks.limits;
export const CITY_STRUCTURES: CityStructure[] = rawStructures as CityStructure[];

/** The highest rank a city can reach. */
export const MAX_CITY_RANK: number = CITY_RANKS.reduce((max, r) => Math.max(max, r.rank), 1);

export function cityRadius(rank: number): number {
  const found = CITY_RANKS.find((r) => r.rank === rank);
  // Clamp rather than return zero: an out-of-range rank should draw the
  // nearest real circle, not collapse the plan to a point.
  if (found) return found.radius;
  const sorted = [...CITY_RANKS].sort((a, b) => a.rank - b.rank);
  return rank < (sorted[0]?.rank ?? 1)
    ? (sorted[0]?.radius ?? 150)
    : (sorted[sorted.length - 1]?.radius ?? 450);
}

/**
 * Civic structures a city of this rank may place.
 *
 * `cityRank` is the rank that unlocks a structure, so a rank-3 city can place
 * everything gated at 3 or below — it does not lose access to what it could
 * already build.
 */
export function structuresForRank(rank: number): CityStructure[] {
  return CITY_STRUCTURES.filter((s) => s.civic && s.cityRank <= rank);
}

/** Player housing, which is placed in cities but costs the owner lots. */
export function housingStructures(): CityStructure[] {
  return CITY_STRUCTURES.filter((s) => !s.civic && s.footprint !== null && s.model !== null);
}

/**
 * Can this structure be placed on this planet?
 *
 * A structure with no scene list has no deed restriction and goes anywhere.
 * That is also what a structure whose deed this project never found looks
 * like, and the two are deliberately treated the same: listing one building
 * too many is a smaller failure than hiding one a player can actually build.
 */
export function buildableOn(structure: CityStructure, scene: string): boolean {
  return structure.scenes === null || structure.scenes.includes(scene);
}

/**
 * Everything a city of this rank can place on this planet — civic and housing.
 *
 * Without the planet filter the palette lists every architectural style in the
 * game, most of which the player cannot place where they are standing.
 */
export function structuresForCity(rank: number, scene: string): CityStructure[] {
  return [
    ...structuresForRank(rank).filter((s) => buildableOn(s, scene)),
    ...housingStructures().filter((s) => buildableOn(s, scene)),
  ];
}

/**
 * Everything buildable on this planet, whatever the city's rank.
 *
 * The palette wants this rather than `structuresForCity`, because rank is not
 * a reason to pretend a building does not exist. Dropping the ones above the
 * current rank produced two opposite failures at once: the three shuttleports
 * are the only rows in the table gated above rank 3, so at the planner's
 * default rank the civic list looked complete while silently missing exactly
 * one building and giving no hint that raising the rank would reveal it -- and
 * the housing half was never rank-gated at all, so the cantinas, hospitals and
 * theatres WERE offered below their rank and then painted red the moment they
 * were placed.
 *
 * Callers pair this with `rankLocks` so a structure above the rank is shown,
 * and shown as locked, instead of being either hidden or silently invalid.
 */
export function placeableOn(scene: string): CityStructure[] {
  return CITY_STRUCTURES.filter(
    (s) => s.footprint !== null && s.model !== null && buildableOn(s, scene),
  );
}

/** Whether a city of this rank is still too small to place this structure. */
export function rankLocks(structure: CityStructure, rank: number): boolean {
  return structure.cityRank > rank;
}

/** A readable label, since the string-table name needs a bundle to resolve. */
export function structureLabel(structure: CityStructure): string {
  const words = structure.stem.replace(/^shared_/, '').split('_').filter(Boolean);
  return words
    .map((w) => (/^s?\d+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Whether a structure at (x, z) fits inside a city of the given radius.
 *
 * Checked against the footprint's corners rather than its centre: a large
 * building centred just inside the boundary still has corners outside it, and
 * the game places from the footprint, not the pivot.
 */
export function fitsInCity(
  structure: CityStructure,
  x: number,
  z: number,
  radius: number,
  rotation = 0,
): boolean {
  const half = halfExtent(structure, rotation);
  for (const cx of [x - half.x, x + half.x]) {
    for (const cz of [z - half.z, z + half.z]) {
      if (Math.hypot(cx, cz) > radius) return false;
    }
  }
  return true;
}

/**
 * Whether two placed structures overlap.
 *
 * Axis-aligned on purpose. Rotation in game snaps to the lot grid, and an
 * exact rotated test would reject placements the game accepts — a planner that
 * is stricter than the server is as misleading as one that is looser.
 */
export function overlaps(
  a: { structure: CityStructure; x: number; z: number; rotation?: number },
  b: { structure: CityStructure; x: number; z: number; rotation?: number },
): boolean {
  const ea = halfExtent(a.structure, a.rotation ?? 0);
  const eb = halfExtent(b.structure, b.rotation ?? 0);
  return Math.abs(a.x - b.x) < ea.x + eb.x && Math.abs(a.z - b.z) < ea.z + eb.z;
}

/**
 * Half the structure's extent, with rotation applied.
 *
 * The UI rotates a footprint in 90-degree steps and draws it rotated, so the
 * collision box has to turn with it — otherwise a building that visibly fits
 * after a rotation is still rejected, and one that visibly overlaps is
 * accepted. At quarter turns this is an exact swap rather than an
 * approximation, which is why only those are offered.
 */
function halfExtent(structure: CityStructure, rotation: number): { x: number; z: number } {
  const width = structure.footprint?.widthMetres ?? METRES_PER_CELL;
  const depth = structure.footprint?.depthMetres ?? METRES_PER_CELL;
  // Normalise to a quarter-turn count; anything between is rounded to the
  // nearest, since the planner only ever produces quarter turns.
  const quarters = Math.abs(Math.round(rotation / (Math.PI / 2)) % 2);
  return quarters === 1 ? { x: depth / 2, z: width / 2 } : { x: width / 2, z: depth / 2 };
}

/**
 * Credits a civic structure costs its city per maintenance cycle.
 *
 * `CITY_COST` in player_structure.tab is a TIER INDEX, not an amount:
 * city.java switches on it to pick a flag, and those flags map to the real
 * figures. The ordering is not monotonic either -- tier 2 is the dearest and
 * tier 4 the cheapest -- so summing the raw column both understates the cost by
 * three orders of magnitude and ranks structures backwards.
 *
 * The city hall is special-cased in the same source: it scales with rank.
 */
const CITY_MAINTENANCE_COSTS: Record<number, number> = {
  // 1 is the city hall, handled below.
  2: 7500, // high
  3: 2000, // medium
  4: 150, // low
  5: 1000, // small garden
  6: 3000, // large garden
};

export function cityMaintenanceCost(tier: number, rank: number): number {
  if (tier === 1) return 1000 + 2500 * Math.max(1, rank);
  return CITY_MAINTENANCE_COSTS[tier] ?? 0;
}

/**
 * How many civic structures a city of this rank may hold.
 *
 * From `getMaxCivicCount` in city.java: `1 + rank * 9`, raised to
 * `1 + rank * 12` by the decoration-increase specialisation. The radius is not
 * the only limit on a plan — a rank 2 city has room on the map for far more
 * than the twenty civic buildings it is allowed — so a planner that checks
 * only for overlap will happily draw a city that cannot be built.
 */
export function maxCivicStructures(rank: number, decorSpecialisation = false): number {
  return 1 + rank * (decorSpecialisation ? 12 : 9);
}

/**
 * How many decorations a city of this rank may hold.
 *
 * From `getMaxDecorationCount` in city.java: `rank * 15`, or `rank * 20` with
 * the decoration-increase specialisation. Note this is zero at rank 0, so an
 * unranked city may place none at all.
 */
export function maxDecorations(rank: number, decorSpecialisation = false): number {
  return rank * (decorSpecialisation ? 20 : 15);
}
