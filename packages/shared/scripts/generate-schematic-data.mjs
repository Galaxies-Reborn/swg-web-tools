#!/usr/bin/env node
/**
 * Regenerates packages/shared/data/schematics.json from the draft schematics.
 *
 * A draft schematic lists the ingredient slots a craft needs. The ones that
 * matter to a resource planner are `IT_resourceClass` slots: they name a
 * resource class and a count, and any spawned resource descending from that
 * class satisfies them. That is what turns "what can I make" into "what on the
 * server right now can I make it from".
 *
 *   node scripts/generate-schematic-data.mjs [--server-repo <path>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
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
const root = join(
  serverRepo,
  'dsrc', 'sku.0', 'sys.server', 'compiled', 'game', 'object', 'draft_schematic',
);

if (!existsSync(root)) {
  console.error(`draft schematics not found at ${root}`);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) walk(child, out);
    else if (entry.name.endsWith('.tpf')) out.push(child);
  }
  return out;
}

/**
 * Pull the resource-class slots out of a schematic.
 *
 * The `.tpf` is a nested literal rather than a table, and only two things in
 * it matter here: which resource class a slot wants and how much. Both appear
 * on one line per ingredient, so they are matched together — reading them with
 * separate patterns would pair a class with the wrong count on any schematic
 * whose slots are not one-to-one.
 */
const INGREDIENT = /ingredientType\s*=\s*IT_(\w+)[\s\S]*?ingredient\s*=\s*"([^"]*)"\s*,\s*count\s*=\s*(\d+)/g;

/**
 * Which of the two things a slot wants: raw resource, or a made component.
 *
 * The split is the game's own, from ManufactureInstallationObject: a factory
 * pulls `IT_resourceType` and `IT_resourceClass` from the hopper as resources,
 * and `IT_item`, `IT_template`, `IT_templateGeneric`, `IT_schematic` and
 * `IT_schematicGeneric` as components. Reading only `resourceClass` as a
 * resource misses every schematic that names a specific resource type, and
 * those slots then look unfillable to a planner.
 */
const RESOURCE_TYPES = new Set(['resourceClass', 'resourceType']);
const COMPONENT_TYPES = new Set([
  'item',
  'template',
  'templateGeneric',
  'schematic',
  'schematicGeneric',
]);

function slotKind(ingredientType) {
  if (RESOURCE_TYPES.has(ingredientType)) return 'resource';
  if (COMPONENT_TYPES.has(ingredientType)) return 'component';
  // IT_none and anything a later build adds: named as-is rather than guessed
  // at, so an unhandled type is visible instead of silently counted as one of
  // the two.
  return ingredientType;
}
const SLOT_NAME = /name\s*=\s*"[^"]*"\s+"([^"]*)"/;

function parseSchematic(path) {
  // Commented-out slots are not slots.
  //
  // A few schematics keep a disabled slot in the file behind `//`. The block
  // splitter cannot see a `[` that is prefixed with a comment marker, so the
  // last real slot ran to end-of-file and swallowed the dead block; the
  // ingredient regex then found the commented ingredient inside it and emitted
  // it as an extra slot, inheriting the previous slot's name and required flag.
  // That told players a mining harvester needs an armour module it does not.
  //
  // Safe to strip wholesale: no `//` occurs inside a quoted string anywhere in
  // the .tpf tree.
  const text = readFileSync(path, 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');

  const crafted = /craftedObjectTemplate\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  const category = /category\s*=\s*(\w+)/.exec(text)?.[1] ?? null;

  // Slots are separated by the `optional=` marker that opens each one.
  const blocks = text.split(/\n\s*\[\s*\n\s*optional\s*=/).slice(1);
  const slots = [];
  for (const block of blocks) {
    const optional = /^\s*true/.test(block);
    const name = SLOT_NAME.exec(block)?.[1] ?? '';
    INGREDIENT.lastIndex = 0;
    let match;
    while ((match = INGREDIENT.exec(block)) !== null) {
      const [, kind, ingredient, count] = match;
      if (!ingredient) continue;
      slots.push({
        name,
        optional,
        kind: slotKind(kind),
        ingredient,
        count: Number.parseInt(count, 10) || 0,
      });
    }
  }

  return { crafted, category, slots };
}

const files = walk(root);
const schematics = [];
for (const file of files) {
  const parsed = parseSchematic(file);
  if (parsed.slots.length === 0) continue;

  const rel = relative(root, file).split(sep);
  const stem = rel[rel.length - 1].replace(/\.tpf$/, '');
  // Base and shared templates are scaffolding, not craftable things.
  if (stem.startsWith('base_') || stem.startsWith('shared_')) continue;

  // The bare filename stem is not unique -- eight collide across groups, and
  // a lookup by id then served one of each pair and made the other
  // unreachable. Qualifying by the directory it came from restores a 1:1 id.
  const group = rel.length > 1 ? rel[0] : 'misc';
  const id = rel.length > 1 ? `${rel.slice(0, -1).join('/')}/${stem}` : stem;

  schematics.push({
    id,
    stem,
    group,
    label: stem.replace(/_/g, ' '),
    category: parsed.category,
    crafted: parsed.crafted,
    slots: parsed.slots,
  });
}

schematics.sort((a, b) => a.id.localeCompare(b.id));

mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'schematics.json'), `${JSON.stringify(schematics)}\n`, 'utf8');

const withResource = schematics.filter((s) => s.slots.some((slot) => slot.kind === 'resource'));
const classes = new Set(
  schematics.flatMap((s) => s.slots.filter((x) => x.kind === 'resource').map((x) => x.ingredient)),
);
console.log(`  schematics.json          ${schematics.length}`);
console.log(
  `\n${schematics.length} schematics from ${files.length} files, ` +
    `${withResource.length} take resources, ${classes.size} distinct resource classes`,
);
