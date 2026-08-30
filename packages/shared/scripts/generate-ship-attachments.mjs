#!/usr/bin/env node
/**
 * Regenerates packages/shared/data/ship-attachments.json from the game's own
 * per-chassis attachment tables.
 *
 * This is the data that decides what a ship LOOKS like once components are
 * installed. ShipComponentAttachmentManager::load() opens one datatable per
 * chassis, `datatables/space/ship_chassis_<chassis>.iff`, keyed by component
 * name down the rows and by slot name across the columns. Each cell is a
 * comma-separated list of `token:hardpoint` pairs, where the token names an
 * attachment template and the hardpoint names where the game hangs it. A token
 * with no colon is a targeting hardpoint with no model at all.
 *
 * Before this existed the loadout viewer guessed at hardpoint names, and the
 * guess was wrong often enough that it rendered no attached parts at all.
 *
 *   node scripts/generate-ship-attachments.mjs [--server-repo <path>] [--templates <templates.json>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const dataDir = join(pkgRoot, 'data');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const serverRepo = resolve(
  arg('server-repo', join(repoRoot, '..', 'Source', 'pre-cu-reborn-server-x64')),
);
const templatesPath = resolve(
  arg('templates', join(repoRoot, 'apps', 'web', 'public', 'assets', 'templates.json')),
);
const spaceTables = join(
  serverRepo,
  'dsrc',
  'sku.0',
  'sys.shared',
  'compiled',
  'game',
  'datatables',
  'space',
);

/**
 * The .tab export quotes a cell that contains a comma, and doubles any quote
 * inside it — the same convention DataTableWriter's unquotify undoes.
 */
function unquote(cell) {
  const text = String(cell ?? '').trim();
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  return text.slice(1, -1).replace(/""/g, '"');
}

function readTab(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const headers = lines[0].split('\t').map((h) => h.trim());
  // Row 0 is the header and row 1 the column types; data starts at row 2.
  const rows = [];
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    rows.push(row);
  }
  return { headers, rows };
}

// --- attachment token -> converted model -------------------------------------

/**
 * Every `object/tangible/ship/attachment/<type>/<token>.iff` in the template
 * index, keyed by token.
 *
 * The engine synthesises that path from the SLOT's component type, but the
 * token is unique across types in practice, so indexing by token avoids having
 * to reproduce the slot-to-type table. Collisions are counted and reported
 * rather than silently resolved.
 */
function readAttachmentModels(path) {
  const models = new Map();
  const collisions = [];
  if (!existsSync(path)) return { models, collisions };

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const entries = raw.entries ?? raw;
  for (const [template, entry] of Object.entries(entries)) {
    const match = /^object\/tangible\/ship\/attachment\/[^/]+\/([^/]+)\.iff$/.exec(template);
    if (!match) continue;
    const token = match[1];
    const model = entry?.model ?? null;
    if (models.has(token) && models.get(token) !== model) collisions.push(token);
    models.set(token, model);
  }
  return { models, collisions };
}

const { models: attachmentModels, collisions } = readAttachmentModels(templatesPath);

/**
 * Attachment models that are part of the hull rather than of any component.
 *
 * A ship's wings are not in the chassis table at all -- nothing names them --
 * yet the table constantly references hardpoints that live on them. An X-wing's
 * engine_pos1, booster_pos1, weapon1_pos1 and weapon2_pos1 are all on
 * xwing_wing_pos, never on xwing_body. The client assembles them; there is no
 * server-side table that says so.
 *
 * They are recovered here as a constraint rather than guessed: a structural
 * model is taken for a chassis only when it belongs to that chassis's family
 * AND supplies at least one hardpoint the chassis's own table references but
 * its hull does not have. Coverage is reported, so a family that fails to
 * account for its missing hardpoints is visible rather than silent.
 */
