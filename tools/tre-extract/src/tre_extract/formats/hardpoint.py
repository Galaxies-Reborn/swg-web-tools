"""Hardpoints: the named attachment points an appearance carries.

A hardpoint is how SWG hangs one object off another — a weapon on a ship's
wing, an exhaust flare behind a booster, a droid in an astromech socket. The
engine looks them up by name, so the name is the contract: ``muzzle1`` on a
weapon appearance is where its bolts spawn, ``wing1`` on the X-wing body is
where the wing assembly goes.

They live in the ``APPR`` form that :class:`AppearanceTemplate` reads, which is
embedded in the appearance file rather than being a file of its own — so the
same parsing serves ``.msh``, ``.lod``, ``.cmp`` and ``.mgn`` alike. The form
is optional and frequently absent: an exporter that found no hardpoints wrote
no form at all rather than an empty one.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from ..iff import IffNode, parse

#: 12 floats: `matrix[y][x]` for y in 0..2, x in 0..3 — a 3x4 affine matrix
#: with translation in the last column. Column-vector convention: the engine's
#: `rotate_l2p` computes `matrix[0][0]*x + matrix[0][1]*y + matrix[0][2]*z`,
#: so a point transforms as `v' = M*v + t`, not `v*M`.
_TRANSFORM = struct.Struct("<12f")


@dataclass(slots=True)
class Hardpoint:
    """One named attachment point, in the appearance's own space."""

    name: str
    #: Rotation basis, three rows of three.
    rotation: tuple[
        tuple[float, float, float],
        tuple[float, float, float],
        tuple[float, float, float],
    ]
    translation: tuple[float, float, float]

    def mirrored_z(self) -> Hardpoint:
        """The same point with Z negated, matching the geometry conversion.

        Geometry is mirrored through the XY plane on export, so a hardpoint
        that is not mirrored with it ends up on the wrong side of the model —
        and an unmirrored *rotation* points an attachment backwards even when
        its position looks right.

        Mirroring a transform is not the same as negating its translation: for
        a reflection S, the transform becomes ``S * M * S``, which flips the
        off-diagonal terms that couple Z to X and Y while leaving ``m[2][2]``
        alone.
        """
        r = self.rotation
        flipped = (
            (r[0][0], r[0][1], -r[0][2]),
            (r[1][0], r[1][1], -r[1][2]),
            (-r[2][0], -r[2][1], r[2][2]),
        )
        return Hardpoint(
            name=self.name,
            rotation=flipped,
            translation=(self.translation[0], self.translation[1], -self.translation[2]),
        )


def read_hardpoints(data: bytes, path: str = "") -> list[Hardpoint]:
    """Every hardpoint in an appearance file, in file order.

    Returns an empty list for a file that has none, which is the common case
    and not an error.
    """
    if b"HPTS" not in data:
        # A cheap reject, but a narrow one. The exporter writes the APPR/HPTS
        # form into essentially every .msh, .lod and .cmp whether or not it
        # holds any points, so this only skips the mesh types that never carry
        # hardpoints at all -- .mgn, .lmg, .apt, .sat. It is not the "most
        # appearances" filter it looks like.
        return []
    try:
        root = parse(data)
    except Exception:
        return []
    return hardpoints_in(root)


def hardpoints_in(root: IffNode) -> list[Hardpoint]:
    """Collect hardpoints from an already-parsed tree.

    Searched by walking rather than by a fixed path. `APPR` is nested at
    different depths in different appearance types, and a `.lod` carries one
    per detail level, so following a single path would find some files' points
    and miss others'.
    """
    found: list[Hardpoint] = []
    for node in root.walk():
        if node.name != "HPTS":
            continue
        for child in node.children:
            if child.name != "HPNT" or len(child.data) < _TRANSFORM.size:
                continue
            m = _TRANSFORM.unpack_from(child.data, 0)
            raw_name = child.data[_TRANSFORM.size :].split(b"\0", 1)[0]
            name = raw_name.decode("latin-1").strip()
            if not name:
                continue
            found.append(
                Hardpoint(
                    name=name,
                    rotation=((m[0], m[1], m[2]), (m[4], m[5], m[6]), (m[8], m[9], m[10])),
                    translation=(m[3], m[7], m[11]),
                )
            )
    return found


def dedupe(hardpoints: list[Hardpoint]) -> list[Hardpoint]:
    """First definition of each name wins.

    Duplicates arise because hardpoints are collected from every file in an
    appearance's resolution chain, so a point declared on both a `.lod` and the
    mesh beneath it is seen twice. The first is the outermost, which is the one
    an attachment should hang from.

    This does collapse two genuinely different points that happen to share a
    name. Nothing in the shipped corpus does that, but the possibility is real
    rather than excluded by the format.
    """
    seen: set[str] = set()
    unique: list[Hardpoint] = []
    for point in hardpoints:
        key = point.name.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(point)
    return unique
