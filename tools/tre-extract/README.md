# tre-extract

Converts Star Wars Galaxies TRE assets into glTF 2.0 binaries the web viewer
can load directly. No game client, no Maya, no intermediate formats — point it
at a directory of `.tre` files and it emits `.glb` plus a manifest.

```bash
pip install -e ".[dev]"
```

## Use

Mount the archives and look around:

```bash
tre-extract list --tre-dir "E:/SWG/PRE-CU-Reborn/PreCU-Client" --suffix .msh --limit 20
```

See what an appearance actually points at, through every layer of indirection:

```bash
tre-extract resolve --tre-dir "E:/SWG/PRE-CU-Reborn/PreCU-Client" appearance/frn_tato_vase_s02.apt
```

Dump an asset's IFF tree when a format surprises you:

```bash
tre-extract inspect --tre-dir "E:/SWG/PRE-CU-Reborn/PreCU-Client" appearance/mesh/angler_hue.lmg
```

Convert:

```bash
tre-extract convert --tre-dir "E:/SWG/PRE-CU-Reborn/PreCU-Client" --out ../../apps/web/public/assets --preset web
```

Loose directories mount above the archives, so overrides in
`pre-cu-reborn-assets` win exactly as the running client sees them:

```bash
tre-extract convert --tre-dir "E:/SWG/PRE-CU-Reborn/PreCU-Client" --loose "E:/SWG/PRE-CU-Reborn/Source/pre-cu-reborn-assets" --out ./out
```

Attach animation clips with `--animation`, which takes a glob over `.ans`
paths and is repeatable. A clip binds only when it corresponds to the model's
skeleton:

```bash
tre-extract convert --tre-dir "<client>" --out ./out   --animation "appearance/animation/*_idl_stand_breathe.ans"   --animation "appearance/animation/*_loc_walk.ans"   --animation "appearance/animation/*_loc_run.ans"   --animation "appearance/animation/all_b_idl_breathe_normally.ans"   --animation "appearance/animation/all_b_loc_walk_male.ans"   --animation "appearance/animation/all_b_loc_walk_female.ans"   --animation "appearance/animation/all_b_loc_jog.ans"
```

Pass clips generously and let the matching sort them out — but understand what
it can and cannot decide.

`--animation-coverage` measures a clip against a skeleton **in both
directions**, and takes the weaker ratio. Asking only whether a clip's bones
exist is not a similarity test: `orb_loc_walk` animates two bones, both of
which the rancor has, so it scores a perfect 1.0 and binds, giving a rancor
that twitches one joint. Against the rancor's 45 bones its own walk scores
1.00/0.98 while frog, tauntaun, orb and bantha walks reach at most 0.57/0.40,
so the default 0.5 rejects all of them.

What coverage *cannot* decide is which of several correct clips belong to an
asset. Every humanoid shares one skeleton, so a chef's apron matches Boss
Nass's walk, the protocol droid's walk and the generic humanoid walk equally
— all three really are authored for those bones. Clips are therefore ranked
by ownership (the asset's own species, then the generic `all_b` set, then
anything else), another character's clip is dropped when something better
matched, and `--animation-limit` caps what survives. Without that ranking a
wearable collected thirteen near-duplicate clips and grew 3.5x, across 4,748
wearables.

Clips are baked into each GLB and not shared between them, so every clip is
paid for per asset. That is what the cap is defending against.

## What it produces

```
out/
  manifest.json          every asset: bounds, triangle count, size, warnings
  models/
    mesh/foo_l0.glb      self-contained: geometry + materials + textures
```

Textures are embedded in the GLB as WebP, so the viewer makes one request per
model. Presets trade size for detail: `compact` (512 px), `web` (1024 px,
default), `high` (2048 px).

## Formats

| Extension | Root tag | What it is |
| --- | --- | --- |
| `.tre` | `TREE` | The archive itself. Versions 0004/0005/0006, zlib TOC and name block. |
| `.apt` | `APT` | An indirection: one `NAME` chunk naming the real appearance. |
| `.lmg` | `MLOD` | LOD list for skinned meshes, finest first. |
| `.lod` | `DTLA` | LOD list for static meshes, coarsest first, paths relative to `appearance/`. |
| `.cmp` | `CMPA` | A composite of several appearances. |
| `.msh` | `MESH` | Static geometry, as a shader-primitive set. |
| `.mgn` | `SKMG` | Skinned geometry: creatures, bodies, wearables. Exported rigged. |
| `.sat` | `SMAT` | Skeletal appearance: names the mesh generators and the skeleton. |
| `.skt` | `SLOD` | Skeleton: bone hierarchy and rest pose, four detail levels. |
| `.sht` | `SSHT` | Shader template: texture bindings and the effect that decides blending. |
| `.ans` | `KFAT` / `CKAT` | Animation clips. `CKAT` packs each rotation into one 32-bit word and stores no `w`; it is recovered from the other three. |
| `APPR` | — | Sub-form inside an appearance carrying extents, floors and hardpoints. |
| `.dds` | — | Textures, mostly DXT1/3/5. |

