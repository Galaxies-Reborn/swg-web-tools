# SWG Web Tools

Planning tools for Star Wars Galaxies Pre-CU, built from the game's own data
rather than from tables typed out by hand.

| Tool | What it does |
| --- | --- |
| **Planet Map** | A whole planet as real ground. Pick a site for a city and see what it stands on — how far the land moves across the city's own radius, and how much of it is water and cannot be built on. |
| **City Planner** | Lay out a city on the lot grid, on real terrain where it has been baked. Rank limits, per-planet availability and costs come from the game's structure tables, and the ground is refused where the game would refuse it. |
| **Ship Builder** | Fit a starfighter and see it assembled — components restricted to what the chassis accepts, parts on the hardpoints the attachment tables name, and the paint schemes the hull can wear. |
| **Crafting** | Every schematic and what each of its slots wants. Which resources are spawned needs a live galaxy, so that part reads "—" here rather than zero. |
| **Asset Viewer** | Browse converted client models: geometry, materials, hardpoints, animation clips. |

Static tools. No account, no server, nothing leaves the browser.

## Running it

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>. Needs Node 22+ and pnpm 10.

Crafting works immediately — its data ships with the repo. The city planner
works as a lot grid. The rest need data generated from your own copy of the
game client, which is what the next section is for.

## Generating the client data

None of the client's data is redistributable, so none of it is here. The
pipeline that produces it is: `tools/tre-extract` reads the client's `.tre`
archives directly and writes what the tools load. No game client running, no
Maya, no intermediate formats.

### What you need

- A Pre-CU client install — the directory holding the `.tre` archives.
- Python 3.11 or newer.
- For the last step only, a checkout of the server source, which is where the
  datatables live.

Install the pipeline once:

```bash
cd tools/tre-extract
pip install -e ".[dev]"
```

Everything below is run from the repository root, with `CLIENT` pointing at
your client directory and `ASSETS` at the tree the web app serves. Set them
once:

```bash
CLIENT="/path/to/PreCU-Client"
ASSETS="apps/web/public/assets"
```

If you would rather keep the assets outside the repo, put them anywhere and
point `NEXT_PUBLIC_ASSET_BASE` at the URL they are served from.

### 1. Models, textures and the manifest

Converts every appearance to glTF, with its materials, hardpoints and bounds.
This is the long one, and the bulk of the output.

```bash
tre-extract convert --tre-dir "$CLIENT" --out "$ASSETS" --preset web
```

Writes `manifest.json`, `models/*.glb`, `patterns/*.webp` and `palettes.json`.
Needed by the **asset viewer** and the **ship builder**.

Animation clips are opt-in, because a clip binds to a skeleton rather than to a
model and matching them is the part that goes wrong. Pass globs generously and
let the coverage test sort them out:

```bash
tre-extract convert --tre-dir "$CLIENT" --out "$ASSETS" --preset web \
  --animation "appearance/animation/*_idl_stand_breathe.ans" \
  --animation "appearance/animation/*_loc_walk.ans" \
  --animation "appearance/animation/*_loc_run.ans"
```

### 2. The template index

Joins each object template to the model it uses and the string that names it,
so the tools can show a thing rather than a file path.

```bash
tre-extract templates --tre-dir "$CLIENT" \
  --out "$ASSETS/templates.json" --manifest "$ASSETS/manifest.json"
```

### 3. Display names

```bash
tre-extract strings --tre-dir "$CLIENT" \
  --out "$ASSETS/strings.en.json" --from-templates "$ASSETS/templates.json"
```

### 4. Terrain

Ground height is not stored in the game. It is produced by walking a tree of
terrain affectors, at roughly a millisecond a sample, so it is computed offline
and baked. A planet is 16,384 m of 8 m chunks — 2048 × 2048 samples — which is
why this fans out over every core and is still the slowest step here.

```bash
tre-extract terrain --tre-dir "$CLIENT" --planet tatooine --planet-wide \
  --out "$ASSETS/terrain"
```

