/**
 * Crafting schematics, read from the shipped data rather than from a server.
 *
 * In the full stack `/api/schematics` is answered by the API, which joins each
 * schematic against the galaxy's LIVE resource spawns -- which resource classes
 * are up right now, how good each roll is, and so whether a recipe can be made
 * today. That join is the reason the endpoint exists at all.
 *
 * This repo has no server and no galaxy, so it answers the half that is static
 * -- every schematic, its group, and what each slot wants -- and cannot answer
 * the half that is live. It says so rather than guessing: `available` and
 * `craftableNow` come back null, which the page renders as "needs a live
 * galaxy" instead of as zero spawned and not craftable. Reporting a perfectly
 * good recipe as uncraftable because nothing was asked would be worse than
 * saying nothing.
 *
 * The schematic set is 2.8 MB, which is why the API keeps it server-side. Here
 * there is nowhere else to put it, so the cost is confined instead: `api.ts`
 * imports this module dynamically, which puts the data in its own chunk that
 * only loads when a schematic is actually asked for.
 */

import raw from '@precu/shared/data/schematics.json' with { type: 'json' };

interface SchematicSlot {
  name: string;
  optional: boolean;
  kind: string;
  ingredient: string;
  count: number;
}

interface Schematic {
  id: string;
  stem: string;
  group: string;
  label: string;
  category: string | null;
  crafted: string | null;
  slots: SchematicSlot[];
}

const ROOT = '/api/schematics';

/** The path without its query string, which is all the routing cares about. */
function pathname(path: string): string {
  const cut = path.indexOf('?');
  return cut === -1 ? path : path.slice(0, cut);
}

export function isSchematicPath(path: string): boolean {
  const name = pathname(path);
  return name === ROOT || name.startsWith(`${ROOT}/`);
}

const ALL = raw as Schematic[];

/** Id lookup, built on first use. `find` over 3,717 rows per request is waste. */
let index: Map<string, Schematic> | null = null;
function byId(): Map<string, Schematic> {
  if (!index) index = new Map(ALL.map((s) => [s.id, s]));
  return index;
}

export function handleSchematicRequest<T>(path: string): T {
  const name = pathname(path);

  if (name.startsWith(`${ROOT}/`)) {
    // Ids are directory-qualified to keep them unique, so they contain slashes
    // and the whole tail is the id.
    const id = decodeURIComponent(name.slice(ROOT.length + 1));
    const schematic = byId().get(id);
    if (!schematic) throw new Error(`no such schematic: ${id}`);
    return {
      id: schematic.id,
      group: schematic.group,
      label: schematic.label,
      category: schematic.category,
      crafted: schematic.crafted,
      // No galaxy to ask, so no matches and no count -- stated as null rather
      // than as zero, which would read as "nothing is spawned".
      slots: schematic.slots.map((slot) => ({ ...slot, matches: [], available: null })),
      craftableNow: null,
      missingSlots: [],
    } as T;
  }

  const params = new URLSearchParams(path.slice(pathname(path).length));
  const all = ALL;
  // `get` takes the first of a repeated parameter, which is what the API does
  // with `?q=a&q=b` and what a caller almost always means by it.
  const needle = (params.get('q') ?? '').trim().toLowerCase();
  const group = (params.get('group') ?? '').trim();
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(params.get('limit') || '60', 10) || 60),
  );

  let matches = all;
  if (group) matches = matches.filter((s) => s.group === group);
  if (needle) matches = matches.filter((s) => s.label.includes(needle) || s.id.includes(needle));

  return {
    items: matches.slice(0, limit).map((s) => ({
      id: s.id,
      group: s.group,
      label: s.label,
      category: s.category,
      resourceSlots: s.slots.filter((slot) => slot.kind === 'resource').length,
    })),
    total: matches.length,
    groups: [...new Set(all.map((s) => s.group))].sort(),
  } as T;
}
