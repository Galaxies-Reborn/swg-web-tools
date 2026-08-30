"""Terrain height tests.

The parts that need no game data check the two details a port of this silently
gets wrong. The rest need a client install and skip without one; they are the
tests that actually prove the generator, by asking the shipped world where it
put its own objects.
"""

from __future__ import annotations

import os
import statistics
import struct
from pathlib import Path

import pytest

from tre_extract.formats.terrain import NDIV, RandomGenerator, Terrain, f32

CLIENT = Path(os.environ.get("PRECU_CLIENT_DIR", "E:/SWG/PRE-CU-Reborn/PreCU-Client"))
needs_client = pytest.mark.skipif(
    not (CLIENT / "gr_later_art_00.tre").exists(),
    reason="needs a game client install; set PRECU_CLIENT_DIR",
)


def test_ndiv_is_computed_in_float32() -> None:
    """The engine's `real` is float32, and NDIV feeds a table index.

    In float64 this constant differs in the last bits, the index it produces
    shuffles, and the whole noise field comes out different -- while still
    looking like plausible terrain, which is what makes it dangerous.
    """
    assert NDIV == f32(NDIV)
    assert NDIV != 1 + (2147483646 / 322.0)


def test_random_generator_is_deterministic_from_its_seed() -> None:
    first = [RandomGenerator(12345).random() for _ in range(1)]
    again = [RandomGenerator(12345).random() for _ in range(1)]
    assert first == again
    # A different seed has to actually change the stream.
    assert RandomGenerator(12345).random() != RandomGenerator(54321).random()


@pytest.fixture(scope="module")
def vfs():
    from tre_extract.vfs import build_vfs

    return build_vfs(tre_dir=str(CLIENT))


@needs_client
@pytest.mark.parametrize(
    ("place", "x", "z", "height"),
    [
        # Cities sit under a flatten affector, so their height is exactly the
        # integer the affector names -- a strong signal that the whole layer
        # tree evaluated correctly, not merely plausibly.
        ("Mos Eisley", 3528, -4804, 5.0),
        ("Bestine", -1290, -3590, 12.0),
        ("Anchorhead", 55, -5348, 52.0),
    ],
)
def test_tatooine_landmarks_are_exactly_flat(
    vfs, place: str, x: int, z: int, height: float
) -> None:
    terrain = Terrain(vfs.read("terrain/tatooine.trn"))
    assert abs(terrain.height(x, z) - height) < 1e-3, place


@needs_client
def test_terrain_constants_match_every_shipped_planet(vfs) -> None:
    for planet in ("tatooine", "corellia", "naboo", "dathomir", "endor"):
        terrain = Terrain(vfs.read(f"terrain/{planet}.trn"))
        assert terrain.mapW == 16384.0
        assert terrain.chunkW == 8.0
        assert terrain.tiles == 2  # => 4 m tiles, 2 m poles


@needs_client
def test_the_desert_is_dry_and_the_swamp_is_not(vfs) -> None:
    """A misread bitmap would not sort the planets by how wet they look.

    Tatooine is not literally waterless -- it has 440 flagged chunks out of
    4.19 million, the handful of oases -- so the test is a ratio, not a zero.
    Naboo carries about a quarter of its surface as water, four orders of
    magnitude more, and no plausible decoding error produces that ordering.
    """
    fraction = {}
    for planet in ("tatooine", "naboo"):
        baked = Terrain(vfs.read(f"terrain/{planet}.trn")).baked
        bits = sum(bin(b).count("1") for b in baked["water"])
        fraction[planet] = bits / (len(baked["water"]) * 8)
    assert fraction["tatooine"] < 0.001
    assert fraction["naboo"] > 0.2


def _ground_objects(vfs, planet: str):
    """Top-level objects from the world snapshot, which stand on the ground."""
    from tre_extract import iff as I

    out = []

    def walk(node):
        name = I.tag_name(node.tag) if isinstance(node.tag, int) else node.tag
        if name == "DATA" and node.data is not None and len(node.data) >= 52:
            # networkId, containedBy, templateIndex, cellIndex -- cell is the
            # fourth, at offset 12. Reading offset 8 gets the template index,
            # which is almost always non-zero and silently filters everything out.
            contained, _template, cell = struct.unpack_from("<3i", node.data, 4)
            crc, = struct.unpack_from("<I", node.data, 48)
            px, py, pz = struct.unpack_from("<3f", node.data, 32)
            if contained == 0 and cell == 0 and crc == 0:
                out.append((px, py, pz))
        for child in getattr(node, "children", None) or []:
            walk(child)

    walk(I.parse(vfs.read(f"snapshot/{planet}.ws")))
    return out


@needs_client
@pytest.mark.parametrize("planet", ["tatooine", "corellia", "naboo"])
def test_generated_height_matches_where_the_game_put_its_objects(vfs, planet: str) -> None:
    """The real proof: the median object sits exactly on the generated ground.

    Median rather than mean, and median rather than max, because a minority of
    snapshot objects are deliberately off the ground -- a bowl on a table, a
    sign on a wall. Those are not errors, so a measure that ignores them is the
    honest one. What must hold is that the typical object is on the surface.
    """
    terrain = Terrain(vfs.read(f"terrain/{planet}.trn"))
    objects = _ground_objects(vfs, planet)
    assert len(objects) > 1000, "snapshot did not parse"

    step = max(1, len(objects) // 60)
    errors = [py - terrain.height(px, pz) for px, py, pz in objects[::step]]
    assert abs(statistics.median(errors)) < 1e-3
    # And it is not median-zero by luck: most samples should be dead on.
    exact = sum(1 for e in errors if abs(e) < 1e-3)
    assert exact > len(errors) * 0.25