Repeat per planet: `tatooine naboo corellia rori talus dantooine dathomir endor
lok yavin4`. All ten come to roughly 130 MB.

```
assets/terrain/
  <planet>/planet.json          what was baked, and how
  <planet>/overview.height      32 m overview, what the planet map draws
  <planet>/<z>_<x>.height       8 m tiles, what the planner draws
  <planet>/<z>_<x>.flags        water and slope bits, per sample
```

Needed by the **planet map**, and by the **city planner** for real ground.

### 5. What is already standing there

The static world objects a city has to avoid, at their real footprints, read
from each planet's snapshot.

```bash
tre-extract blockers --tre-dir "$CLIENT" \
  --out "$ASSETS/blockers" --assets "$ASSETS"
```

### 6. Placeable decorations

The props a plan can put down, each with its own collision volume — its real
collision extent where it has one, its render bounds where it does not.

```bash
tre-extract props --tre-dir "$CLIENT" \
  --out "$ASSETS/props.json" --assets "$ASSETS"
```

### 7. Ship attachment points

The only step that needs the server source as well, because the per-chassis
attachment tables live there. It writes both the shared data and the attachment
models the ship builder hangs on a hull.

```bash
node packages/shared/scripts/generate-ship-attachments.mjs \
  --server-repo /path/to/server-source --templates "$ASSETS/templates.json"
```

### Checking it worked

```
assets/
  manifest.json          every model, with bounds, materials, hardpoints, clips
  models/*.glb
  patterns/*.webp        paint masks
  palettes.json
  templates.json
  strings.en.json
  terrain/<planet>/...
  blockers/<planet>.json
  props.json
  ship-attachments/
```

Nothing here is required. Each tool loads what it can and says what is missing
rather than failing, so a partial run is a usable state rather than a broken
one.

## Saved designs live in your browser

The planner and the planet map save to `localStorage`, so a design belongs to
one browser on one machine. Clearing site data loses it, and nothing is shared
between people. Both have **Export JSON**, which is how to move or keep a
design.

This is what lets the tools run with no backend. The swap point is one file:
`apps/web/src/lib/designs.ts`, with `apps/web/src/lib/schematics.ts` doing the
same for the crafting data.

## Where the data comes from

`packages/shared/data/*.json` is generated from the game's datatables and
templates, not authored here, and `packages/shared/scripts/` holds the
generators. They need a client and server-source checkout, so they do not run
out of the box; they are included so any number can be traced to its source.

The values that are easy to get wrong, and where they actually come from:

- **City structure costs** are a tier index in `player_structure.tab`, not an
  amount. `city.java` switches on it, and the ordering is not monotonic — tier
  2 is dearest, tier 4 cheapest. Summing the raw column understates a city's
  upkeep by three orders of magnitude and ranks buildings backwards.
- **Whether ground will take a building** is `LotManager::canPlace`: the
  terrain under the footprint is accumulated into a box, and the site is
  refused when that box is taller than the structure's own tolerance — 3 m to
  8 m depending on the building. A structure does not flatten the ground under
  it and does not follow it; it stands at the top of its footprint and
  overhangs what falls away.
- **Ship component mass budgets** come from the shipwright draft schematics,
  not from `shiptype.tab`, whose values are a flat placeholder.
- **Ship attachments** are read from `ship_chassis_<chassis>.iff`, so a part
  hangs where the game hangs it.
- **Buildable ground** is the water bitmap already baked into each `.trn`, on
  the same 8 m grid the game's own lot manager uses.

## Layout

```
apps/web            Next.js 15 app — the tools
packages/shared     Game data and the logic over it, with tests
tools/tre-extract   The asset pipeline, in Python
```

`@precu/shared` ships TypeScript source rather than a build artifact; Next
compiles it alongside the app.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

`pnpm test` and `pnpm lint` cover the Python pipeline too, through `pytest` and
`ruff`. Neither is required to work on the web app: if Python is not installed
they report exactly what went unchecked and how to run it, and carry on. A tool
that is present and unhappy still fails the build, which is the point.