function readStructuralCandidates(path) {
  const candidates = [];
  if (!existsSync(path)) return candidates;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const entries = raw.entries ?? raw;
  for (const [template, entry] of Object.entries(entries)) {
    const match = /^object\/tangible\/ship\/attachment\/(wing|base)\/([^/]+)\.iff$/.exec(template);
    if (!match || !entry?.model) continue;
    // The TOKEN follows the chassis family; the converted model name often does
    // not. blacksun_light_wing_s01.iff carries the model
    // black_sun_fighter_light_struct_s01, which shares no prefix with the
    // chassis at all — matching on the model name silently excluded every
    // family except the X-wing and B-wing, whose names happen to coincide.
    candidates.push({ token: match[2], model: entry.model });
  }
  return candidates;
}

function readManifestHardpoints(path) {
  const points = new Map();
  if (!existsSync(path)) return points;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  for (const entry of Object.values(raw.entries ?? {})) {
    if (entry?.key) points.set(entry.key, new Set((entry.hardpoints ?? []).map((h) => h.toLowerCase())));
  }
  return points;
}

/** Model key -> its bounding box, for telling complements from alternatives. */
function readManifestBounds(path) {
  const bounds = new Map();
  if (!existsSync(path)) return bounds;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  for (const entry of Object.values(raw.entries ?? {})) {
    if (entry?.key && entry.bounds?.min && entry.bounds?.max) {
      bounds.set(entry.key, entry.bounds);
    }
  }
  return bounds;
}

/**
 * How much of the smaller box sits inside the larger.
 *
 * This is what separates two wings from two versions of one wing when the
 * names do not. A V-wing's top and bottom occupy different air and barely
 * touch; a Jedi starfighter's `wing1` and `wing3` sit in the same place a
 * handful of centimetres apart, because they are alternatives. Names cannot
 * tell those apart -- both pairs are just numbered -- but the geometry can.
 */
function boxOverlap(a, b) {
  if (!a || !b) return 0;
  let intersection = 1;
  let smallest = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const low = Math.max(a.min[axis], b.min[axis]);
    const high = Math.min(a.max[axis], b.max[axis]);
    intersection *= Math.max(0, high - low);
    smallest = Math.min(
      smallest,
      (a.max[axis] - a.min[axis]) * (b.max[axis] - b.min[axis]),
    );
  }
  const volume = (box) =>
    (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
  const smaller = Math.min(volume(a), volume(b));
  return smaller > 0 ? intersection / smaller : 0;
}

const manifestPath = join(dirname(templatesPath), 'manifest.json');
const structuralPool = readStructuralCandidates(templatesPath);
const hardpointsByModel = readManifestHardpoints(manifestPath);
const boundsByModel = readManifestBounds(manifestPath);

/** chassis name -> hull model key, from the generated chassis data. */
function readHulls() {
  const path = join(dataDir, 'ship-chassis.json');
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.chassis ?? []);
  return new Map(list.map((c) => [c.name, c.model ?? null]));
}
const hulls = readHulls();

// --- per-chassis tables ------------------------------------------------------

const chassisFiles = existsSync(spaceTables)
  ? readdirSync(spaceTables).filter(
      (f) => f.startsWith('ship_chassis_player_') && f.endsWith('.tab'),
    )
  : [];

/** Slot columns are everything except the component key itself. */
const NOT_A_SLOT = new Set(['component', 'hit_range']);

const chassis = {};
let pairCount = 0;
let modelled = 0;
let targetingOnly = 0;
let unresolved = 0;
const missingTokens = new Set();
const structuralStats = [];
const uncovered = new Map();

