#!/usr/bin/env node
/**
 * Regenerates packages/shared/data/ship-*.json from the server's own tables.
 *
 *   space/ship_chassis.tab     which slots a chassis has, and what each accepts
 *   ship/shiptype.tab          per-chassis hit points and mass budget
 *   space/ship_components.tab  every component: template, type, compatibility
 *   ship/components/*.tab      per-type stats, keyed by object template
 *
 * The two constraints the engine actually enforces are slot compatibility and
 * total mass (`ShipObject::canInstallComponent`), so those are the two a
 * loadout tool has to model. Everything else is presentation.
 *
 *   node scripts/generate-ship-data.mjs [--server-repo <path>] [--templates <templates.json>]
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

const sharedTables = join(serverRepo, 'dsrc', 'sku.0', 'sys.shared', 'compiled', 'game', 'datatables');
const serverTables = join(serverRepo, 'dsrc', 'sku.0', 'sys.server', 'compiled', 'game', 'datatables');

function readTab(path) {
  if (!existsSync(path)) return { headers: [], rows: [] };
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = lines[0].split('\t').map((h) => h.trim());
  const rows = lines.slice(2).map((line) => {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
  return { headers, rows };
}

/**
 * Unquote and split a compatibility cell into its tokens.
 *
 * A slot cell is a SET, comma separated and quoted in the export:
 * "wpn_0,cms_0". ShipChassisSlot::unpackCompatibilities tokenises on
 * ", 

	" and binary-searches the result, so treating the cell as one
 * opaque string leaves every multi-token slot accepting nothing.
 */
function splitTokens(cell) {
  return String(cell ?? '')
    .replace(/^"|"$/g, '')
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

const num = (value, fallback = 0) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

// --- slots ------------------------------------------------------------------

/**
 * The slot columns of ship_chassis.tab, in the engine's own order.
 *
 * Each slot appears as three columns — the compatibility token, a hit weight
 * and a targetable flag — so the slot names are the columns that are followed
 * by `_hitweight`. Reading them positionally rather than hardcoding a list
 * keeps this correct if a chassis table gains a slot.
 */
function slotNames(headers) {
  const names = [];
  for (let i = 0; i < headers.length; i += 1) {
    const next = headers[i + 1];
    if (next && next === `${headers[i]}_hitweight`) names.push(headers[i]);
  }
  return names;
}

// --- chassis ----------------------------------------------------------------

const chassisTable = readTab(join(sharedTables, 'space', 'ship_chassis.tab'));
const slots = slotNames(chassisTable.headers);

const shipTypes = new Map(
  readTab(join(serverTables, 'ship', 'shiptype.tab')).rows.map((row) => [row.name, row]),
);

let templateModels = new Map();
if (existsSync(templatesPath)) {
  const raw = JSON.parse(readFileSync(templatesPath, 'utf8'));
  const entries = raw.entries ?? raw;
  templateModels = new Map(
    Object.entries(entries).map(([path, entry]) => [path, entry?.model ?? null]),
  );
}

/**
 * A chassis's object template is not in any table — it follows from the name.
 * Tried in order, because Reborn's own additions do not all sit in the same
 * directory as the stock ships.
 */
function chassisTemplate(name) {
  const stem = name.replace(/^player_/, '');
  // The third form used to be `player_${stem}`, which for a name already
  // starting with `player_` is byte-identical to the first -- a fallback that
  // could never fire. The bare stem is the one that actually differs.
  return [
    `object/ship/player/${name}.iff`,
    `object/ship/${name}.iff`,
    `object/ship/${stem}.iff`,
  ].find((path) => templateModels.has(path)) ?? null;
}

/**
 * The mass budget a CRAFTED chassis actually gets.
 *
 * shiptype.tab's massMax is not it. That column is the budget a statically
 * spawned ship is given, and for player hulls it is a flat placeholder — 10000
 * for the X-wing, the B-wing, the Decimator and the rebel gunship alike.
 * ShipObject::canInstallComponent compares against
 * getChassisComponentMassMaximum(), which space_crafting.createChassisFromDeed
 * overwrites from the deed's ship_chassis.mass objvar, and that comes from the
 * shipwright's draft schematic. The real figures are an order of magnitude
 * higher: the X-wing schematic declares 97500..102500, the B-wing
 * 234000..246000.
 *
 * The low end of the range is used, because that is what an unexperimented
 * chassis is worth and it is the bound that cannot overstate what fits.
 */
function readCraftedMassBudgets(dir) {
  const budgets = new Map();
  if (!existsSync(dir)) return budgets;
  for (const file of readdirSync(dir)) {
    if (!file.startsWith('shared_') || !file.endsWith('.tpf')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const match = /"massMax"[^\]]*?value\s*=\s*(\d+)\s*\.\.\s*(\d+)/.exec(text);
    if (!match) continue;
    const stem = basename(file, '.tpf').replace(/^shared_/, '');
    budgets.set(stem, Number(match[1]));
  }
  return budgets;
}

const craftedMass = readCraftedMassBudgets(
  join(serverRepo, 'dsrc', 'sku.0', 'sys.shared', 'compiled', 'game', 'object', 'draft_schematic', 'space', 'chassis'),
);

const chassis = [];
for (const row of chassisTable.rows) {
  const name = row.name;
  if (!name || !name.startsWith('player_')) continue;

  const type = shipTypes.get(name);
  const template = chassisTemplate(name);

  // A slot exists on this chassis only when it names a compatibility token;
  // blank means the chassis has no such slot at all, which is different from
  // having one that is empty.
  // A slot's cell is a SET of accepted tokens, comma separated and quoted in
  // the export: "wpn_0,cms_0". ShipChassisSlot::unpackCompatibilities tokenises
  // it and binary-searches the result, so comparing the raw cell as one opaque
  // string leaves every multi-token slot matching nothing.
  const chassisSlots = slots
    .map((slot) => ({ slot, compatibility: splitTokens(row[slot]) }))
    .filter((entry) => entry.compatibility.length > 0);

  // A chassis with no shiptype row has no mass budget, and the whole tool is a
  // mass budgeting exercise. Emitting it with massMax 0 would show every
  // loadout as instantly over budget.
  if (!type) continue;

  chassis.push({
    name,
    label: name.replace(/^player_/, '').replace(/_/g, ' '),
    template,
    model: template ? (templateModels.get(template) ?? null) : null,
    /**
     * Total mass a loadout may occupy, from the chassis's craft schematic —
     * NOT from shiptype.tab, whose player-hull figures are placeholders.
     */
    massMax: craftedMass.get(name.replace(/^player_/, '')) ?? (type ? num(type.massMax, 0) : 0),
    /** True when the budget is the shiptype placeholder rather than a schematic. */
    massMaxIsFallback: !craftedMass.has(name.replace(/^player_/, '')),
    hitPoints: type ? num(type.HitPoints, 0) : 0,
    /**
     * What opening the wings does to top speed.
     *
     * ShipObject::calculateSpeed multiplies by this while C_wingsOpened is set,
     * so a value below 1 both marks a hull as having wings that open AND says
     * what opening them costs. Only five player hulls carry one, all at 0.95 —
     * a 5% penalty for flying with the S-foils out.
     */
    wingOpenSpeedFactor: num(row.wing_open_speed_factor, 1),
    slots: chassisSlots,
  });
}

// --- components -------------------------------------------------------------

/**
 * Per-type stat tables are keyed by object template in a column called
 * `strType`, which is the same value ship_components.tab calls
 * `object_template` — the only join between the two.
 */
function readComponentStats(dir) {
  const stats = new Map();
  if (!existsSync(dir)) return stats;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.tab')) continue;
    const kind = basename(file, '.tab');
    for (const row of readTab(join(dir, file)).rows) {
      const template = row.strType;
      if (!template || !template.startsWith('object/')) continue;
      const picked = {};
      for (const [key, value] of Object.entries(row)) {
        if (!key.startsWith('flt') || value === '') continue;
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) picked[key.slice(3)] = parsed;
      }
      stats.set(template, { kind, ...picked });
    }
  }
  return stats;
}

