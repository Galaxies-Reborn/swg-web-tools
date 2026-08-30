/**
 * Ship chassis and components, as the server defines them.
 *
 * The engine enforces exactly two things when installing a component
 * (`ShipObject::canInstallComponent`): the slot must accept the component's
 * compatibility token, and the loadout's total mass must stay within the
 * chassis budget. Everything else a loadout tool shows is presentation.
 *
 * Mass is the interesting constraint, not a formality. An X-wing's budget is
 * 10,000 and the heaviest weapon in the game masses 65,800 — so a loadout is a
 * real budgeting problem rather than a matter of picking the best of each.
 */

import rawChassis from '../data/ship-chassis.json' with { type: 'json' };
import rawPaint from '../data/ship-paint.json' with { type: 'json' };
import rawComponents from '../data/ship-components.json' with { type: 'json' };

export interface ChassisSlot {
  /** Slot name, e.g. `weapon_0`, `engine`, `armor_1`. */
  slot: string;
  /**
   * Tokens this slot accepts. A set, not a single value: a gunship's reactor
   * slot takes rct_0 or rct_gunship, and the engine tokenises the cell and
   * searches it rather than comparing the whole string.
   */
  compatibility: string[];
}

export interface ShipChassis {
  name: string;
  label: string;
  template: string | null;
  /** Manifest key of the converted hull, or null when none resolved. */
  model: string | null;
  /** Total mass the loadout may occupy. */
  massMax: number;
  /** Speed multiplier while the wings are open; 1 means the hull has none. */
  wingOpenSpeedFactor?: number;
  /** True when massMax is the shiptype placeholder, not a craft schematic. */
  massMaxIsFallback?: boolean;
  hitPoints: number;
  slots: ChassisSlot[];
}

export interface ShipComponent {
  name: string;
  label: string;
  template: string;
  type: string;
  compatibility: string;
  /** Null when the component has no stat row; it cannot be mass-checked. */
  mass: number | null;
  energyMaintenance: number | null;
  stats: Record<string, number | string> | null;
  model: string | null;
}

export const SHIP_SLOT_TYPES: string[] = rawChassis.slots;
export const SHIP_CHASSIS: ShipChassis[] = rawChassis.chassis;
export const SHIP_COMPONENTS: ShipComponent[] = rawComponents as ShipComponent[];

const byName = new Map(SHIP_COMPONENTS.map((c) => [c.name, c]));
const byTemplate = new Map(SHIP_COMPONENTS.map((c) => [c.template, c]));

export function chassisByName(name: string): ShipChassis | undefined {
  return SHIP_CHASSIS.find((c) => c.name === name);
}

export function componentByName(name: string): ShipComponent | undefined {
  return byName.get(name);
}

export function componentByTemplate(template: string): ShipComponent | undefined {
  return byTemplate.get(template);
}

/**
 * Components a given slot will accept.
 *
 * Matched on the compatibility token rather than the component type, because
 * they are not the same thing: a missile launcher and a countermeasure
 * dispenser are both `weapon` components, and it is the token that decides
 * which of a chassis's weapon slots each can go in.
 */
export function componentsForSlot(chassis: ShipChassis, slot: string): ShipComponent[] {
  const definition = chassis.slots.find((s) => s.slot === slot);
  if (!definition) return [];
  return SHIP_COMPONENTS.filter((c) => {
    if (!definition.compatibility.includes(c.compatibility)) return false;
    // ShipObject::canInstallComponent enforces the compatibility token above
    // and a total-mass ceiling, so a component heavier than the whole budget
    // cannot be installed on this hull in any loadout.
    //
    // Only applied when the budget is the one the engine actually checks. That
    // is getChassisComponentMassMaximum(), set from the chassis deed out of the
    // shipwright's draft schematic -- NOT shiptype.tab, whose player-hull
    // figures are a flat 10000 placeholder about ten times too low. Filtering on
    // the placeholder hid 34% of every list, including components that fit with
    // room to spare. Where no schematic was found the budget is still the
    // placeholder, and a bound that cannot be trusted is not used to hide
    // anything.
    //
    // A component with no stat row has unknown mass, not disqualifying mass, so
    // it stays; the totals panel already reports it as unknown.
    if (chassis.massMaxIsFallback) return true;
    if (typeof c.mass === 'number' && chassis.massMax > 0 && c.mass > chassis.massMax) {
      return false;
    }
    return true;
  });
}

export interface LoadoutTotals {
  mass: number;
  massMax: number;
  /** Negative when the loadout is over budget. */
  massRemaining: number;
  overweight: boolean;
  /** Components installed in slots that do not accept them. */
  incompatible: string[];
  /** Installed components with no stat row, so their mass is unknown. */
  unknownMass: string[];
  energyMaintenance: number;
}

