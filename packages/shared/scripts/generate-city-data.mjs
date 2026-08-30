#!/usr/bin/env node
/**
 * Regenerates packages/shared/data/city-*.json from the server's own tables.
 *
 * The city planner is only useful if it enforces the rules the game enforces,
 * so every number here is read from the authoritative source rather than
 * transcribed from a wiki:
 *
 *   city_rank.tab           rank -> radius, citizens required
 *   city_limits.tab         per-planet city caps
 *   player_structure.tab    which structures are civic, the rank that unlocks
 *                           them, their city cost and their lot rules
 *   *.sfp                   the actual footprint grid of each structure
 *
 * Run after changing any of those:
 *
 *   node scripts/generate-city-data.mjs [--server-repo <path>] [--templates <templates.json>]
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

if (!existsSync(serverRepo)) {
  console.error(`server repo not found at ${serverRepo}`);
  process.exit(1);
}

const gameDir = join(serverRepo, 'dsrc', 'sku.0', 'sys.server', 'compiled', 'game');
const sharedDir = join(serverRepo, 'dsrc', 'sku.0', 'sys.shared', 'compiled', 'game');
// Every footprint, not just building/player. Installations and city
// decorations live in sibling directories, and scanning only one left 55
// structures reporting lots: null when their .sfp was right there.
const footprintRoot = join(serverRepo, 'serverdata', 'footprint');

/**
 * A .tab is a TSV whose first row is column names and whose second row is
 * column types — the type row is data to the exporter but noise here.
 */
function readTab(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(2).map((line) => {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

const int = (value, fallback = 0) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

// --- footprints -------------------------------------------------------------

/**
 * One footprint cell is eight metres.
 *
 * Not one — the footprint's x/z are indices into the world's lot grid, and
 * `World.cpp` constructs that grid as `LotManager(16384.f, 8.f)` where the
 * second argument is the chunk width in metres. Treating a cell as a metre
 * would draw every structure at an eighth of its real size, which is exactly
 * the kind of error a planner exists to prevent.
 */
export const METRES_PER_CELL = 8;

/**
 * Parse a compiled footprint: FORM FOOT / FORM 0000 / INFO + PRNT.
 *
 * INFO is six values — width, height, pivot x, pivot z, and two height
 * tolerances. PRNT is `height` rows of `width` characters, each NUL
 * terminated: 'F' is a cell the structure occupies, 'H' a hard-reserved buffer
 * around it, '.' free space.
 */
function readFootprint(path) {
  const buf = readFileSync(path);

  const findChunk = (tag) => {
    // The file is small and the layout fixed, so scanning for the tag is
    // simpler and no less correct than walking the IFF tree for two chunks.
    const at = buf.indexOf(Buffer.from(tag, 'latin1'));
    if (at < 0) return null;
    const length = buf.readUInt32BE(at + 4);
    return buf.subarray(at + 8, at + 8 + length);
  };

  const info = findChunk('INFO');
  const print = findChunk('PRNT');
  // Optional. When absent the box test covers the whole grid, which is true of
  // 92 of the 93 shipped footprints -- but the one exception reserves 8x8 lots
  // while only measuring the ground under the middle 2x2.
  const boxChunk = findChunk('DATA');
  if (!info || !print || info.length < 24) return null;

  const width = info.readInt32LE(0);
  const height = info.readInt32LE(4);
  const pivotX = info.readInt32LE(8);
  const pivotZ = info.readInt32LE(12);
  // The two tolerances the placement test actually uses. LotManager::canPlace
  // grows a box by the terrain under the footprint and refuses the site when
  // that box is taller than structureReservationTolerance, so without this
  // number a planner cannot tell a buildable slope from an unbuildable one.
  const hardTolerance = info.readFloatLE(16);
  const structureTolerance = info.readFloatLE(20);
  if (width <= 0 || height <= 0 || width > 64 || height > 64) return null;
  if (!(structureTolerance > 0) || !(hardTolerance > 0)) return null;

  const boxTest =
    boxChunk && boxChunk.length >= 16
      ? [
          boxChunk.readInt32LE(0),
          boxChunk.readInt32LE(4),
          boxChunk.readInt32LE(8),
          boxChunk.readInt32LE(12),
        ]
      : [0, 0, width, height];

  // Rows are NUL terminated, so the stride is width + 1 -- but only if the
  // chunk is exactly that long. Trusting the stride blindly on a file that
  // pads differently would slice rows out of alignment and ship a grid with
  // embedded NULs that reads as free space.
  const stride = width + 1;
  if (print.length < height * stride) return null;

  const rows = [];
  for (let r = 0; r < height; r += 1) {
    const row = print.subarray(r * stride, r * stride + width).toString('latin1');
    if (/[^FH.]/.test(row)) return null;
    rows.push(row);
  }

  const structureCells = rows.join('').split('').filter((c) => c === 'F').length;
  return {
    width,
    height,
    pivotX,
    pivotZ,
    rows,
    structureCells,
    hardTolerance,
    structureTolerance,
    boxTest,
  };
}

const footprints = new Map();
function scanFootprints(dir, prefix) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanFootprints(child, `${prefix}${entry.name}/`);
      continue;
    }
    if (!entry.name.endsWith('.sfp')) continue;
    const parsed = readFootprint(child);
    if (parsed) footprints.set(`${prefix}${entry.name}`, parsed);
  }
}
scanFootprints(footprintRoot, 'footprint/');