/**
 * The category prefixes ship_components.tab actually uses.
 *
 * Named rather than matched as "any three letters and an underscore", because
 * plenty of component names simply begin with a three-letter word. Stripping
 * blindly turned `hvy_durasteel_armor` and `lgt_durasteel_armor` into the same
 * label, so the heavy and light armour were indistinguishable in the picker.
 *
 * The set is every prefix whose rows carry a matching component_type and
 * compatibility token. `mod` qualifies on that test exactly as the other nine
 * do; `hvy`, `lgt` and `adv` do not, and are the start of a real name.
 */
const CATEGORY_PREFIXES = new Set([
  'arm',
  'bst',
  'cap',
  'crg',
  'ddi',
  'eng',
  'mod',
  'rct',
  'shd',
  'wpn',
]);

function componentLabel(name) {
  // A few dozen rows carry a full template filename in the name column; the
  // extension is not part of what a player should read.
  const stem = name.replace(/\.iff$/i, '');
  const prefix = /^([a-z]{3})_/.exec(stem);
  const body = prefix && CATEGORY_PREFIXES.has(prefix[1]) ? stem.slice(4) : stem;
  return body.replace(/_/g, ' ');
}

const componentStats = readComponentStats(join(serverTables, 'ship', 'components'));

const components = [];
for (const row of readTab(join(sharedTables, 'space', 'ship_components.tab')).rows) {
  if (!row.name || !row.object_template) continue;
  const stats = componentStats.get(row.object_template) ?? null;
  components.push({
    name: row.name,
    label: componentLabel(row.name),
    template: row.object_template,
    type: row.component_type,
    /** The token a chassis slot must name for this to be installable. */
    compatibility: row.compatibility,
    mass: stats?.Mass ?? null,
    energyMaintenance: stats?.EnergyMaintenance ?? null,
    stats: stats ?? null,
    model: templateModels.get(row.object_template) ?? null,
  });
}

// --- emit -------------------------------------------------------------------

mkdirSync(dataDir, { recursive: true });
const written = [];
function emit(name, value) {
  writeFileSync(join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  written.push([name, Array.isArray(value) ? value.length : Object.keys(value).length]);
}

emit('ship-chassis.json', { slots, chassis });
emit('ship-components.json', components);

for (const [name, count] of written) console.log(`  ${name.padEnd(24)} ${count}`);

const withModel = chassis.filter((c) => c.model).length;
const withMass = components.filter((c) => c.mass !== null).length;
console.log(
  `\n${chassis.length} player chassis (${withModel} with models), ` +
    `${components.length} components (${withMass} with mass)`,
);
console.log(`slot types: ${slots.length}`);