/**
 * Total a loadout against its chassis.
 *
 * A component with no stat row is reported separately rather than counted as
 * zero: treating unknown mass as free would show a loadout as fitting when
 * nobody can say whether it does.
 */
export function totalsFor(
  chassis: ShipChassis,
  components: Record<string, string | null>,
): LoadoutTotals {
  let mass = 0;
  let energyMaintenance = 0;
  const incompatible: string[] = [];
  const unknownMass: string[] = [];

  for (const [slot, name] of Object.entries(components)) {
    if (!name) continue;
    const component = byName.get(name);
    if (!component) continue;

    const definition = chassis.slots.find((s) => s.slot === slot);
    if (!definition || !definition.compatibility.includes(component.compatibility)) {
      incompatible.push(slot);
    }

    if (component.mass === null) unknownMass.push(slot);
    else mass += component.mass;

    energyMaintenance += component.energyMaintenance ?? 0;
  }

  return {
    mass,
    massMax: chassis.massMax,
    massRemaining: chassis.massMax - mass,
    overweight: mass > chassis.massMax,
    incompatible,
    unknownMass,
    energyMaintenance,
  };
}

/**
 * Slots that are visible on the outside of a ship.
 *
 * A reactor, shield, capacitor or armour plate has no external part in the
 * game either -- they are internal components, and a hull exposes no hardpoint
 * for them. Distinguishing these from a genuine miss matters: it is the
 * difference between "nothing to draw" and "we could not work out where this
 * goes".
 */
const VISIBLE_SLOTS = /^(weapon_\d+|engine|booster|droid_interface)$/;

export function isVisibleSlot(slot: string): boolean {
  return VISIBLE_SLOTS.test(slot);
}

/**
 * Hardpoint names a slot's part might hang from, best first.
 *
 * Derived from the names the hulls actually carry rather than invented: across
 * every player chassis the vocabulary is `weapon#`, `muzzle#`, `missile#`,
 * `engine#`, `booster#` and `astromech`, one-based. A first guess of
 * `weapon1_pos1` matched 21 slots of 181; these names are what the models use.
 *
 * Returns an empty list for internal slots, so a caller can tell a component
 * that is not meant to be seen from one it failed to place.
 */
export function hardpointCandidates(slot: string): string[] {
  const weapon = /^weapon_(\d+)$/.exec(slot);
  if (weapon) {
    // Slots are zero-based, hardpoints one-based.
    const n = Number(weapon[1]) + 1;
    return [`weapon${n}`, `muzzle${n}`, `missile${n}`, `pilotmuzzle${n}`, `weapon${n}_1`];
  }
  if (slot === 'engine') return ['engine1', 'engine_glow1', 'exhaust1'];
  if (slot === 'booster') return ['booster1', 'booster_on1'];
  if (slot === 'droid_interface') return ['astromech'];
  return [];
}

/**
 * The chassis-specific part a component would actually show on this hull, or
 * null when there is nothing correct to draw.
 *
 * This is the difference between a viewer that looks like the game and one
 * that looks broken. A component's own model is almost always its *inventory*
 * appearance -- `ship_component_engine_s01` is the crate you see in a
 * container, not the engine on the ship. 1,191 of 1,232 components resolve to
 * one of those. Hanging it on an engine hardpoint would bolt a crate to the
 * hull.
 *
 * The parts the game actually shows are named per chassis and per style:
 * `xwing_engine_neg_s01`, `xwing_booster_pos_s02`, `bwing_weapon1_s01`. Only a
 * model following that convention *for this hull* is safe to attach, so
 * anything else returns null and the caller shows the bare hull instead.
 *
 * A stricter mapping -- which style index a given component selects -- is not
 * in the data this project has, so the honest ceiling is "draw the parts we can
 * identify, and say so for the rest".
 */
export function shipPartFor(chassis: ShipChassis, component: ShipComponent): string | null {
  if (!component.model) return null;
  const base = component.model.split('/').pop() ?? '';
  // Every inventory appearance is named `ship_component_*`, so a stem of
  // "ship" matches all 1,191 of them — the exact set this function exists to
  // reject. `player_hutt_turret_ship` and `player_y8_mining_ship` both end in
  // that word, so an unguarded last-word stem re-opened the crate bug on two
  // chassis.
  if (base.startsWith('ship_component_')) return null;

  const stem = chassis.name.replace(/^player_/, '');
  // `player_advanced_xwing` and `player_xwing` share `xwing_*` parts, so the
  // last word is tried as well as the whole stem — but only when it is
  // distinctive enough to name a hull.
  const shortStem = stem.split('_').pop() ?? stem;
  const usableShortStem = shortStem.length >= 3 && shortStem !== 'ship' ? shortStem : null;

  const belongs =
    base.startsWith(`${stem}_`) ||
    (usableShortStem !== null && base.startsWith(`${usableShortStem}_`));
  return belongs ? component.model : null;
}

