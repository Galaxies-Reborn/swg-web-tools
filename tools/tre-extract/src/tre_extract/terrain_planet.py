"""Bake a whole planet's ground, in parallel, into tiles a browser can page in.

A planet is 16,384 m of 8 m chunks: 2048 x 2048 height samples. At roughly 2 ms
a sample that is over two hours in one process, which is why this one fans out
over cores. Each worker rebuilds its own Terrain from the .trn bytes -- the
generator holds parsed layer trees and fractal caches that are not worth
pickling per row, and rebuilding costs a few hundred milliseconds once.

The output is tiled rather than one file. A whole planet at 8 m is 8.4 MB of
int16, which is fine to store and far too much to hand a browser that wants the
square kilometre around one city. Tiles are square, aligned to the sample grid,
and named by tile index so a world coordinate resolves to a filename with
arithmetic instead of an index lookup.

An overview is written alongside: the same planet downsampled, small enough to
draw the entire world at once. It takes the MINIMUM of each block rather than
the average, because the overview's job is showing where the ground is low
enough to be water or flat enough to build, and averaging hides both.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path

from .formats.terrain import Terrain

#: Samples per side of one tile. 256 at 8 m is a 2 km square in 128 KB, which
#: is a comfortable single fetch and means a 900 m city touches at most four.
TILE_SAMPLES = 256

_TERRAIN: Terrain | None = None


def _init_worker(trn_bytes: bytes) -> None:
    global _TERRAIN
    _TERRAIN = Terrain(trn_bytes)


def _bake_row(job: tuple[int, float, float, float, int]) -> tuple[int, bytes, bytes]:
    """One row of samples. Returns raw bytes so the parent does no conversion."""
    row, origin_x, world_z, spacing, count = job
    assert _TERRAIN is not None
    terrain = _TERRAIN
    heights = bytearray()
    flags = bytearray()
    for col in range(count):
        world_x = origin_x + col * spacing
        # Decimetres, not centimetres: tatooine has ground above 345 m and a
        # centimetre int16 stops at 327.67, which silently shaved 17.7 m off its
        # peaks. Decimetres clear every shipped planet by an order of magnitude.
        decimetres = round(terrain.height(world_x, world_z) * 10)
        # Clamp rather than raise: one freak sample must not abandon a bake that
        # has been running for minutes, and anything hitting the rail is visible
        # in the overview anyway.
        decimetres = max(-32768, min(32767, decimetres))
        heights += struct.pack("<h", decimetres)
        bit = 0
        if terrain.baked is not None:
            if terrain.bakedBit("water", world_x, world_z):
                bit |= 0x01
            if terrain.bakedBit("slope", world_x, world_z):
                bit |= 0x02
        flags.append(bit)
    return row, bytes(heights), bytes(flags)


@dataclass(frozen=True)
class PlanetBake:
    planet: str
    map_width: float
    spacing: float
    samples: int
    tile_samples: int
    tiles: int
    min_height: float
    max_height: float

    def to_json(self) -> dict:
        return {
            "planet": self.planet,
            "mapWidth": self.map_width,
            "spacing": self.spacing,
            "samples": self.samples,
            "tileSamples": self.tile_samples,
            "tiles": self.tiles,
            "minHeight": round(self.min_height, 2),
            "maxHeight": round(self.max_height, 2),
            # The world is centred on the origin, so the south-west corner is
            # negative half the map. Stated rather than implied, so a reader
            # does not have to already know that convention.
            "originX": -self.map_width / 2,
            "originZ": -self.map_width / 2,
            "heightUnits": "int16 decimetres, row-major from the south-west corner",
            "tileNaming": "<tileZ>_<tileX>.height and .flags",
        }


def bake_planet(
    trn_bytes: bytes,
    planet: str,
    out_dir: Path,
    spacing: float = 8.0,
    overview_spacing: float = 32.0,
    workers: int | None = None,
    progress=None,
) -> PlanetBake:
    from concurrent.futures import ProcessPoolExecutor

    terrain = Terrain(trn_bytes)
    map_width = terrain.mapW
    samples = round(map_width / spacing)
    origin = -map_width / 2

    rows_height: list[bytes | None] = [None] * samples
    rows_flags: list[bytes | None] = [None] * samples

    jobs = [(row, origin, origin + row * spacing, spacing, samples) for row in range(samples)]

    done = 0
    with ProcessPoolExecutor(
        max_workers=workers, initializer=_init_worker, initargs=(trn_bytes,)
    ) as pool:
        # chunksize matters: a row is a fraction of a second of work, and handing
        # them out one at a time spends more time in IPC than in the generator.
        for row, heights, flags in pool.map(_bake_row, jobs, chunksize=4):
            rows_height[row] = heights
            rows_flags[row] = flags
            done += 1
            if progress:
                progress(done, samples)

    lowest = 32767
    highest = -32768
    for raw in rows_height:
        assert raw is not None
        values = struct.unpack("<" + str(samples) + "h", raw)
        lowest = min(lowest, min(values))
        highest = max(highest, max(values))

    tiles = math.ceil(samples / TILE_SAMPLES)
    planet_dir = out_dir / planet
    planet_dir.mkdir(parents=True, exist_ok=True)

    for tile_z in range(tiles):
        for tile_x in range(tiles):
            height_bytes = bytearray()
            flag_bytes = bytearray()
            for local_row in range(TILE_SAMPLES):
                row = tile_z * TILE_SAMPLES + local_row
                if row >= samples:
                    break
                start = tile_x * TILE_SAMPLES
                stop = min(start + TILE_SAMPLES, samples)
                raw_h = rows_height[row]
                raw_f = rows_flags[row]
                assert raw_h is not None and raw_f is not None
                height_bytes += raw_h[start * 2 : stop * 2]
                flag_bytes += raw_f[start:stop]
            stem = str(tile_z) + "_" + str(tile_x)
            (planet_dir / (stem + ".height")).write_bytes(bytes(height_bytes))
            (planet_dir / (stem + ".flags")).write_bytes(bytes(flag_bytes))

    overview_samples = _write_overview(
        planet_dir, rows_height, rows_flags, samples, spacing, overview_spacing
    )

    bake = PlanetBake(
        planet=planet,
        map_width=map_width,
        spacing=spacing,
        samples=samples,
        tile_samples=TILE_SAMPLES,
        tiles=tiles,
        min_height=lowest / 10,
        max_height=highest / 10,
    )
    meta = bake.to_json()
    meta["overview"] = "overview.height"
    meta["overviewFlags"] = "overview.flags"
    meta["overviewSamples"] = overview_samples
    meta["overviewSpacing"] = overview_spacing
    (planet_dir / "planet.json").write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")
    return bake


def _write_overview(
    planet_dir: Path,
    rows_height: list[bytes | None],
    rows_flags: list[bytes | None],
    samples: int,
    spacing: float,
    overview_spacing: float,
) -> int:
    """Downsample by taking the lowest sample and the union of the flags.

    Minimum, not mean: an overview exists to show where the water and the flat
    ground are, and a mean lifts a river out of its own valley until it
    disappears. The flags are OR'd for the same reason -- a block holding any
    water should read as water at a glance rather than being averaged away.
    """
    step = round(overview_spacing / spacing)
    out = round(samples / step)
    heights = bytearray()
    flags = bytearray()
    for block_z in range(out):
        for block_x in range(out):
            lowest = 32767
            merged = 0
            for dz in range(step):
                row = block_z * step + dz
                if row >= samples:
                    continue
                raw_h = rows_height[row]
                raw_f = rows_flags[row]
                assert raw_h is not None and raw_f is not None
                for dx in range(step):
                    col = block_x * step + dx
                    if col >= samples:
                        continue
                    value = struct.unpack_from("<h", raw_h, col * 2)[0]
                    lowest = min(lowest, value)
                    merged |= raw_f[col]
            heights += struct.pack("<h", lowest)
            flags.append(merged)
    (planet_dir / "overview.height").write_bytes(bytes(heights))
    (planet_dir / "overview.flags").write_bytes(bytes(flags))
    return out
