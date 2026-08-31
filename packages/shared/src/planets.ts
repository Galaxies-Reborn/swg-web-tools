/**
 * Scene (planet) metadata.
 *
 * `id` is the value stored in `objects.scene_id` and used by every server
 * message. Widths come from dsrc datatables/travel/planet_width.tab — every
 * Pre-CU ground planet is 16384 units across, centred on the origin, so world
 * coordinates run -8192..8192 on both X and Z.
 *
 * A width here is the PLAYABLE extent, which is not always the extent of the
 * generated ground. Mustafar is the case that shows it: the travel table gives
 * 8,000 while its .trn generates terrain across the full 16,384. Both are
 * right for their own purpose, so anything drawing terrain should take its
 * size from the bake rather than from here.
 */

export type PlanetEra = 'precu' | 'expansion' | 'space' | 'instance';

export interface Planet {
  /** `scene_id` as stored in the game database. */
  readonly id: string;
  readonly name: string;
  /** Terrain width in world units. Half of this is the coordinate extent. */
  readonly width: number;
  readonly era: PlanetEra;
  /** Whether players can place structures here. Drives the lot map. */
  readonly playerHousing: boolean;
}

const ground = (
  id: string,
  name: string,
  opts: { width?: number; era?: PlanetEra; playerHousing?: boolean } = {},
): Planet => ({
  id,
  name,
  width: opts.width ?? 16384,
  era: opts.era ?? 'precu',
  playerHousing: opts.playerHousing ?? true,
});

export const PLANETS: readonly Planet[] = [
  ground('corellia', 'Corellia'),
  ground('dantooine', 'Dantooine'),
  ground('dathomir', 'Dathomir'),
  ground('endor', 'Endor'),
  ground('lok', 'Lok'),
  ground('naboo', 'Naboo'),
  ground('rori', 'Rori'),
  ground('talus', 'Talus'),
  ground('tatooine', 'Tatooine'),
  ground('yavin4', 'Yavin IV'),
  ground('tutorial', 'Tutorial', { playerHousing: false }),
  ground('kashyyyk_main', 'Kashyyyk', { width: 4096, era: 'expansion' }),
  ground('mustafar', 'Mustafar', { width: 8000, era: 'expansion' }),
  // Scenes the client generates terrain for that planet_width.tab does not
  // list, so their widths are the ones their own .trn declares. Neither takes
  // player structures, and neither is Pre-CU, so both stay out of
  // HOUSING_PLANETS by era.
  //
  // `kashyyyk` is the 8 km world; `kashyyyk_main` above is the 4 km village
  // zone inside it, and is the one the travel table sends players to.
  ground('taanab', 'Taanab', { era: 'expansion', playerHousing: false }),
  ground('kashyyyk', 'Kashyyyk', { width: 8192, era: 'expansion', playerHousing: false }),
] as const;

const byId = new Map(PLANETS.map((p) => [p.id, p]));

export function getPlanet(sceneId: string | null | undefined): Planet | undefined {
  if (!sceneId) return undefined;
  return byId.get(sceneId);
}

export function planetName(sceneId: string | null | undefined): string {
  return getPlanet(sceneId)?.name ?? sceneId ?? 'Unknown';
}

/** Planets a player can own a structure on, in the order the UI should list them. */
export const HOUSING_PLANETS: readonly Planet[] = PLANETS.filter(
  (p) => p.playerHousing && p.era === 'precu',
);

/** Half-width of a scene: world coords run -extent..+extent on X and Z. */
export function planetExtent(sceneId: string): number {
  return (getPlanet(sceneId)?.width ?? 16384) / 2;
}

/**
 * Convert world coordinates to normalised map coordinates in the range 0..1,
 * with (0,0) at the north-west corner — the orientation the in-game planet map
 * uses. Z increases north in world space, so it is flipped.
 */
export function worldToMap(sceneId: string, x: number, z: number): { u: number; v: number } {
  const extent = planetExtent(sceneId);
  return {
    u: clamp01((x + extent) / (extent * 2)),
    v: clamp01(1 - (z + extent) / (extent * 2)),
  };
}

export function mapToWorld(sceneId: string, u: number, v: number): { x: number; z: number } {
  const extent = planetExtent(sceneId);
  return {
    x: u * extent * 2 - extent,
    z: (1 - v) * extent * 2 - extent,
  };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** In-game waypoint style coordinate label, e.g. `-1342, 2915`. */
export function formatCoords(x: number, z: number): string {
  return `${Math.round(x)}, ${Math.round(z)}`;
}
