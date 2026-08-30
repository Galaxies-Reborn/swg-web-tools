"""The static world: everything already standing on a planet.

`snapshot/<planet>.ws` is what the client draws when it loads a world -- the
buildings, rocks, wrecks and scenery that are simply there, as distinct from
anything a player put down. For a city planner that makes it the list of things
to build around, and it is the only source for them: nothing in the server's own
tables says a boulder is at a particular place.

Layout, from WorldSnapshotReaderWriter:

    FORM WSNP
      FORM 0001
        FORM NODS
          FORM NODE ... nested, a node's children are the objects inside it
            FORM 0000
              DATA  52 bytes, one object
        CHUNK OTNL   int32 count, then that many NUL-terminated template paths

One object's DATA is four int32 -- network id, containing object, index into
OTNL, cell index -- then a quaternion as w,x,y,z, a position as x,y,z, a
radius, and the portal layout CRC.

Two fields mislead if taken at face value. `radius` is a network update range,
not a footprint: it says when the server starts telling you about the object,
and it is far larger than the object. And `containedBy` being non-zero means the
object is inside something else -- furniture in a building -- so its position is
in that building's space rather than the world's. Only top-level objects have
world coordinates, which is why callers filter on it.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from .. import iff

#: A node's DATA payload. Anything shorter is not an object record.
_RECORD = struct.Struct("<4i8f I")
_RECORD_BYTES = 52


@dataclass(frozen=True)
class SnapshotObject:
    """One thing standing in the world."""

    network_id: int
    contained_by: int
    template: str
    cell: int
    x: float
    y: float
    z: float
    #: Rotation about the vertical axis, in radians, which is all a plan view needs.
    yaw: float
    #: The server's update range. NOT a footprint -- see the module note.
    update_radius: float
    portal_layout_crc: int

    @property
    def is_outdoors(self) -> bool:
        """Standing on the ground, rather than inside something.

        A contained object's position is relative to whatever contains it, so
        mixing the two puts a chair on a hillside a kilometre from its building.
        """
        return self.contained_by == 0 and self.cell == 0


def read(data: bytes) -> list[SnapshotObject]:
    root = iff.parse(data)
    version = root.children[0] if root.children else None
    if version is None:
        return []

    templates = _read_template_names(version)
    objects: list[SnapshotObject] = []

    for node in version.walk():
        if node.name != "DATA" or len(node.data) < _RECORD_BYTES:
            continue
        (
            network_id,
            contained_by,
            template_index,
            cell,
            qw,
            qx,
            qy,
            qz,
            x,
            y,
            z,
            radius,
            portal_crc,
        ) = _RECORD.unpack_from(node.data, 0)

        objects.append(
            SnapshotObject(
                network_id=network_id,
                contained_by=contained_by,
                template=(
                    templates[template_index]
                    if 0 <= template_index < len(templates)
                    else ""
                ),
                cell=cell,
                x=x,
                y=y,
                z=z,
                yaw=_yaw_from(qw, qx, qy, qz),
                update_radius=radius,
                portal_layout_crc=portal_crc,
            )
        )
    return objects


def _read_template_names(version: iff.IffNode) -> list[str]:
    node = version.find("OTNL")
    if node is None:
        return []
    reader = iff.ChunkReader(node.data)
    count = reader.i32()
    names: list[str] = []
    for _ in range(count):
        names.append(reader.cstring())
    return names


def _yaw_from(w: float, x: float, y: float, z: float) -> float:
    """Heading only.

    World objects sit upright, so the useful part of the quaternion is the
    rotation about the vertical axis. Reducing it here keeps the export small
    and spares every consumer a quaternion library.
    """
    import math

    return math.atan2(2.0 * (w * y + x * z), 1.0 - 2.0 * (y * y + z * z))
