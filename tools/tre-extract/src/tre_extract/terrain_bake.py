"""Bake a square of ground into something a browser can draw.

Generating height is expensive -- about 2 ms a sample, because every sample
walks the whole layer tree -- so it happens here, once, offline, and the web app
loads the result. A 900 m square at 8 m spacing is roughly 13,000 samples and
half a minute; asking for that inside a web request would not work.

8 m is the default spacing on purpose. It is the size of a terrain chunk, of a
lot, and of one cell in the baked water map, so a tile lines up exactly with the
grid the planner already draws and with the buildability bits shipped in the
.trn. Finer spacing is available and costs time quadratically.

The heightfield goes out as int16 DECIMETRES rather than float32: it halves the
payload, and 10 cm is far below what anyone can see on a hillside.

Decimetres and not centimetres because centimetres do not fit. The range would
cap at +-327 m, and tatooine alone has terrain above 345 m -- a bake at that
scale silently flattened 1.2% of the planet, shaving up to 17.7 m off its
highest ground. Decimetres reach +-3,276 m, an order of magnitude clear of
anything the shipped planets contain, and the bake still refuses rather than
wrapping if that ever stops being true.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path

from .formats.terrain import Terrain

#: Heights are stored in decimetres, so this is the highest a planet may be.
_INT16_LIMIT_DM = 32767


@dataclass(frozen=True)
class BakeTile:
    planet: str
    centre_x: float
    centre_z: float
    span: float
    spacing: float
    samples: int
    min_height: float
    max_height: float

    def to_json(self) -> dict:
        return {
            "planet": self.planet,
            # The south-west corner in world metres, so the client can map a
            # world coordinate to a sample without knowing how it was baked.
            "originX": self.centre_x - self.span / 2,
            "originZ": self.centre_z - self.span / 2,
            "centreX": self.centre_x,
            "centreZ": self.centre_z,
            "span": self.span,
            "spacing": self.spacing,
            "samples": self.samples,
            "minHeight": round(self.min_height, 3),
            "maxHeight": round(self.max_height, 3),
            "heightUnits": "int16 decimetres, row-major from the south-west corner",
        }


def bake(
    terrain: Terrain,
    planet: str,
    centre_x: float,
    centre_z: float,
    span: float,
    spacing: float,
    progress=None,
) -> tuple[BakeTile, bytes, bytes]:
    """Height, water and buildability for one square of ground.

    Returns the tile metadata, the heightfield, and one byte per sample of
    flags. Water and buildability are read from the bitmaps already baked into
    the .trn rather than derived from the height, because those bitmaps are what
    the game itself consults.
    """
    # An odd sample count puts one sample exactly on the centre, which is the
    # waypoint the user typed -- the thing they most want to be right. The
    # covered span is then derived from the samples rather than the request, so
    # the tile is not quietly 4 m narrower than its own metadata claims.
    samples = round(span / spacing) + 1
    if samples % 2 == 0:
        samples += 1
    span = (samples - 1) * spacing
    origin_x = centre_x - span / 2
    origin_z = centre_z - span / 2

    heights = bytearray()
    flags = bytearray()
    lowest = math.inf
    highest = -math.inf

    for row in range(samples):
        world_z = origin_z + row * spacing
        for col in range(samples):
            world_x = origin_x + col * spacing
            height = terrain.height(world_x, world_z)
            lowest = min(lowest, height)
            highest = max(highest, height)

            decimetres = round(height * 10)
            if abs(decimetres) > _INT16_LIMIT_DM:
                raise ValueError(
                    f"height {height:.1f} m at ({world_x:.0f}, {world_z:.0f}) does not fit "
                    "in int16 decimetres; the bake format needs widening"
                )
            heights += struct.pack("<h", decimetres)

            bit = 0
            if terrain.baked is not None:
                if terrain.bakedBit("water", world_x, world_z):
                    bit |= 0x01
                if terrain.bakedBit("slope", world_x, world_z):
                    bit |= 0x02
            flags.append(bit)
        if progress:
            progress(row + 1, samples)

    tile = BakeTile(
        planet=planet,
        centre_x=centre_x,
        centre_z=centre_z,
        span=span,
        spacing=spacing,
        samples=samples,
        min_height=lowest,
        max_height=highest,
    )
    return tile, bytes(heights), bytes(flags)


def write_tile(out_dir: Path, tile: BakeTile, heights: bytes, flags: bytes) -> Path:
    """Write the tile beside a sidecar naming its own world position.

    Named by planet and rounded centre so a site baked twice overwrites itself
    instead of accumulating near-duplicates.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{tile.planet}_{round(tile.centre_x)}_{round(tile.centre_z)}"
    (out_dir / f"{stem}.height").write_bytes(heights)
    (out_dir / f"{stem}.flags").write_bytes(flags)
    meta = tile.to_json()
    meta["height"] = f"{stem}.height"
    meta["flags"] = f"{stem}.flags"
    path = out_dir / f"{stem}.json"
    path.write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")
    return path