for (const file of chassisFiles) {
  const name = basename(file, '.tab').replace(/^ship_chassis_/, '');
  const { headers, rows } = readTab(join(spaceTables, file));
  const slots = headers.filter((h) => h && !NOT_A_SLOT.has(h));

  /** component name -> slot -> attachments */
  const components = {};
  /** Every hardpoint this chassis's table names, for the structural solve. */
  const referenced = new Set();
  for (const row of rows) {
    const component = String(row.component ?? '').trim();
    if (!component) continue;

    for (const slot of slots) {
      const cell = unquote(row[slot]);
      if (!cell) continue;

      const attachments = [];
      const extraHardpoints = [];
      for (const rawToken of cell.split(',')) {
        const token = rawToken.trim();
        if (!token) continue;
        pairCount += 1;

        const colon = token.indexOf(':');
        if (colon === -1) {
          // No model — the game keeps these purely so a shot can be scored
          // against the slot.
          extraHardpoints.push(token);
          targetingOnly += 1;
          continue;
        }

        const templateToken = token.slice(0, colon);
        const hardpoint = token.slice(colon + 1);
        const model = attachmentModels.get(templateToken);
        if (!model) {
          // Either the template has no appearance (TIE engine glow is a client
          // effect, not a mesh) or it never converted. Both mean nothing to
          // draw, and the viewer says so rather than drawing the wrong thing.
          if (!attachmentModels.has(templateToken)) missingTokens.add(templateToken);
          unresolved += 1;
          continue;
        }
        attachments.push({ model, hardpoint });
        referenced.add(hardpoint.toLowerCase());
        modelled += 1;
      }

      if (attachments.length === 0 && extraHardpoints.length === 0) continue;
      components[component] ??= {};
      // First row wins, as the engine's std::map::insert does — it does not
      // overwrite an existing key. 81 component names repeat across the 69
      // tables and 17 of those carry different cells, so assigning would draw
      // the wrong barrel for `wpn_prototype` on the A-wing, the B-wing and the
      // Black Sun hulls. Applied per slot, not per row: a slot the first row
      // left empty is still filled by a later one.
      if (components[component][slot]) continue;
      components[component][slot] = {
        ...(attachments.length ? { attachments } : {}),
        ...(extraHardpoints.length ? { extraHardpoints } : {}),
      };
    }
  }

  if (Object.keys(components).length === 0) continue;

  // Which referenced hardpoints the hull cannot supply, and which family
  // models can. A candidate earns its place by covering at least one.
  const hull = hulls.get(name);
  const hullPoints = hull ? (hardpointsByModel.get(hull) ?? new Set()) : new Set();
  const missing = [...referenced].filter((h) => !hullPoints.has(h));

  // The family, not the exact chassis: a chassis carries a style suffix its
  // structural models do not. player_blacksun_heavy_s01's wings are
  // blacksun_heavy_wing_s01 and _s02, so the trailing style is dropped before
  // matching. Coverage is still required on top of the name, so a wrong family
  // contributes nothing rather than attaching another ship's wing.
  // The family is taken from the HULL, not the chassis name. player_xwing and
  // player_advanced_xwing share the hull xwing_body and therefore share wings,
  // but a name-derived family gives 'xwing' and 'advanced_xwing' and only the
  // first matches anything. Stripping the hull's own suffix
  // (black_sun_fighter_light_body_s01 -> black_sun_fighter_light) gives the
  // stem its structural models are actually named after.
  // A hull and its wings agree on what SHIP they are, and disagree on every
  // other word. hutt_fighter_heavy_body_s03's wings are hutt_heavy_wing_s01:
  // the hull says "fighter" and the wing does not, and neither name is a prefix
  // of the other. black_sun_fighter_light_body_s01 pairs with
  // blacksun_light_wing_s01, which does not even agree on where the underscores
  // go. So both names are reduced to their identifying words -- the generic
  // ones dropped, the rest run together -- and a candidate qualifies when its
  // reduction starts with the hull's.
  const GENERIC = new Set([
    'fighter', 'body', 'hull', 'wing', 'struct', 'ship', 'player', 'base',
  ]);
  const identity = (name) =>
    name
      .split('_')
      .filter((word) => word && !GENERIC.has(word) && !/^s?\d+$/.test(word))
      .join('');

  const stem = name.replace(/^player_/, '');
  const hullIdentity = hull ? identity(hull) : '';
  const families = [hullIdentity, identity(stem)].filter(Boolean);

  // Where the structure bolts on. Every hull that has separate wings names the
  // point: `wing1` on the X-wing and the Black Sun hulls, `struct1` on the
  // Hutts. Drawing at the origin instead put the Hutt turret's wings halfway up
  // its nose.
  //
  // Resolved against everything mounted so far, not just the hull, because an
  // assembly can be more than one deep. A B-wing's chassis model is only its
  // cockpit pod: `bwing_body` hangs off the pod's `body1`, and the wings hang
  // off the BODY's `wing_l1` and `wing_r1`. Looking only at the hull found
  // neither, so the whole ship collapsed to the origin.
  const mounted = new Map([[hull, hullPoints]]);
  const MOUNT_NAMES = ['wing_l1', 'wing_r1', 'wing1', 'struct1', 'attach1', 'body1'];

  /**
   * Where one model bolts on.
   *
   * A mount is preferred when the model's own name contains its stem, because
   * that is what tells `bwing_wing_l` apart from `bwing_wing_r` — both fit
   * `body1`, and taking whichever matched first put the two wings in the same
   * place. Falls back to any free mount for models whose names say nothing.
   */
  const findMount = (model) => {
    const affine = MOUNT_NAMES.filter((h) => model.includes(h.replace(/\d+$/, '')));
    for (const names of [affine, MOUNT_NAMES]) {
      for (const [owner, points] of mounted) {
        const hit = names.find((h) => points.has(h));
        if (hit) return { mount: hit, on: owner };
      }
    }
    return null;
  };

  // A wing belongs to a hull because the hull has somewhere to put it -- NOT
  // because it happens to supply a hardpoint the component table asked for.
  // Gating on that coverage left the Hutt light and the Black Sun heavy with no
  // wings at all, since everything their tables reference is already on the
  // fuselage.
  const style = /_s(\d+)$/.exec(stem)?.[1];
  const matching = structuralPool
    .filter((c) => families.some((f) => identity(c.token).startsWith(f)))
    .sort((a, b) => {
      const aStyle = style && a.token.endsWith(`_s${style}`) ? 0 : 1;
      const bStyle = style && b.token.endsWith(`_s${style}`) ? 0 : 1;
      return aStyle - bStyle || a.token.localeCompare(b.token);
    });

  const structural = [];
  const covered = new Set();
  const taken = new Set();

  // First pass: anything that supplies a hardpoint nothing else has yet. This
  // separates complements from alternatives -- an X-wing's two wings supply
  // disjoint sets and both earn a place, while two STYLES of one wing supply
  // the same set and only the first is taken.
  for (const candidate of matching) {
    const points = hardpointsByModel.get(candidate.model) ?? new Set();
    const adds = missing.filter((h) => points.has(h) && !covered.has(h));
    if (adds.length === 0) continue;
    const where = findMount(candidate.model);
    structural.push({ model: candidate.model, mount: where?.mount ?? null, on: where?.on ?? hull });
    mounted.set(candidate.model, hardpointsByModel.get(candidate.model) ?? new Set());
    taken.add(candidate.model);
    adds.forEach((h) => covered.add(h));
  }

  /**
   * Second pass: wings that carry no hardpoints at all.
   *
   * The first pass can only see a wing that supplies something, so a wing that
   * is purely geometry never earns a place. The V-wing is the case: both
   * `vwing_wing_top` and `vwing_wing_bottom` are real attachments of that hull
   * and neither carries anything but contrails, so taking only the first left
   * the ship with a bottom half and no top -- which is most of what makes a
   * V-wing a V.
   *
   * The distinction that matters here is COMPLEMENTS against VARIANTS. A `_sNN`
   * suffix marks a variant: four styles of one Black Sun wing, of which a
   * chassis wears exactly one. A descriptive difference -- top and bottom, pos
   * and neg, left and right -- marks complements, which are all worn at once.
   * So: pick by style when the chassis names one, take every unstyled candidate
   * when it does not, and fall back to the first only when neither applies.
   */
  if (structural.length === 0 && matching.length > 0) {
    const hasStyle = (token) => /_s\d+$/.test(token);
    const unstyled = matching.filter((c) => !hasStyle(c.token));
    let chosen;
    if (style) chosen = matching.filter((c) => c.token.endsWith(`_s${style}`));
    else if (unstyled.length > 0) chosen = unstyled;
    if (!chosen || chosen.length === 0) chosen = matching.slice(0, 1);

    // Complements occupy different air; alternatives sit on top of each other.
    // Half the smaller box is a wide margin -- a V-wing's pair overlap by
    // almost nothing, a Delta-7's wing1 and wing3 by most of themselves.
    const placedBoxes = [];
    for (const candidate of chosen) {
      const box = boundsByModel.get(candidate.model);
      if (placedBoxes.some((other) => boxOverlap(box, other) > 0.5)) continue;
      const where = findMount(candidate.model);
      if (!where) continue;
      placedBoxes.push(box);
      structural.push({ model: candidate.model, mount: where.mount, on: where.on });
      mounted.set(candidate.model, hardpointsByModel.get(candidate.model) ?? new Set());
      taken.add(candidate.model);
    }
  }
  const stillMissing = missing.filter((h) => !covered.has(h));
  structuralStats.push({ name, missing: missing.length, covered: covered.size });
  if (stillMissing.length) uncovered.set(name, stillMissing);

  chassis[name] = { components, structural };
}

