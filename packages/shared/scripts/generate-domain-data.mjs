#!/usr/bin/env node
/**
 * Regenerates packages/shared/data/*.json from the authoritative server sources.
 *
 * Everything in data/ is derived, never hand-edited: if the galaxy changes its
 * resource tree or adds a game object type, re-run this instead of patching the
 * JSON. The generated files are committed so the web tier builds without the
 * server repo checked out.
 *
 *   node scripts/generate-domain-data.mjs [--server-repo <path>]
 *
 * Defaults to ../../../Source/pre-cu-reborn-server relative to the repo root,
 * which is where it sits in the PRE-CU Reborn workspace.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  arg('server-repo', join(repoRoot, '..', 'Source', 'pre-cu-reborn-server')),
);

if (!existsSync(serverRepo)) {
  console.error(`server repo not found at ${serverRepo}`);
  console.error('pass --server-repo <path> to point at pre-cu-reborn-server');
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });

const written = [];
function emit(name, value) {
  const path = join(dataDir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  written.push([name, Array.isArray(value) ? value.length : Object.keys(value).length]);
}

// ---------------------------------------------------------------------------
// Resource tree — dsrc datatable, tab separated, row 0 = headers, row 1 = types
// ---------------------------------------------------------------------------

function parseResourceTree() {
  const path = join(
    serverRepo,
    'dsrc/sku.0/sys.shared/compiled/game/datatables/resource/resource_tree.tab',
  );
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = lines[0].split('\t');
  const col = (name) => headers.indexOf(name);

  const idxIndex = col('INDEX');
  const idxEnum = col('ENUM');
  const classCols = headers
    .map((h, i) => (/^CLASS \d+$/.test(h) ? i : -1))
    .filter((i) => i !== -1);
  const attrCols = headers
    .map((h, i) => (/^Attribute \d+$/.test(h) ? i : -1))
    .filter((i) => i !== -1);
  const idxMinPools = col('Minimum # Pools');
  const idxMaxPools = col('Maximum # Pools');
  const idxRecycled = col('Recycled');
  const idxPermanent = col('Permanent');
  const idxContainer = col('Resource Container Type');

  // A row's depth is the index of the CLASS column it fills in. Parents are
  // therefore the most recent row one level shallower.
  const rows = [];
  const stack = [];

  for (const line of lines.slice(2)) {
    const cells = line.split('\t');
    const depth = classCols.findIndex((c) => (cells[c] ?? '').trim().length > 0);
    if (depth === -1) continue;

    const id = (cells[idxEnum] ?? '').trim();
    if (!id) continue;

    const attrRanges = {};
    for (let a = 0; a < attrCols.length; a += 1) {
      const attr = (cells[attrCols[a]] ?? '').trim();
      if (!attr) continue;
      const minCol = col(`Att ${a + 1} min`);
      const maxCol = col(`Att ${a + 1} max`);
      const min = Number.parseInt(cells[minCol] ?? '', 10);
      const max = Number.parseInt(cells[maxCol] ?? '', 10);
      attrRanges[attr] = {
        min: Number.isFinite(min) ? min : 1,
        max: Number.isFinite(max) ? max : 1000,
      };
    }

    stack.length = depth;
    const parent = depth > 0 ? (stack[depth - 1] ?? null) : null;
    stack[depth] = id;

    const minPools = Number.parseInt(cells[idxMinPools] ?? '', 10);
    const maxPools = Number.parseInt(cells[idxMaxPools] ?? '', 10);

    rows.push({
      index: Number.parseInt(cells[idxIndex] ?? '0', 10),
      id,
      name: (cells[classCols[depth]] ?? '').trim(),
      depth,
      parent,
      // Only leaves with a pool count actually spawn as harvestable types.
      spawnable: Number.isFinite(maxPools) && maxPools > 0,
      minPools: Number.isFinite(minPools) ? minPools : 0,
      maxPools: Number.isFinite(maxPools) ? maxPools : 0,
      recycled: (cells[idxRecycled] ?? '').trim() === '1',
      permanent: (cells[idxPermanent] ?? '').trim() === '1',
      container: (cells[idxContainer] ?? '').trim() || null,
      attributes: attrRanges,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// GameObjectType enum — C++ header with explicit bases and implicit increments
// ---------------------------------------------------------------------------

function parseGameObjectTypes() {
  const path = join(
    serverRepo,
    'src/engine/shared/library/sharedGame/src/shared/objectTemplate/SharedObjectTemplate.h',
  );
  const src = readFileSync(path, 'utf8');
  const block = src.match(/enum\s+GameObjectType\s*\{([\s\S]*?)\n\s*\};/);
  if (!block) throw new Error('GameObjectType enum not found');

  const out = [];
  let next = 0;
  for (const raw of block[1].split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line || !line.startsWith('GOT_')) continue;
    const m = line.match(/^(GOT_\w+)\s*(?:=\s*(0x[0-9a-fA-F]+|\d+))?\s*,?$/);
    if (!m) continue;
    const [, name, explicit] = m;
    if (explicit !== undefined) {
      next = explicit.startsWith('0x')
        ? Number.parseInt(explicit.slice(2), 16)
        : Number.parseInt(explicit, 10);
    }
    if (name === 'GameObjectType_Last' || name.endsWith('_Last')) continue;
    out.push({
      name,
      id: name.replace(/^GOT_/, ''),
      value: next,
      // High bits are the category, low byte the subtype. GOT_armor == 0x100,
      // GOT_armor_body == 0x101, and so on.
      category: next & 0xffffff00,
      isCategoryRoot: (next & 0xff) === 0,
      deprecated: name.endsWith('_DUMMY'),
    });
    next += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------

const resourceTree = parseResourceTree();
emit('resource-tree.json', resourceTree);

const gots = parseGameObjectTypes();
emit('game-object-types.json', gots);

// Attribute display metadata is not in any datatable — it lives in the client
// string tables. The canonical short codes are stable across every Pre-CU
// build, so they are declared here and validated against the tree above.
const attributeMeta = {
  res_decay_resist: { code: 'DR', label: 'Decay Resistance' },
  res_quality: { code: 'OQ', label: 'Overall Quality' },
  res_flavor: { code: 'FL', label: 'Flavor' },
  res_potential_energy: { code: 'PE', label: 'Potential Energy' },
  res_malleability: { code: 'MA', label: 'Malleability' },
  res_toughness: { code: 'UT', label: 'Unit Toughness' },
  res_shock_resistance: { code: 'SR', label: 'Shock Resistance' },
  res_cold_resist: { code: 'CD', label: 'Cold Resistance' },
  res_heat_resist: { code: 'HR', label: 'Heat Resistance' },
  res_conductivity: { code: 'CR', label: 'Conductivity' },
  entangle_resistance: { code: 'ER', label: 'Entanglement Resistance' },
};

const seenAttrs = new Set();
for (const row of resourceTree) for (const a of Object.keys(row.attributes)) seenAttrs.add(a);
const unknown = [...seenAttrs].filter((a) => !(a in attributeMeta));
if (unknown.length) {
  console.error(`resource tree uses attributes with no display metadata: ${unknown.join(', ')}`);
  process.exit(1);
}
emit('resource-attributes.json', attributeMeta);

for (const [name, count] of written) console.log(`  ${name}  (${count} entries)`);
console.log(`generated ${written.length} files from ${serverRepo}`);
