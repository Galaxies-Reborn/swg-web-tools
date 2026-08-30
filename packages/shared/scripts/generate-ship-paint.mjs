#!/usr/bin/env node
/**
 * Regenerates packages/shared/data/ship-paint.json — the paint schemes a
 * player can put on each hull.
 *
 * A ship's paint is not a datatable. It lives in the customisable shader: a
 * `CSHD` template carries a `TFAC` form whose `PAL` chunks each name a
 * customisation variable (`index_color_1`), the texture whose ALPHA masks
 * where that colour lands, a palette file, and the index the hull ships with.
 * The client's pixel program then does
 *
 *     hue  = lerp(1, paletteColour, mask)
 *     rgb  = diffuse * light * hue_1 * hue_2
 *
 * so a colour only tints where the artist marked it — on an X-wing that is the
 * flame markings, about 8% of the hull, which is why tinting the whole model
 * would look nothing like the game.
 *
 * This script does not read the client archives itself. The converter records
 * each model's hue channels into the asset manifest, and the palettes are
 * extracted alongside; this joins them to the chassis list.
 *
 *   node scripts/generate-ship-paint.mjs [--manifest <manifest.json>]
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

const manifestPath = resolve(
  arg('manifest', join(repoRoot, 'apps', 'web', 'public', 'assets', 'manifest.json')),
);
const palettePath = resolve(
  arg('palettes', join(repoRoot, 'apps', 'web', 'public', 'assets', 'palettes.json')),
);

if (!existsSync(manifestPath)) {
  console.error(`no manifest at ${manifestPath}; run the converter first`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const byKey = new Map(Object.values(manifest.entries ?? {}).map((e) => [e.key, e]));

/** Palette name -> array of #rrggbb, written by the converter. */
const palettes = existsSync(palettePath) ? JSON.parse(readFileSync(palettePath, 'utf8')) : {};

const chassisPath = join(dataDir, 'ship-chassis.json');
const rawChassis = existsSync(chassisPath) ? JSON.parse(readFileSync(chassisPath, 'utf8')) : [];
const chassisList = Array.isArray(rawChassis) ? rawChassis : (rawChassis.chassis ?? []);

/**
 * Structural models a chassis draws alongside its hull, from the attachment
 * data. A wing is painted by the same customisation variables as the hull it
 * belongs to, but out of its own textures, so it needs its own pattern list.
 */
function drawnModels(chassisName) {
  const path = join(
    repoRoot, 'apps', 'web', 'public', 'assets', 'ship-attachments', `${chassisName}.json`,
  );
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const models = new Set((data.structural ?? []).map((x) => (typeof x === 'string' ? x : x.model)));
    // Component attachments too. An engine or a cannon carries the same
    // hue-swap shader the fuselage does, so leaving them out left them showing
    // the raw magenta the game paints over.
    for (const slots of Object.values(data.components ?? {})) {
      for (const cell of Object.values(slots)) {
        for (const attachment of cell.attachments ?? []) models.add(attachment.model);
      }
    }
    return [...models];
  } catch {
    return [];
  }
}

/** The pattern list and material for one converted model, or null. */
function patternsFor(entry) {
  const channels = entry?.pattern ?? [];
  if (channels.length === 0) return null;
  const byTag = new Map(channels.map((c) => [c.textureTag, c]));
  const count = Math.min(...channels.map((c) => c.options.length));
  const patterns = [];
  for (let i = 0; i < count; i += 1) {
    const primary = byTag.get('MAIN')?.options[i];
    const secondary = byTag.get('HUEB')?.options[i];
    if (!primary) continue;
    patterns.push({
      index: i,
      primaryMask: primary.mask ?? null,
      secondaryMask: secondary?.mask ?? null,
    });
  }
  if (patterns.length === 0) return null;
  return { material: channels[0]?.material ?? null, patterns };
}

const schemes = {};
let withPaint = 0;

for (const chassis of chassisList) {
  if (!chassis.model) continue;
  const entry = byKey.get(chassis.model);
  const hue = entry?.hue ?? [];
  if (hue.length === 0) continue;

  // One channel per customisation variable. A hull's shaders repeat the same
  // pair across materials, so the variable name is the identity, not the
  // material.
  const channels = new Map();
  for (const channel of hue) {
    if (channels.has(channel.variable)) continue;
    const colours = palettes[channel.palette] ?? [];
    if (colours.length === 0) continue;
    channels.set(channel.variable, {
      variable: channel.variable,
      /** Which sampler's alpha masks this colour. */
      textureTag: channel.textureTag,
      palette: channel.palette,
      defaultIndex: channel.index,
      colours,
    });
  }

  // Every model the hull draws, each with its own patterns. The wings are
  // painted by the same variables as the fuselage but out of their own
  // textures, and leaving them out left them showing the raw magenta the game
  // paints over.
  const models = {};
  const hullPatterns = patternsFor(entry);
  if (hullPatterns) models[chassis.model] = hullPatterns;
  for (const model of drawnModels(chassis.name)) {
    if (models[model]) continue;
    const drawn = patternsFor(byKey.get(model));
    if (drawn) models[model] = drawn;
  }

  if (channels.size === 0 && Object.keys(models).length === 0) continue;
  schemes[chassis.name] = {
    chassis: chassis.name,
    channels: [...channels.values()],
    models,
  };
  withPaint += 1;
}

mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'ship-paint.json'), `${JSON.stringify(schemes)}\n`, 'utf8');

const paletteCount = Object.keys(palettes).length;
console.log(`  ship-paint.json          ${withPaint} chassis`);
console.log(
  `\n${withPaint} of ${chassisList.length} chassis have paint channels, ` +
    `across ${paletteCount} palettes`,
);
if (withPaint === 0) {
  console.log('  (no hue data in the manifest — re-run the converter to record it)');
}
