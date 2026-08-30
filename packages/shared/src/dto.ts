/**
 * Wire contract between apps/api and apps/web.
 *
 * Every id that comes from the game is a 64-bit NetworkId, so it crosses the
 * wire as a decimal string. Parsing one into a JS number loses precision above
 * 2^53 and silently mismatches; the `objectId` schema exists to make that
 * impossible to do by accident.
 */
import { z } from 'zod';

export const objectId = z.string().regex(/^-?\d{1,20}$/, 'expected a decimal NetworkId');

/**
 * A NetworkId. Kept as a plain string rather than a branded type: the value
 * genuinely is a string everywhere it flows, and branding forced a cast at
 * every database boundary without preventing the mistake that actually
 * matters, which is `Number(objectId)`.
 */
export type ObjectId = z.infer<typeof objectId>;

// --- Common ---------------------------------------------------------------

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pageMeta = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  /** Instant the underlying poller last refreshed this data. */
  asOf: z.string().datetime(),
});

export function paged<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), meta: pageMeta });
}

export const worldLocation = z.object({
  scene: z.string(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  /** Containing cell for indoor positions; null when outdoors. */
  cell: objectId.nullable(),
});
export type WorldLocation = z.infer<typeof worldLocation>;

// --- Galaxy status --------------------------------------------------------

export const galaxyStatus = z.object({
  name: z.string(),
  online: z.boolean(),
  /**
   * Live concurrency, or null when it could not be determined.
   *
   * Null and 0 mean different things: 0 is an empty galaxy, null is a cluster
   * that could not be asked (no console bridge, or a build without the
   * `webadmin` parser). Reporting the latter as 0 would render as "nobody is
   * playing" on the front page.
   */
  playersOnline: z.number().int().nullable(),
  playerLimit: z.number().int(),
  charactersTotal: z.number().int(),
  /** Uptime of the cluster in seconds, or null when it cannot be determined. */
  uptimeSeconds: z.number().int().nullable(),
  lastCheckedAt: z.string().datetime(),
});
export type GalaxyStatus = z.infer<typeof galaxyStatus>;

// --- Bazaar ---------------------------------------------------------------

export const listingKind = z.enum(['auction', 'instant', 'vendor', 'stockroom']);

export const bazaarListing = z.object({
  itemId: objectId,
  name: z.string(),
  category: z.number().int(),
  categoryLabel: z.string(),
  objectTemplateId: z.number().int().nullable(),
  kind: listingKind,
  minBid: z.number().int(),
  buyNowPrice: z.number().int(),
  askingPrice: z.number().int(),
  highBid: z.number().int().nullable(),
  bidCount: z.number().int(),
  sellerId: objectId,
  sellerName: z.string().nullable(),
  location: z.object({
    id: objectId,
    name: z.string(),
    scene: z.string().nullable(),
    /** Human readable, e.g. `Naboo — Theed (Bazaar)`. */
    label: z.string(),
    isVendor: z.boolean(),
  }),
  endsAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  secondsRemaining: z.number().int(),
  description: z.string(),
  attributes: z.array(z.object({ name: z.string(), value: z.string() })),
  /** Populated for resource container listings only. */
  resource: z
    .object({
      resourceId: objectId,
      name: z.string(),
      classId: z.string(),
      className: z.string(),
      quantity: z.number().int(),
      pricePerUnit: z.number(),
    })
    .nullable(),
});
export type BazaarListing = z.infer<typeof bazaarListing>;

export const bazaarQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
  category: z.coerce.number().int().optional(),
  locationId: objectId.optional(),
  scene: z.string().optional(),
  kind: listingKind.optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  sellerId: objectId.optional(),
  resourceClass: z.string().optional(),
  sort: z
    .enum(['price_asc', 'price_desc', 'ending_soon', 'newest', 'name'])
    .default('ending_soon'),
});
export type BazaarQuery = z.infer<typeof bazaarQuery>;

// --- Resources ------------------------------------------------------------

