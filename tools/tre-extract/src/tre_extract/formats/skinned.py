"""Skinned mesh (``.mgn``) reader.

Creatures, player bodies, and every wearable are skinned meshes. They are the
bulk of what players actually want to look at, and they are shaped nothing like
the static ``.msh`` format.

Structure (``SKMG`` / ``0004``)::

    INFO   counts
    SKTM   skeleton template path(s)
    XFNM   bone names, NUL-separated
    POSN   vertexCount x 3 f32   positions, already in bind pose
    NORM   normalCount x 3 f32
    TWHD   vertexCount x u32     how many bone weights each vertex has
    TWDT   pairs of (u32 bone, f32 weight), read in TWHD order
    PSDT   one per shader:
      NAME   shader path
      PIDX   u32 count, then count x u32   shader-vertex -> POSN index
      NIDX   count x u32                   shader-vertex -> NORM index
      TXCI   u32 setCount, u32 dimension
      TCSF/TCSD  setCount x count x dimension f32
      PRIM/OITL  u32 count, then per triangle: u16 zone, 3 x u32 shader-vertex

The important difference from a static mesh: attributes are *indexed
separately*. A shader's vertex list references shared position and normal
arrays through PIDX and NIDX, which need not agree — so exporting requires
building a de-indexed vertex per shader vertex. glTF has no equivalent of
separate index streams per attribute.

Positions are stored in bind pose, so a static export needs no skeleton and
still looks correct standing still. Joint indices and weights are read too, so
the exported model carries them for a future animation pass.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

from ..iff import IffError, IffNode, parse

#: Bone influences per vertex that glTF allows in one JOINTS_0/WEIGHTS_0 set.
MAX_INFLUENCES = 4


@dataclass(slots=True)
class SkinnedPrimitive:
    shader: str
    positions: np.ndarray  # (n, 3) float32
    normals: np.ndarray | None  # (n, 3) float32
    uvs: np.ndarray | None  # (n, 2) float32
    triangles: np.ndarray  # (m, 3) uint32
    joints: np.ndarray | None  # (n, 4) uint16
    weights: np.ndarray | None  # (n, 4) float32

    @property
    def triangle_count(self) -> int:
        return int(self.triangles.shape[0])


@dataclass(slots=True)
class SkinnedMesh:
    name: str
    bones: list[str] = field(default_factory=list)
    skeletons: list[str] = field(default_factory=list)
    primitives: list[SkinnedPrimitive] = field(default_factory=list)

    @property
    def triangle_count(self) -> int:
        return sum(p.triangle_count for p in self.primitives)

    @property
    def vertex_count(self) -> int:
        return sum(int(p.positions.shape[0]) for p in self.primitives)

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        if not self.primitives:
            zero = np.zeros(3, np.float32)
            return zero, zero.copy()
        lo = np.full(3, np.inf, np.float32)
        hi = np.full(3, -np.inf, np.float32)
        for prim in self.primitives:
            if prim.positions.size == 0:
                continue
            lo = np.minimum(lo, prim.positions.min(axis=0))
            hi = np.maximum(hi, prim.positions.max(axis=0))
        if not np.isfinite(lo).all():
            zero = np.zeros(3, np.float32)
            return zero, zero.copy()
        return lo, hi


def read_skinned_mesh(data: bytes, name: str = "") -> SkinnedMesh:
    root = parse(data)
    if root.name.strip() != "SKMG":
        raise IffError(f"{name or 'asset'} is {root.name}, not SKMG")

    version = _newest_version_form(root)
    if version is None:
        raise IffError(f"{name or 'asset'} SKMG has no versioned form")

    mesh = SkinnedMesh(name=name)

    skeleton_node = version.find("SKTM")
    if skeleton_node is not None:
        mesh.skeletons = _split_strings(skeleton_node.data)

    bone_node = version.find("XFNM")
    if bone_node is not None:
        mesh.bones = _split_strings(bone_node.data)

    positions = _read_vec3(version.find("POSN"))
    normals = _read_vec3(version.find("NORM"))
    if positions is None:
        raise IffError(f"{name or 'asset'} has no POSN chunk")

    joints, weights = _read_skin_weights(version, positions.shape[0])

    for psdt in version.find_all("PSDT"):
        primitive = _read_psdt(psdt, positions, normals, joints, weights)
        if primitive is not None:
            mesh.primitives.append(primitive)

    return mesh


# --- chunk readers ---------------------------------------------------------


def _newest_version_form(node: IffNode) -> IffNode | None:
    forms = [c for c in node.children if c.is_form and c.name.strip().isdigit()]
    if not forms:
        return node.children[0] if node.children and node.children[0].is_form else None
    return max(forms, key=lambda c: int(c.name.strip()))


def _split_strings(data: bytes) -> list[str]:
    return [part.decode("latin-1") for part in data.split(b"\0") if part]


def _read_vec3(node: IffNode | None) -> np.ndarray | None:
    if node is None or len(node.data) < 12:
        return None
    count = len(node.data) // 12
    return np.frombuffer(node.data, dtype="<f4", count=count * 3).reshape(count, 3).copy()


def _read_skin_weights(
    version: IffNode, vertex_count: int
) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Read TWHD/TWDT into fixed-width glTF joint and weight arrays.

    TWDT is a flat run of (bone, weight) pairs consumed in TWHD order, so the
    per-vertex split is only recoverable by walking both together. Vertices
    with more than four influences keep their four heaviest, renormalised —
    that is what glTF supports in one set, and the discarded influences are
    small by construction.
    """
    head = version.find("TWHD")
    body = version.find("TWDT")
    if head is None or body is None:
        return None, None

    counts = np.frombuffer(head.data, dtype="<u4", count=len(head.data) // 4)
    if counts.size < vertex_count:
        return None, None

    joints = np.zeros((vertex_count, MAX_INFLUENCES), dtype=np.uint16)
    weights = np.zeros((vertex_count, MAX_INFLUENCES), dtype=np.float32)

    offset = 0
    payload = body.data
    for vertex in range(vertex_count):
        influences = int(counts[vertex])
        pairs: list[tuple[int, float]] = []
        for _ in range(influences):
            if offset + 8 > len(payload):
                break
            bone, weight = struct.unpack_from("<If", payload, offset)
            offset += 8
            pairs.append((bone, weight))

        if not pairs:
            # An unweighted vertex is rigid to the root bone rather than
            # floating at the origin.
            weights[vertex, 0] = 1.0
            continue

        pairs.sort(key=lambda p: p[1], reverse=True)
        kept = pairs[:MAX_INFLUENCES]
        total = sum(w for _, w in kept) or 1.0
        for slot, (bone, weight) in enumerate(kept):
            joints[vertex, slot] = bone
            weights[vertex, slot] = weight / total

    return joints, weights


def _read_psdt(
    psdt: IffNode,
    positions: np.ndarray,
    normals: np.ndarray | None,
    joints: np.ndarray | None,
    weights: np.ndarray | None,
) -> SkinnedPrimitive | None:
    name_node = psdt.find("NAME")
    shader = name_node.reader().cstring() if name_node is not None else ""

    pidx_node = psdt.find("PIDX")
    if pidx_node is None or len(pidx_node.data) < 4:
        return None
    # PIDX is length-prefixed; NIDX is not. Reading either the same way loses
    # a vertex or shifts every index by one.
    (vertex_count,) = struct.unpack_from("<I", pidx_node.data, 0)
    if vertex_count == 0 or len(pidx_node.data) < 4 + vertex_count * 4:
        return None
    position_index = np.frombuffer(
        pidx_node.data, dtype="<u4", count=vertex_count, offset=4
    ).astype(np.int64)

    nidx_node = psdt.find("NIDX")
    normal_index = None
    if nidx_node is not None and len(nidx_node.data) >= vertex_count * 4:
        normal_index = np.frombuffer(nidx_node.data, dtype="<u4", count=vertex_count).astype(
            np.int64
        )

    triangles = _read_primitives(psdt, vertex_count)
    if triangles is None or triangles.size == 0:
        return None

    # Guard against an index the shared arrays cannot satisfy; a handful of
    # shipped assets reference past the end.
    if position_index.max(initial=0) >= positions.shape[0]:
        position_index = np.clip(position_index, 0, positions.shape[0] - 1)

    out_positions = positions[position_index]

    out_normals = None
    if normals is not None and normal_index is not None:
        clipped = np.clip(normal_index, 0, normals.shape[0] - 1)
        out_normals = normals[clipped]

    return SkinnedPrimitive(
        shader=shader,
        positions=np.ascontiguousarray(out_positions, dtype=np.float32),
        normals=None if out_normals is None else np.ascontiguousarray(out_normals, np.float32),
        uvs=_read_texcoords(psdt, vertex_count),
        triangles=triangles,
        joints=None if joints is None else np.ascontiguousarray(joints[position_index]),
        weights=None if weights is None else np.ascontiguousarray(weights[position_index]),
    )


def _read_texcoords(psdt: IffNode, vertex_count: int) -> np.ndarray | None:
    txci = psdt.find("TXCI")
    tcsf = psdt.find("TCSF")
    if txci is None or tcsf is None or len(txci.data) < 8:
        return None

    set_count, dimension = struct.unpack_from("<2I", txci.data, 0)
    if set_count == 0 or dimension < 2:
        return None

    data_node = tcsf.find("TCSD")
    if data_node is None:
        return None

    needed = vertex_count * dimension
    if len(data_node.data) < needed * 4:
        return None

    # Only the first set reaches glTF's TEXCOORD_0; the rest drive effects the
    # web viewer does not reproduce.
    coords = np.frombuffer(data_node.data, dtype="<f4", count=needed).reshape(
        vertex_count, dimension
    )
    return np.ascontiguousarray(coords[:, :2], dtype=np.float32)


def _read_primitives(psdt: IffNode, vertex_count: int) -> np.ndarray | None:
    prim = psdt.find("PRIM")
    if prim is None:
        return None

    collected: list[np.ndarray] = []
    for node in prim.children:
        if node.is_form:
            continue
        tag = node.name.strip()
        if tag == "OITL":
            collected.append(_read_oitl(node.data))
        elif tag == "ITL":
            collected.append(_read_itl(node.data))

    if not collected:
        return None

    triangles = np.concatenate([t for t in collected if t.size > 0]) if collected else None
    if triangles is None or triangles.size == 0:
        return None

    # Drop anything referencing a vertex this shader does not have.
    valid = (triangles < vertex_count).all(axis=1)
    return np.ascontiguousarray(triangles[valid], dtype=np.uint32)


def _read_oitl(data: bytes) -> np.ndarray:
    """Occlusion-zoned triangle list: u32 count, then u16 zone + 3 x u32."""
    if len(data) < 4:
        return np.zeros((0, 3), np.uint32)
    (count,) = struct.unpack_from("<I", data, 0)
    stride = 14
    if count == 0 or len(data) < 4 + count * stride:
        count = max(0, (len(data) - 4) // stride)
    if count == 0:
        return np.zeros((0, 3), np.uint32)

    raw = np.frombuffer(data, dtype=np.uint8, count=count * stride, offset=4).reshape(count, stride)
    # The zone id in the first two bytes selects which occlusion zone hides the
    # triangle; the viewer draws everything, so only the indices matter.
    return raw[:, 2:].copy().view("<u4").reshape(count, 3)


def _read_itl(data: bytes) -> np.ndarray:
    """Plain indexed triangle list: u32 count, then 3 x u32 per triangle."""
    if len(data) < 4:
        return np.zeros((0, 3), np.uint32)
    (count,) = struct.unpack_from("<I", data, 0)
    if count == 0 or len(data) < 4 + count * 12:
        count = max(0, (len(data) - 4) // 12)
    if count == 0:
        return np.zeros((0, 3), np.uint32)
    return (
        np.frombuffer(data, dtype="<u4", count=count * 3, offset=4).reshape(count, 3).copy()
    )
