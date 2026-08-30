"""Collision extents: the shapes, and the two ways of reading them wrongly."""

from __future__ import annotations

import struct

from tre_extract.formats.extent import read_extent
from tre_extract.iff import IffNode, tag


def form(name: str, *children: IffNode) -> IffNode:
    return IffNode(tag=tag(name), is_form=True, children=list(children))


def chunk(name: str, payload: bytes) -> IffNode:
    return IffNode(tag=tag(name), is_form=False, data=payload)


def test_a_box_is_read_max_first() -> None:
    """BoxExtent writes MAX before MIN.

    Reading them the other way round gives an inside-out box: every min is
    above its max, so the overlap test never fires and the collider silently
    stops existing.
    """
    payload = struct.pack("<6f", 3.0, 12.0, 3.0, -3.0, -2.0, -3.0)
    node = form("EXBX", form("0001", form("EXSP"), chunk("BOX ", payload)))
    extent = read_extent(node)
    assert extent is not None
    assert extent.min_x == -3.0 and extent.max_x == 3.0
    assert extent.height == 14.0
    assert extent.max_y > extent.min_y, "an inside-out box collides with nothing"


def test_a_box_is_not_confused_with_the_sphere_beside_it() -> None:
    """An EXBX holds a sphere too, and the sphere comes first.

    Taking the first payload found reads the sphere's centre and radius as if
    they were a box -- four floats where six are wanted -- and produces a
    plausible-looking volume that is not the collider.
    """
    sphere = chunk("SPHR", struct.pack("<4f", 0.0, 0.0, 0.0, 99.0))
    box = chunk("BOX ", struct.pack("<6f", 1.0, 1.0, 1.0, -1.0, -1.0, -1.0))
    node = form("EXBX", form("0001", form("EXSP", sphere), box))
    extent = read_extent(node)
    assert extent is not None
    assert extent.half_x == 1.0, "read the BOX chunk, not the sphere"


def test_a_cylinder_is_base_then_radius_then_height() -> None:
    """CylinderExtent reads a base vector, a radius, then a height.

    Swapping the last two turns a tall thin pillar into a wide flat disc, which
    still looks like a reasonable collider and is the wrong one.
    """
    node = form("XCYL", form("0000", chunk("CYLN", struct.pack("<5f", 0.0, 0.0, 0.0, 2.0, 10.0))))
    extent = read_extent(node)
    assert extent is not None
    assert extent.half_x == 2.0, "radius is the fourth float"
    assert extent.height == 10.0, "height is the fifth"


def test_a_sphere_becomes_the_box_that_contains_it() -> None:
    node = form("EXSP", form("0001", chunk("SPHR", struct.pack("<4f", 1.0, 2.0, 3.0, 5.0))))
    extent = read_extent(node)
    assert extent is not None
    assert (extent.min_x, extent.max_x) == (-4.0, 6.0)
    assert extent.height == 10.0


def test_null_means_use_the_render_bounds() -> None:
    """Most objects have NULL here, and that is an answer rather than a gap."""
    assert read_extent(form("NULL")) is None