export const spawnedResource = z.object({
  resourceId: objectId,
  name: z.string(),
  classId: z.string(),
  className: z.string(),
  /** Root-to-leaf class chain, for breadcrumb display and filtering. */
  ancestry: z.array(z.object({ id: z.string(), name: z.string() })),
  attributes: z.record(z.string(), z.number().int()),
  /** Per-attribute 0..1 score against this class's own caps. */
  quality: z.record(z.string(), z.number()),
  planets: z.array(z.string()),
  spawnedAt: z.string().datetime().nullable(),
  despawnsAt: z.string().datetime().nullable(),
  /** True while the resource is still spawnable in the wild. */
  active: z.boolean(),
  permanent: z.boolean(),
});
export type SpawnedResource = z.infer<typeof spawnedResource>;

export const resourceQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
  classId: z.string().optional(),
  planet: z.string().optional(),
  status: z.enum(['active', 'despawned', 'all']).default('active'),
  /** Filter to resources scoring at least this (0..1) on `minAttributeKey`. */
  minAttributeKey: z.string().optional(),
  minAttributeValue: z.coerce.number().min(0).max(1000).optional(),
  sort: z.enum(['name', 'newest', 'despawning', 'best']).default('newest'),
});
export type ResourceQuery = z.infer<typeof resourceQuery>;

// --- Characters -----------------------------------------------------------

export const attributeState = z.object({
  name: z.string(),
  label: z.string(),
  current: z.number().int(),
  max: z.number().int(),
  deficit: z.number().int(),
  isPool: z.boolean(),
});

