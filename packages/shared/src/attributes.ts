/**
 * Creature attributes (the nine Pre-CU stats).
 *
 * `creature_objects` has 27 `attribute_N` columns. SwgSnapshot only decodes two
 * nine-wide vectors into them: server CreatureObject index 16 writes the
 * current values at offset 0, client CreatureObject index 2 writes the max
 * values at offset 9. Columns 18-26 are schema slack from a third vector that
 * no longer persists, so nothing reads them.
 */
import { crc } from './crc.js';

export const ATTRIBUTE_NAMES = [
  'health',
  'strength',
  'constitution',
  'action',
  'quickness',
  'stamina',
  'mind',
  'focus',
  'willpower',
] as const;

export type AttributeName = (typeof ATTRIBUTE_NAMES)[number];

export const ATTRIBUTE_COUNT = ATTRIBUTE_NAMES.length;

/** Column offsets within `creature_objects`. */
export const ATTRIBUTE_OFFSET_CURRENT = 0;
export const ATTRIBUTE_OFFSET_MAX = 9;

export const ATTRIBUTE_LABELS: Readonly<Record<AttributeName, string>> = {
  health: 'Health',
  strength: 'Strength',
  constitution: 'Constitution',
  action: 'Action',
  quickness: 'Quickness',
  stamina: 'Stamina',
  mind: 'Mind',
  focus: 'Focus',
  willpower: 'Willpower',
};

/** The three regenerating pools, and the two secondaries feeding each. */
export const ATTRIBUTE_POOLS: readonly {
  pool: AttributeName;
  regen: AttributeName;
  max: AttributeName;
}[] = [
  { pool: 'health', regen: 'constitution', max: 'strength' },
  { pool: 'action', regen: 'stamina', max: 'quickness' },
  { pool: 'mind', regen: 'willpower', max: 'focus' },
];

export interface AttributeState {
  readonly name: AttributeName;
  readonly current: number;
  readonly max: number;
  /** Max minus current: what a doctor or medic would need to heal back. */
  readonly deficit: number;
  /** Whether this stat is one of the three regenerating pools. */
  readonly isPool: boolean;
}

const POOL_NAMES = new Set<AttributeName>(ATTRIBUTE_POOLS.map((p) => p.pool));

/**
 * Build the attribute sheet from a raw `creature_objects` row.
 *
 * Accepts anything with `attribute_0`…`attribute_17` keys, case-insensitively,
 * so it works with both the lowercase driver output and Oracle's uppercase
 * column names.
 */
export function readAttributes(row: Record<string, unknown>): AttributeState[] {
  const at = (index: number): number => {
    const value = row[`attribute_${index}`] ?? row[`ATTRIBUTE_${index}`];
    const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? n : 0;
  };

  return ATTRIBUTE_NAMES.map((name, i) => {
    const current = at(ATTRIBUTE_OFFSET_CURRENT + i);
    const max = at(ATTRIBUTE_OFFSET_MAX + i);
    return {
      name,
      current,
      max,
      deficit: Math.max(0, max - current),
      isPool: POOL_NAMES.has(name),
    };
  });
}

// --- Posture ---------------------------------------------------------------

/** `creature_objects.posture`, from swgSharedUtility/Postures.def. */
export const POSTURES: Readonly<Record<number, string>> = {
  0: 'Upright',
  1: 'Crouched',
  2: 'Prone',
  3: 'Sneaking',
  4: 'Blocking',
  5: 'Climbing',
  6: 'Flying',
  7: 'Lying Down',
  8: 'Sitting',
  9: 'Skill Animating',
  10: 'Driving Vehicle',
  11: 'Riding Creature',
  12: 'Knocked Down',
  13: 'Incapacitated',
  14: 'Dead',
};

export function postureLabel(posture: number | null | undefined): string {
  if (posture === null || posture === undefined) return 'Unknown';
  return POSTURES[posture] ?? `Posture ${posture}`;
}

// --- PvP / faction ---------------------------------------------------------

/** `tangible_objects.pvp_type` bit flags, from PvpType.def. */
export const PVP_FLAGS: readonly { bit: number; label: string }[] = [
  { bit: 0x00000001, label: 'Neutral' },
  { bit: 0x00000002, label: 'Covert' },
  { bit: 0x00000004, label: 'Declared' },
  { bit: 0x00000008, label: 'Player' },
  { bit: 0x00000010, label: 'Enemy' },
  { bit: 0x00000020, label: 'Duel' },
];

export function pvpFlagLabels(pvpType: number | null | undefined): string[] {
  if (!pvpType) return [];
  return PVP_FLAGS.filter((f) => (pvpType & f.bit) !== 0).map((f) => f.label);
}

/**
 * `tangible_objects.pvp_faction` holds `Crc::calculate` of the faction name,
 * so the lookup is built by hashing the names rather than pasting magic
 * numbers. Only the two GCW factions matter for the dashboards; anything else
 * renders as neutral.
 */
export const FACTION_NAMES = ['rebel', 'imperial', 'hutt'] as const;

export type FactionName = (typeof FACTION_NAMES)[number];

const factionByCrc = new Map<number, string>([[0, 'Neutral']]);
for (const name of FACTION_NAMES) {
  factionByCrc.set(crc(name), name.charAt(0).toUpperCase() + name.slice(1));
}

export function factionCrc(name: FactionName): number {
  return crc(name);
}

export function factionLabel(factionCrc: number | null | undefined): string {
  if (factionCrc === null || factionCrc === undefined) return 'Neutral';
  return factionByCrc.get(factionCrc >>> 0) ?? 'Neutral';
}