// --- shared templates: footprint reference and display name ----------------

/**
 * `structureFootprintFileName` and `objectName` live on the SHARED template,
 * while the structure table is keyed by the SERVER template — so the two are
 * joined by filename, which is the only thing they have in common.
 */
function readSharedTemplates(dir) {
  const out = new Map();
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.name.endsWith('.tpf')) continue;
      const text = readFileSync(child, 'utf8');
      const footprint = /structureFootprintFileName\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null;
      const name = /objectName\s*=\s*"([^"]+)"\s+"([^"]+)"/.exec(text);
      const key = basename(entry.name, '.tpf').replace(/^shared_/, '');
      const existing = out.get(key);
      // Stems collide across branches now that more than one is scanned, and a
      // later file with no footprint would otherwise clobber an earlier one
      // that had it. Keep whichever entry actually carries the data.
      if (existing?.footprint && !footprint) continue;
      out.set(key, {
        footprint: footprint ?? existing?.footprint ?? null,
        nameTable: name?.[1] ?? existing?.nameTable ?? null,
        nameKey: name?.[2] ?? existing?.nameKey ?? null,
      });
    }
  };
  // Installations and city decorations are not under building/player, and a
  // structure whose shared template is not read has no footprint reference, so
  // it reports unknown lots even though its .sfp is right there.
  for (const branch of [
    join(dir, 'object', 'building'),
    join(dir, 'object', 'installation'),
    join(dir, 'object', 'tangible', 'furniture'),
  ]) {
    if (existsSync(branch)) walk(branch);
  }
  return out;
}

const sharedByStem = readSharedTemplates(sharedDir);

// --- converted models -------------------------------------------------------

let templateModels = new Map();
if (existsSync(templatesPath)) {
  const raw = JSON.parse(readFileSync(templatesPath, 'utf8'));
  const entries = raw.entries ?? raw;
  templateModels = new Map(
    Object.entries(entries).map(([path, entry]) => [path, entry?.model ?? null]),
  );
}

// --- ranks and limits -------------------------------------------------------

const ranks = readTab(join(gameDir, 'datatables', 'city', 'city_rank.tab')).map((row) => ({
  rank: int(row.RANK),
  /** Buildable radius in metres. This is the circle the planner draws. */
  radius: int(row.RADIUS),
  citizens: int(row.POPULATION),
  nameKey: row.STRING || null,
}));

const limits = readTab(join(gameDir, 'datatables', 'city', 'city_limits.tab'))
  .map((row) => ({
    scene: row.SCENE,
    maxCities: int(row.MAX_CITIES),
    mediumCityLimit: int(row.MEDIUM_CITY_LIMIT),
    bigCityLimit: int(row.BIG_CITY_LIMIT),
  }))
  // A planet with a cap of zero has player cities disabled; offering it in a
  // planet picker would invite someone to plan a city they can never place.
  .filter((row) => row.maxCities > 0);

// --- structures -------------------------------------------------------------

/**
 * Lots are computed, not stored.
 *
 * `player_structure.java` derives them from the footprint: a quarter of the
 * occupied cells, less any per-structure reduction, floored at one — unless
 * the structure is flagged as needing no lot at all, which is how a city hall
 * and its civic buildings cost nothing against a player's ten.
 */
function lotsFor(row, footprint) {
  if (int(row.NO_LOT_REQUIREMENT) === 1) return 0;
  if (!footprint) return null;
  const reduction = int(row.LOT_REDUCTION);
  return Math.max(1, Math.floor(footprint.structureCells / 4) - reduction);
}