export const characterSummary = z.object({
  objectId,
  name: z.string(),
  stationId: z.number().int(),
  scene: z.string().nullable(),
  location: worldLocation.nullable(),
  bankBalance: z.number().int(),
  cashBalance: z.number().int(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime().nullable(),
  online: z.boolean(),
});
export type CharacterSummary = z.infer<typeof characterSummary>;

export const characterDetail = characterSummary.extend({
  skillTitle: z.string().nullable(),
  playedTimeSeconds: z.number().int(),
  bornDate: z.number().int().nullable(),
  posture: z.string(),
  faction: z.string(),
  pvpFlags: z.array(z.string()),
  attributes: z.array(attributeState),
  experience: z.array(z.object({ type: z.string(), label: z.string(), points: z.number().int() })),
  skills: z.array(z.string()),
  lotsUsed: z.number().int(),
  lotsTotal: z.number().int(),
  force: z.object({ current: z.number().int(), max: z.number().int() }).nullable(),
});
export type CharacterDetail = z.infer<typeof characterDetail>;

export const inventoryItem = z.object({
  objectId,
  name: z.string(),
  templateId: z.number().int().nullable(),
  gameObjectType: z.number().int().nullable(),
  gameObjectTypeLabel: z.string(),
  count: z.number().int(),
  volume: z.number().int(),
  /** Remaining durability, and the maximum it was made with. */
  durability: z.number().int().nullable(),
  maxDurability: z.number().int().nullable(),
  /** Capacity from the object's shared template; null when it holds nothing. */
  containerCapacity: z.number().int().nullable(),
  childCount: z.number().int(),
  appearanceKey: z.string().nullable(),
});
export type InventoryItem = z.infer<typeof inventoryItem>;

export const containerView = z.object({
  containerId: objectId,
  name: z.string(),
  kind: z.enum(['inventory', 'bank', 'datapad', 'equipped', 'house', 'container', 'vendor']),
  capacity: z.number().int().nullable(),
  used: z.number().int(),
  items: z.array(inventoryItem),
});
export type ContainerView = z.infer<typeof containerView>;

export const structure = z.object({
  objectId,
  name: z.string(),
  templateId: z.number().int().nullable(),
  gameObjectType: z.number().int().nullable(),
  typeLabel: z.string(),
  location: worldLocation,
  ownerId: objectId.nullable(),
  ownerName: z.string().nullable(),
  isPublic: z.boolean(),
  maintenancePool: z.number().int().nullable(),
  powerPool: z.number().int().nullable(),
  lots: z.number().int(),
  /** Populated for harvesters. */
  harvester: z
    .object({
      resourceId: objectId.nullable(),
      resourceName: z.string().nullable(),
      hopperAmount: z.number(),
      hopperCapacity: z.number().int(),
      extractionRate: z.number(),
      active: z.boolean(),
      /** 0..1. The number an operator actually scans a list for. */
      hopperFill: z.number(),
      /**
       * Hours until the hopper is full and extraction stops, or null when it
       * cannot be known — an idle harvester, or one already full.
       */
      hoursUntilFull: z.number().nullable(),
      /** Units per hour at the current rate, for comparing sites. */
      unitsPerHour: z.number(),
      /**
       * True when the resource this harvester is on has despawned. It keeps
       * running on a dead vein, which is the single most common way a player
       * loses days of yield without noticing.
       */
      resourceDepleted: z.boolean(),
      /**
       * True when the hopper holds more than one resource. The schema stores
       * -1 as a sentinel for that rather than a quantity, so the amount is not
       * meaningful and the fill bar would otherwise read negative.
       */
      mixedContents: z.boolean(),
    })
    .nullable(),
  /** Hours of maintenance left at the current rate, or null when unknown. */
  maintenanceHoursLeft: z.number().nullable(),
  /** Hours of power left at the current draw, or null when it needs none. */
  powerHoursLeft: z.number().nullable(),
});
export type Structure = z.infer<typeof structure>;

export const waypoint = z.object({
  waypointId: objectId,
  name: z.string(),
  location: worldLocation,
  color: z.number().int(),
  active: z.boolean(),
});
export type Waypoint = z.infer<typeof waypoint>;

// --- Vendors --------------------------------------------------------------

export const vendor = z.object({
  locationId: objectId,
  name: z.string(),
  label: z.string(),
  ownerId: objectId,
  ownerName: z.string().nullable(),
  scene: z.string().nullable(),
  location: worldLocation.nullable(),
  status: z.number().int(),
  statusLabel: z.string(),
  searchEnabled: z.boolean(),
  salesTax: z.number().int(),
  entranceCharge: z.number().int(),
  itemCount: z.number().int(),
  stockroomCount: z.number().int(),
  totalValue: z.number().int(),
  lastAccessedAt: z.string().datetime().nullable(),
  emptyAt: z.string().datetime().nullable(),
  inactiveAt: z.string().datetime().nullable(),
});
export type Vendor = z.infer<typeof vendor>;

export const vendorUpdate = z.object({
  searchEnabled: z.boolean().optional(),
  salesTax: z.number().int().min(0).max(100).optional(),
  // Bounded, not just non-negative: the console renders this into a command
  // that the server reads with atoi, so anything past a signed 32-bit int
  // wraps — a large positive charge arriving as a negative one, while the API
  // reports and audits the number the player typed.
  entranceCharge: z.number().int().min(0).max(2_000_000_000).optional(),
});
export type VendorUpdate = z.infer<typeof vendorUpdate>;

// --- Assets ---------------------------------------------------------------

export const assetEntry = z.object({
  /** Stable key: the source appearance path without extension. */
  key: z.string(),
  name: z.string(),
  kind: z.enum(['static', 'skinned', 'component']),
  /** Path to the GLB, relative to the asset base. */
  model: z.string(),
  /** Axis-aligned bounds in metres, for framing the camera. */
  bounds: z.object({
    min: z.tuple([z.number(), z.number(), z.number()]),
    max: z.tuple([z.number(), z.number(), z.number()]),
  }),
  triangles: z.number().int(),
  lodCount: z.number().int(),
  /** Object templates that render with this appearance. */
  templates: z.array(z.string()),
  /**
   * Animation clips baked into the GLB, in the order it declares them.
   *
   * Carried here so a viewer can show whether a model animates, and offer the
   * clip list, before downloading it. Defaults to empty because assets
   * converted before animation support have no such field.
   */
  animations: z.array(z.string()).default([]),
  /**
   * Named attachment points in the GLB, emitted as empty nodes.
   *
   * How SWG hangs one object off another: a weapon on a ship's wing, an
   * exhaust behind a booster. A tool can check for the point it needs before
   * downloading the model. Empty for assets converted before hardpoint
   * support, and for the many appearances that genuinely have none.
   */
  hardpoints: z.array(z.string()).default([]),
  sizeBytes: z.number().int(),
});
export type AssetEntry = z.infer<typeof assetEntry>;

// --- Admin ----------------------------------------------------------------

export const adminPlayerQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
  scene: z.string().optional(),
  online: z.coerce.boolean().optional(),
  stationId: z.coerce.number().int().optional(),
  sort: z.enum(['name', 'last_login', 'credits', 'created']).default('last_login'),
});