/**
 * One palette-driven colour a hull can be painted.
 *
 * `textureTag` names the sampler whose alpha masks where the colour lands, so
 * a paint only tints the parts the artist marked — an X-wing's flame markings
 * are about 8% of its hull. `defaultIndex` is the scheme the hull ships with.
 */
export interface PaintChannel {
  variable: string;
  textureTag: string;
  palette: string;
  defaultIndex: number;
  /** The palette's colours as #rrggbb, indexed as the game indexes them. */
  colours: string[];
}

/**
 * One pattern: a matched set of textures the colours are painted through.
 *
 * Every channel on a hull is driven by the same customisation variable, so
 * choosing a pattern binds one option in each at once — the sets go together
 * rather than being picked independently.
 */
export interface PaintPattern {
  index: number;
  /** Where the primary colour lands, or null when the texture has no alpha. */
  primaryMask: string | null;
  secondaryMask: string | null;
}

/**
 * One model's contribution to a hull's paint.
 *
 * A chassis draws more than one model — a fuselage and its wings — and each is
 * painted from its OWN textures by the SAME customisation variables. Leaving
 * the wings out left them showing the raw magenta the game paints over.
 */
export interface PaintModel {
  /** The one glTF material on this model the paint belongs to. */
  material: string | null;
  patterns: PaintPattern[];
}

export interface ShipPaint {
  chassis: string;
  channels: PaintChannel[];
  /** Keyed by manifest model key: the hull, then any structural models. */
  models: Record<string, PaintModel>;
}

const SHIP_PAINT = rawPaint as Record<string, ShipPaint>;

/**
 * The paint schemes a hull offers, or null when its shaders declare none.
 *
 * Not every chassis is paintable: 42 of 67 carry hue channels, and the rest
 * are painted into their texture with no customisation variable at all.
 */
export function paintForChassis(chassis: string): ShipPaint | null {
  return SHIP_PAINT[chassis] ?? null;
}

/**
 * How many patterns a hull offers.
 *
 * The models a chassis draws do NOT all share one pattern set. They are
 * painted by the same customisation variable, but each reads it into its own
 * shader's list, and those lists differ in length because they come from
 * different materials -- the X-wing's cannons use `xwing_main_s01_swap_sm_as9`
 * with two, while the seven models on `xwing_main_swap_hcsc22` have six.
 *
 * So this is the largest list, not the smallest. Taking the smallest let one
 * two-pattern cannon cap the whole ship at two and hide the four schemes the
 * fuselage actually wears. Every index offered here is a real pattern on at
 * least one model, and `patternForModel` clamps the models that have fewer, so
 * nothing is left unpainted by a high index.
 */
export function patternCountForChassis(chassis: string): number {
  const paint = SHIP_PAINT[chassis];
  if (!paint) return 0;
  const counts = Object.values(paint.models).map((m) => m.patterns.length);
  return counts.length ? Math.max(...counts) : 0;
}

/**
 * The pattern a given model wears at a hull-wide index.
 *
 * Clamped rather than looked up directly: the index spans the hull's largest
 * pattern list, and a model with a shorter one would otherwise fall off the end
 * and render with no mask at all -- the raw magenta the paint exists to cover.
 */
export function patternForModel(model: PaintModel, index: number): PaintPattern | null {
  if (model.patterns.length === 0) return null;
  const clamped = Math.min(Math.max(index, 0), model.patterns.length - 1);
  return model.patterns[clamped] ?? null;
}

/**
 * The chassis a player can actually fly and outfit.
 *
 * Two are excluded, both by what the data says rather than by name. A capital
 * ship declares `bridge` and `hangar` slots, which no fighter has — that is the
 * Star Destroyer and the Corvette, neither of which a player pilots. And a
 * chassis with no converted hull has nothing to show; `player_test_falcon` is
 * the only one, and it is a test asset.
 */
export function playerFlyableChassis(): ShipChassis[] {
  return SHIP_CHASSIS.filter((c) => {
    if (!c.model) return false;
    return !c.slots.some((s) => s.slot === 'bridge' || s.slot === 'hangar');
  });
}

/**
 * Whether a hull's wings open, and what it costs to fly with them out.
 *
 * ShipObject::calculateSpeed multiplies top speed by wing_open_speed_factor
 * while C_wingsOpened is set, so a value below 1 both marks the hull as having
 * S-foils and says what opening them costs. Five player hulls carry one — the
 * X-wing and its advanced variant, the B-wing, the V-wing and the T-wing — all
 * at 0.95.
 */
export function wingsOf(chassis: ShipChassis): { opens: boolean; speedFactor: number } {
  const factor = chassis.wingOpenSpeedFactor ?? 1;
  return { opens: factor > 0 && factor !== 1, speedFactor: factor };
}