/**
 * Which planets each structure may actually be placed on.
 *
 * The rule lives on the DEED, not on the structure table: player_structure.java
 * reads `player_structure.deed.scene` from the deed being used and refuses the
 * placement unless the current scene is in that comma-separated list. The deed
 * also names the structure it builds, in `player_structure.deed.template`, so
 * the two objvars together map a structure to its planets.
 *
 * A deed with no scene objvar has no restriction, and a structure with no deed
 * at all is left unrestricted rather than hidden — a missing deed is a gap in
 * this scan, and hiding a buildable structure is worse than listing an extra.
 */
function readDeedScenes(deedRoot) {
  const scenes = new Map();
  if (!existsSync(deedRoot)) return scenes;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.tpf')) continue;

      const text = readFileSync(path, 'utf8');
      const built = /"player_structure\.deed\.template"\s*=\s*"([^"]+)"/.exec(text)?.[1];
      if (!built) continue;
      const list = /"player_structure\.deed\.scene"\s*=\s*"([^"]+)"/.exec(text)?.[1];
      if (!list) {
        // Deed exists but names no planets: placeable anywhere.
        if (!scenes.has(built)) scenes.set(built, null);
        continue;
      }
      const named = list.split(',').map((s) => s.trim()).filter(Boolean);
      // A structure can have more than one deed. The planets are the union:
      // if any deed can place it there, it can be placed there.
      const existing = scenes.get(built);
      if (existing === null) continue;
      scenes.set(built, [...new Set([...(existing ?? []), ...named])].sort());
    }
  };
  walk(deedRoot);
  return scenes;
}

const deedScenes = readDeedScenes(
  join(gameDir, 'object', 'tangible', 'deed'),
);

const structures = [];
for (const row of readTab(join(gameDir, 'datatables', 'structure', 'player_structure.tab'))) {
  const template = row.STRUCTURE;
  if (!template) continue;

  const stem = basename(template, '.iff');
  const shared = sharedByStem.get(stem);
  const footprintPath = row.FOOTPRINT_TEMPLATE || shared?.footprint || null;
  const footprint = footprintPath ? (footprints.get(footprintPath) ?? null) : null;

  structures.push({
    template,
    stem,
    /** Civic structures are the ones a city can place; the rest are housing. */
    civic: int(row.CIVIC) === 1,
    /** City rank at which this unlocks. 0 or absent means no rank gate. */
    cityRank: int(row.CITY_RANK),
    cityCost: int(row.CITY_COST),
    lots: lotsFor(row, footprint),
    maintenanceRate: int(row.MAINT_RATE),
    powerRate: int(row.POWER_RATE),
    isShuttleport: int(row.SHUTTLEPORT) === 1,
    isCloningFacility: int(row.CLONE_FACILITY) === 1,
    isGarage: int(row.GARAGE) === 1,
    footprint: footprint
      ? {
          width: footprint.width,
          height: footprint.height,
          pivotX: footprint.pivotX,
          pivotZ: footprint.pivotZ,
          rows: footprint.rows,
          /** Metres, derived from the cell grid rather than the model bounds. */
          widthMetres: footprint.width * METRES_PER_CELL,
          depthMetres: footprint.height * METRES_PER_CELL,
          /** Metres of height the ground may vary across the footprint. */
          structureTolerance: footprint.structureTolerance,
          hardTolerance: footprint.hardTolerance,
          /** Cells whose ground counts towards that: [x0, z0, x1, z1). */
          boxTest: footprint.boxTest,
        }
      : null,
    nameTable: shared?.nameTable ?? null,
    nameKey: shared?.nameKey ?? null,
    model: templateModels.get(template) ?? null,
    /**
     * Planets this may be placed on, or null when nothing restricts it.
     * From the deed's `player_structure.deed.scene`.
     */
    scenes: deedScenes.has(template) ? deedScenes.get(template) : null,
  });
}

// --- emit -------------------------------------------------------------------

mkdirSync(dataDir, { recursive: true });
const written = [];
function emit(name, value) {
  writeFileSync(join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  written.push([name, Array.isArray(value) ? value.length : Object.keys(value).length]);
}

emit('city-ranks.json', { metresPerCell: METRES_PER_CELL, ranks, limits });
emit('city-structures.json', structures);

for (const [name, count] of written) {
  console.log(`  ${name.padEnd(24)} ${count}`);
}

const civic = structures.filter((s) => s.civic);
const withModel = structures.filter((s) => s.model);
const withFootprint = structures.filter((s) => s.footprint);
console.log(
  `\n${structures.length} structures (${civic.length} civic), ` +
    `${withModel.length} with models, ${withFootprint.length} with footprints`,
);
console.log(`ranks: ${ranks.map((r) => `${r.rank}=${r.radius}m`).join('  ')}`);