export const adminMoveRequest = z.object({
  scene: z.string().min(1),
  x: z.number(),
  y: z.number().default(0),
  z: z.number(),
  reason: z.string().trim().min(1).max(500),
});
export type AdminMoveRequest = z.infer<typeof adminMoveRequest>;

export const adminCreditsRequest = z.object({
  /** Positive to grant, negative to remove. */
  amount: z.number().int().refine((n) => n !== 0, 'amount must be non-zero'),
  account: z.enum(['bank', 'cash']).default('bank'),
  reason: z.string().trim().min(1).max(500),
});
export type AdminCreditsRequest = z.infer<typeof adminCreditsRequest>;

export const adminXpRequest = z.object({
  xpType: z.string().min(1).max(100),
  amount: z.number().int(),
  reason: z.string().trim().min(1).max(500),
});
export type AdminXpRequest = z.infer<typeof adminXpRequest>;

export const adminItemRequest = z.object({
  /** Server object template path, e.g. `object/weapon/ranged/pistol/pistol_cdef.iff`. */
  template: z.string().min(1).max(400),
  count: z.number().int().min(1).max(100).default(1),
  reason: z.string().trim().min(1).max(500),
});
export type AdminItemRequest = z.infer<typeof adminItemRequest>;

export const adminItemRemoveRequest = z.object({
  itemId: objectId,
  reason: z.string().trim().min(1).max(500),
});

export const chatQuery = paginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  channel: z.string().optional(),
  speaker: z.string().optional(),
  target: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ChatQuery = z.infer<typeof chatQuery>;

export const chatMessage = z.object({
  id: z.string(),
  at: z.string().datetime(),
  channel: z.string(),
  speaker: z.string(),
  target: z.string().nullable(),
  scene: z.string().nullable(),
  text: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessage>;

export const auditEntry = z.object({
  id: z.string(),
  at: z.string().datetime(),
  actor: z.string(),
  action: z.string(),
  targetId: z.string().nullable(),
  targetName: z.string().nullable(),
  reason: z.string(),
  detail: z.record(z.string(), z.unknown()),
  outcome: z.enum(['ok', 'failed']),
  /** Raw console response, kept verbatim so a failure can be diagnosed. */
  response: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntry>;

// --- Community site -------------------------------------------------------

export const newsPost = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  author: z.string(),
  tags: z.array(z.string()),
  publishedAt: z.string().datetime(),
  pinned: z.boolean(),
});
export type NewsPost = z.infer<typeof newsPost>;

export const changelogEntry = z.object({
  id: z.string(),
  version: z.string(),
  date: z.string(),
  title: z.string(),
  category: z.enum(['feature', 'change', 'fix', 'balance', 'content', 'known-issue']),
  area: z.string(),
  summary: z.string(),
  detail: z.string().nullable(),
  /** Set when the entry is still in testing rather than live. */
  status: z.enum(['live', 'testing', 'planned']).default('live'),
});
export type ChangelogEntry = z.infer<typeof changelogEntry>;

// --- WebSocket ------------------------------------------------------------

export const wsChannel = z.enum([
  'bazaar',
  'resources',
  'status',
  'admin.audit',
  'admin.chat',
]);
export type WsChannel = z.infer<typeof wsChannel>;

export const wsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channels: z.array(wsChannel).min(1) }),
  z.object({ type: z.literal('unsubscribe'), channels: z.array(wsChannel).min(1) }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessage>;

export const wsServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('subscribed'), channels: z.array(wsChannel) }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({
    type: z.literal('event'),
    channel: wsChannel,
    at: z.string().datetime(),
    payload: z.unknown(),
  }),
]);
export type WsServerMessage = z.infer<typeof wsServerMessage>;

/** Payload shape for `channel: 'bazaar'` events. */
export const bazaarEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('listed'), listing: bazaarListing }),
  z.object({ kind: z.literal('updated'), listing: bazaarListing }),
  z.object({ kind: z.literal('removed'), itemId: objectId }),
]);
export type BazaarEvent = z.infer<typeof bazaarEvent>;