// --- emit --------------------------------------------------------------------

mkdirSync(dataDir, { recursive: true });

/**
 * One file per chassis, fetched when that hull is selected.
 *
 * The whole table is several megabytes and a loadout only ever needs the one
 * chassis in front of the player, so only the index of which chassis have a
 * table ships in the bundle.
 */
const publicDir = join(repoRoot, 'apps', 'web', 'public', 'assets', 'ship-attachments');
mkdirSync(publicDir, { recursive: true });

const index = [];
let largest = 0;
for (const [name, entry] of Object.entries(chassis)) {
  const body = `${JSON.stringify({ chassis: name, ...entry })}\n`;
  writeFileSync(join(publicDir, `${name}.json`), body, 'utf8');
  largest = Math.max(largest, Buffer.byteLength(body));
  index.push(name);
}
index.sort();
writeFileSync(
  join(dataDir, 'ship-attachments-index.json'),
  `${JSON.stringify(index, null, 2)}\n`,
  'utf8',
);

const chassisCount = index.length;
console.log(
  `  ship-attachments/*.json  ${chassisCount} chassis, largest ${(largest / 1024).toFixed(0)} KB`,
);
console.log('  ship-attachments-index.json');
console.log(
  `\n${pairCount} attachment references from ${chassisFiles.length} tables: ` +
    `${modelled} with a model, ${targetingOnly} targeting-only, ${unresolved} with nothing to draw`,
);
if (missingTokens.size) {
  console.log(`  ${missingTokens.size} tokens have no template at all, e.g. ` +
    `${[...missingTokens].slice(0, 3).join(', ')}`);
}
const withStructural = structuralStats.filter((x) => x.covered > 0).length;
const totalMissing = structuralStats.reduce((n, x) => n + x.missing, 0);
const totalCovered = structuralStats.reduce((n, x) => n + x.covered, 0);
console.log(
  `  structural: ${withStructural} chassis need hull attachments; ` +
    `${totalCovered}/${totalMissing} off-hull hardpoints accounted for`,
);
if (uncovered.size) {
  const worst = [...uncovered.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  console.log(
    `  ${uncovered.size} chassis still have unaccounted hardpoints, e.g. ` +
      worst.map(([n, h]) => `${n} (${h.length})`).join(', '),
  );
}
if (collisions.length) {
  console.log(`  WARNING: ${collisions.length} tokens appear under more than one attachment type`);
}
