"""What an object collides with, as opposed to what it looks like.

An appearance's `FORM APPR / FORM 0003` holds two extents in a row. The first
is the render bounding volume -- always an EXBX -- and the second is the
collision extent. They are not the same thing and the second is the one that
stops you walking through a wall.

The collision extent is NOT in the mesh. Every shipped `_l0.msh` has NULL
there; it lives in the `.lod` beside it, and even there most entries are NULL,
in which case the engine falls back to the render bounds. So a caller that has
the render bounds already -- as the manifest does -- gets a usable collider for
most objects without reading anything here, and this fills in the rest.

Six shapes actually appear in shipped data, out of the seven the engine binds:

    EXSP   sphere
    EXBX   axis-aligned box, with a sphere after it
    XCYL   cylinder about the vertical axis
    CMSH   a triangle soup
    CMPT   several extents unioned
    DTAL   one extent per level of detail

The last three are reduced to a box here. A planner draws a plan view and asks
whether two footprints overlap; a triangle soup answers that question more
precisely than a bounding box, but not more precisely than the question
deserves, and carrying the mesh would cost more than the whole rest of the
export. The reduction is always outward -- the box contains the shape -- so the
error is towards refusing a placement that would have squeezed in, never
towards allowing one that would not.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from .. import iff


@dataclass(frozen=True)
class Extent:
    """A collider, reduced to an axis-aligned box and a radius.

    `shape` records what it was before the reduction, so a consumer can tell a
    real box from a collapsed mesh rather than being quietly misled.
    """

    shape: str
    min_x: float
    min_y: float
    min_z: float
    max_x: float
    max_y: float
    max_z: float

    @property
    def half_x(self) -> float:
        return (self.max_x - self.min_x) / 2

    @property
    def half_z(self) -> float:
        return (self.max_z - self.min_z) / 2

    @property
    def height(self) -> float:
        return self.max_y - self.min_y


def _box(shape: str, mn: tuple[float, float, float], mx: tuple[float, float, float]) -> Extent:
    return Extent(shape, mn[0], mn[1], mn[2], mx[0], mx[1], mx[2])


def read_extent(node: iff.IffNode) -> Extent | None:
    """One extent node, or None when it is NULL or a shape we do not model."""
    name = node.name
    if name == "NULL":
        return None

    if name == "EXSP":
        # centre then radius, inside a version form.
        reader = _payload(node)
        if reader is None:
            return None
        cx, cy, cz, r = struct.unpack_from("<4f", reader, 0)
        return _box("sphere", (cx - r, cy - r, cz - r), (cx + r, cy + r, cz + r))

    if name == "EXBX":
        # An EXBX carries a sphere as well, and the sphere comes FIRST. Taking
        # the first payload found gets the sphere's centre and radius and reads
        # them as a box, which is wrong and looks plausible. The box is the
        # chunk named BOX.
        chunk = _named_chunk(node, "BOX ")
        if chunk is None or len(chunk) < 24:
            return None
        # BoxExtent writes MAX before MIN. Reversing them yields an inside-out
        # box whose overlap test silently never fires.
        mx = struct.unpack_from("<3f", chunk, 0)
        mn = struct.unpack_from("<3f", chunk, 12)
        return _box("box", mn, mx)

    if name == "XCYL":
        reader = _payload(node)
        if reader is None or len(reader) < 20:
            return None
        cx, cy, cz, radius, height = struct.unpack_from("<5f", reader, 0)
        return _box(
            "cylinder",
            (cx - radius, cy, cz - radius),
            (cx + radius, cy + height, cz + radius),
        )

    if name == "CMSH":
        # A triangle soup: IDTL holds VERT, and the vertices are the shape.
        # Bounding them is the reduction the module note describes.
        merged = _bounds_of_vertices(node)
        if merged is None:
            return None
        mn, mx = merged
        return _box("mesh", mn, mx)

    if name in ("CMPT", "DTAL"):
        # A union, or one extent per detail level. Either way the outermost
        # bound of the simple extents inside is the honest reduction.
        merged = _bounds_of_children(node)
        if merged is None:
            return None
        mn, mx = merged
        return _box(name.lower(), mn, mx)

    return None


def _named_chunk(node: iff.IffNode, name: str) -> bytes | None:
    """A specific chunk anywhere under this node, by tag."""
    wanted = name.strip()
    for child in node.walk():
        if child.name.strip() == wanted and child.data:
            return child.data
    return None


def _bounds_of_vertices(node: iff.IffNode) -> (
    tuple[tuple[float, float, float], tuple[float, float, float]] | None
):
    """Bounds of an IDTL's vertex list."""
    raw = _named_chunk(node, "VERT")
    if not raw or len(raw) < 12:
        return None
    count = len(raw) // 12
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for i in range(count):
        x, y, z = struct.unpack_from("<3f", raw, i * 12)
        lo[0] = min(lo[0], x)
        hi[0] = max(hi[0], x)
        lo[1] = min(lo[1], y)
        hi[1] = max(hi[1], y)
        lo[2] = min(lo[2], z)
        hi[2] = max(hi[2], z)
    return (lo[0], lo[1], lo[2]), (hi[0], hi[1], hi[2])


def _payload(node: iff.IffNode) -> bytes | None:
    """An extent's numbers, whether it wraps them in a version form or not."""
    if node.data:
        return node.data
    for child in node.children:
        if child.data:
            return child.data
        deeper = _payload(child)
        if deeper is not None:
            return deeper
    return None


def _bounds_of_children(
    node: iff.IffNode,
) -> tuple[tuple[float, float, float], tuple[float, float, float]] | None:
    """Union of every simple extent underneath, for the composite shapes."""
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    found = False
    for child in node.walk():
        if child is node or child.name not in ("EXBX", "EXSP", "XCYL"):
            continue
        inner = read_extent(child)
        if inner is None:
            continue
        found = True
        lo[0] = min(lo[0], inner.min_x)
        lo[1] = min(lo[1], inner.min_y)
        lo[2] = min(lo[2], inner.min_z)
        hi[0] = max(hi[0], inner.max_x)
        hi[1] = max(hi[1], inner.max_y)
        hi[2] = max(hi[2], inner.max_z)
    if not found:
        return None
    return (lo[0], lo[1], lo[2]), (hi[0], hi[1], hi[2])


def collision_extent(appearance_root: iff.IffNode) -> Extent | None:
    """The collision extent of an appearance, or None to use its render bounds.

    APPR's version form lists the render extent first and the collision extent
    second. Taking the first -- which is the obvious mistake, since both are
    usually EXBX -- gives the visual bounds and calls them collision.
    """
    for node in appearance_root.walk():
        if node.name != "APPR" or not node.children:
            continue
        version = node.children[0]
        if len(version.children) < 2:
            return None
        return read_extent(version.children[1])
    return None