/** Payload shape for `channel: 'resources'` events. */
export const resourceEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spawned'), resource: spawnedResource }),
  z.object({ kind: z.literal('despawned'), resourceId: objectId, name: z.string() }),
]);
export type ResourceEvent = z.infer<typeof resourceEvent>;

// --- Saved designs --------------------------------------------------------

export const savedDesignKind = z.enum(['city_plan', 'ship_loadout']);
export type SavedDesignKind = z.infer<typeof savedDesignKind>;

/**
 * The envelope every planning tool saves through.
 *
 * `payload` is deliberately loose here and validated per tool by the schemas
 * below. The tools evolve faster than the wire contract, and a design saved by
 * last week's planner must still load in this week's — so unknown keys survive
 * a round trip instead of being stripped.
 */
export const savedDesign = z.object({
  id: z.string().uuid(),
  kind: savedDesignKind,
  name: z.string(),
  description: z.string(),
  payload: z.unknown(),
  isPublic: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Present on public listings so a viewer can see whose design it is. */
  ownerName: z.string().nullable().default(null),
});
export type SavedDesign = z.infer<typeof savedDesign>;

export const savedDesignWrite = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  isPublic: z.boolean().default(false),
  /**
   * The tool's document.
   *
   * Capped rather than unbounded: this lands in jsonb on a shared database, and
   * a planner with a runaway loop should fail loudly at the boundary rather
   * than quietly storing megabytes per row.
   *
   * Measured in BYTES, not string length. `String.length` counts UTF-16 code
   * units, so a payload of non-Latin text passes a 512,000-unit check at up to
   * three times that many bytes.
   *
   * Required, not optional: `z.unknown()` accepts `undefined`, which reached a
   * NOT NULL jsonb column as SQL null and failed at the database instead of at
   * the boundary.
   */
  payload: z
    .unknown()
    .refine((value) => value !== undefined, 'payload is required')
    .refine(
      (value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') <= 512_000,
      'design is too large; expected under 512 KB',
    ),
});
export type SavedDesignWrite = z.infer<typeof savedDesignWrite>;

// --- City planner ---------------------------------------------------------

/** One structure placed on a plan, in world metres relative to the city hall. */
export const cityPlacement = z.object({
  /** Stable per-placement id so the UI can select and move one. */
  id: z.string(),
  /** Server object template, e.g. `object/building/player/city/...`. */
  template: z.string(),
  /** Manifest asset key, so the renderer need not resolve it again. */
  modelKey: z.string().nullable().default(null),
  x: z.number(),
  z: z.number(),
  /** Yaw in radians. Structures sit on the ground, so one axis is enough. */
  rotation: z.number().default(0),
  label: z.string().default(''),
});
export type CityPlacement = z.infer<typeof cityPlacement>;

export const cityPlan = z.object({
  version: z.literal(1).default(1),
  scene: z.string().default('tatooine'),
  /** City rank drives the buildable radius, exactly as in game. */
  rank: z.number().int().min(1).max(5).default(1),
  /** Where the city hall sits in world space; the plan is drawn around it. */
  centre: z.object({ x: z.number(), z: z.number() }).default({ x: 0, z: 0 }),
  placements: z.array(cityPlacement).default([]),
});
export type CityPlan = z.infer<typeof cityPlan>;

// --- Ship loadout ---------------------------------------------------------

/**
 * Slot names are data, not a fixed list.
 *
 * A chassis declares its own slots in ship_chassis.tab, and they differ per
 * hull — some have a modification slot, weapon counts run 0..8, and capital
 * ships use indices a fighter never sees. Pinning an enum here would reject
 * loadouts for hulls the game already ships.
 */
export const shipSlot = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'expected a slot name');
export type ShipSlot = z.infer<typeof shipSlot>;

export const shipLoadout = z.object({
  version: z.literal(1).default(1),
  /** Chassis key, e.g. `xwing`. Drives which part appearances are valid. */
  chassis: z.string(),
  /**
   * Installed component per slot. The value is the component template, or null
   * for an empty slot — an absent key and an explicitly empty slot are the
   * same thing to the renderer, but round-tripping the null keeps a loadout
   * diffable against the one it was copied from.
   */
  components: z.record(shipSlot, z.string().nullable()).default({}),
});
export type ShipLoadout = z.infer<typeof shipLoadout>;