Three things about these formats reliably cost an afternoon if you meet them
the hard way, so they are called out in the code:

- **IFF node headers are big-endian; payloads are little-endian.** The tree
  was written with `htonl`, the contents with `memcpy`.
- **SWG's IFF does not pad odd-length nodes.** Applying the classic EA-85 pad
  rule desynchronises the entire file after the first odd chunk.
- **SWG is left-handed (Z forward), glTF is right-handed (Z backward).**
  Converting means negating Z *and* flipping triangle winding. Doing one
  without the other gives a model that is inside-out or mirrored.

Two more that affect what you see rather than whether it parses:

- Texture coordinate sets carry a per-set *dimension* in the format flags, so a
  set may hold 1–4 floats. Assuming 2 shears the UVs of anything using
  projected or 3D coordinates.
- `*_n.dds` normal maps are DXT5 with X moved into alpha to survive block
  compression. Copying RGBA straight through inverts lighting; the converter
  rebuilds XYZ from (A, G).

Skinned meshes differ from static ones in a way worth knowing before reading
`skinned.py`: their attributes are **indexed separately**. A shader's vertex
list reaches positions through `PIDX` and normals through `NIDX`, and the two
need not agree, so exporting means de-indexing into one vertex per shader
vertex. glTF has no equivalent of per-attribute index streams.

Their positions are stored already in bind pose, so the geometry looks correct
standing still even before the skeleton is attached.

Rigging them has three traps, each producing a file that loads fine and poses
wrongly:

- **Quaternions are stored w,x,y,z**; glTF wants x,y,z,w. Reading in file order
  puts the real w into x.
- **A mesh's joint indices address its own `XFNM` bone list**, a reordered
  subset of the skeleton — a shirt lists 15 bones from the spine where the
  skeleton has 38 from the legs. They are remapped by name, and a partial match
  is refused rather than binding stray vertices to joint zero.
- **Those names differ only in case** (`lclav` against `lClav`), because the
  engine hashes both through a lower-cased CRC.

Negating Z for handedness also mirrors joint rotations: x and y negate, z and w
do not. Negating the whole quaternion is a no-op, since q and -q are the same
rotation.

## Hardpoints

Appearances carry named attachment points — how SWG hangs a weapon on a ship's
wing or an exhaust behind a booster. They live in the optional `HPTS` form
inside `APPR`, as `HPNT` chunks of twelve floats (a 3x4 affine matrix, column
vectors, translation in the last column) followed by the name.

They are emitted as empty glTF nodes named after the hardpoint, marked with
`extras.hardpoint`, and listed in the manifest. glTF has no hardpoint concept
and an extension would need every consumer to understand it; an empty node
carries the same information in the form every loader already reads, so
three.js finds one with `getObjectByName` and anything parented to it inherits
the attachment transform:

```js
const wing = ship.getObjectByName('wing1')
wing.add(weaponModel)   // positioned and oriented automatically
```

Hardpoints are collected from every file in the resolution chain, not just the
leaf mesh — an X-wing's `wing1` is on the body `.lod`, and reading only the
mesh would miss exactly the points an attachment tool needs. They are mirrored
with the geometry: the transform becomes `S*M*S`, which flips the terms
coupling Z to X and Y. Negating only the translation would leave an attachment
correctly placed but pointing backwards.

## Not yet converted

- **Customisation variables.** Player-tinted items export in their base colours.
- **Direction-sorted index buffers (`SIDX`).** Skipped deliberately — they
  duplicate `INDX` for the fixed-function alpha sort and are useless to a
  depth-sorting renderer.

## Tests

```bash
python -m pytest tests -q
```

The suite builds its own IFF and glTF bytes, so it runs without game data. To
check against the real corpus, convert a slice and validate the output:

```bash
tre-extract convert --tre-dir "<client>" --out /tmp/assets --pattern "appearance/mesh/frn_*.msh" --limit 50
```
