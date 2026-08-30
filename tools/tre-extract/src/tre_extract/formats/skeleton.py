"""Skeleton (``.skt``) reader.

A skinned mesh names its bones but not their hierarchy or rest pose; those live
in a skeleton file. Without one, the joint indices in a `.mgn` are just
numbers, and the exported model cannot be rigged — only frozen in bind pose.

Layout (``SLOD`` → one or more ``SKTM`` → ``0002``)::

    INFO   u32 boneCount
    NAME   NUL-separated bone names
    PRNT   boneCount x i32   parent index, -1 for a root
    RPRE   boneCount x 4 f32 pre-rotation quaternion
    RPST   boneCount x 4 f32 post-rotation quaternion
    BPTR   boneCount x 3 f32 bind-pose translation
    BPRO   boneCount x 4 f32 bind-pose rotation quaternion
    JROR   boneCount x i32   joint rotation order

`SLOD` holds several detail levels; the first is the finest.

Quaternions are stored **w, x, y, z**. glTF wants x, y, z, w. Feeding one to
the other reads the real w as x and rotates every joint into nonsense.

The rest pose is **not** ``BPRO`` alone. Skeleton.cpp composes a joint as::

    animatedRotation = animationRotation * bindPoseRotation
    localToParent    = postMultiply * (animatedRotation * preMultiply)
    translation      = bindPoseTranslation + animationTranslation

so with nothing playing, the rest rotation is ``RPST * BPRO * RPRE``. Using
``BPRO`` alone still yields a self-consistent bind pose — the inverse bind
matrices cancel it — which is why that error stays invisible until an
animation is applied, and then rotates the entire model.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

from ..iff import IffError, IffNode, parse


def quat_multiply(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> tuple[float, float, float, float]:
    """Hamilton product of glTF-ordered quaternions: apply ``b``, then ``a``."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


@dataclass(slots=True)
class Bone:
    name: str
    parent: int
    #: Rest translation relative to the parent, in metres.
    translation: tuple[float, float, float]
    #: Bind-pose rotation (``BPRO``). Animation rotations are relative to this.
    bind_rotation: tuple[float, float, float, float]
    pre_rotation: tuple[float, float, float, float]
    post_rotation: tuple[float, float, float, float]

    @property
    def rotation(self) -> tuple[float, float, float, float]:
        """Rest local rotation: ``post * bind * pre``, as the engine composes it."""
        return quat_multiply(
            self.post_rotation, quat_multiply(self.bind_rotation, self.pre_rotation)
        )


@dataclass(slots=True)
class Skeleton:
    name: str
    bones: list[Bone] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.bones)

    def index_of(self, bone_name: str) -> int | None:
        for index, bone in enumerate(self.bones):
            if bone.name == bone_name:
                return index
        return None

    @property
    def roots(self) -> list[int]:
        return [i for i, bone in enumerate(self.bones) if bone.parent < 0]

    def world_matrices(self) -> np.ndarray:
        """Rest-pose world matrix per bone, (n, 4, 4) row-major.

        Needed for glTF's inverse bind matrices, which map a vertex from model
        space into each joint's local space.
        """
        out = np.zeros((len(self.bones), 4, 4), dtype=np.float64)
        for index, bone in enumerate(self.bones):
            local = _compose(bone.translation, bone.rotation)
            if bone.parent < 0:
                out[index] = local
            else:
                # Parents always precede their children in these files, so a
                # single forward pass is enough.
                out[index] = out[bone.parent] @ local
        return out

    def inverse_bind_matrices(self) -> np.ndarray:
        return np.linalg.inv(self.world_matrices())


def read_skeleton(data: bytes, name: str = "") -> Skeleton:
    root = parse(data)
    tag = root.name.strip()

    if tag == "SLOD":
        # Several detail levels; the first is the finest.
        version = root.children[0] if root.children else None
        sktm = next((c for c in (version.children if version else []) if c.is_form), None)
        if sktm is None:
            raise IffError(f"{name or 'skeleton'} SLOD has no SKTM")
        body = next((c for c in sktm.children if c.is_form), None)
    elif tag == "SKTM":
        body = next((c for c in root.children if c.is_form), None)
    else:
        raise IffError(f"{name or 'skeleton'} is {tag}, not SLOD or SKTM")

    if body is None:
        raise IffError(f"{name or 'skeleton'} has no versioned form")

    info = body.find("INFO")
    if info is None or len(info.data) < 4:
        raise IffError(f"{name or 'skeleton'} has no INFO chunk")
    (count,) = struct.unpack_from("<I", info.data, 0)
    if count == 0:
        return Skeleton(name=name)

    names = _names(body.find("NAME"), count)
    parents = _ints(body.find("PRNT"), count)
    pre = _quats(body.find("RPRE"), count)
    post = _quats(body.find("RPST"), count)
    translations = _vec3(body.find("BPTR"), count)
    rotations = _quats(body.find("BPRO"), count)

    identity = (0.0, 0.0, 0.0, 1.0)
    skeleton = Skeleton(name=name)
    for i in range(count):
        skeleton.bones.append(
            Bone(
                name=names[i] if i < len(names) else f"bone{i}",
                parent=parents[i] if i < len(parents) else -1,
                translation=translations[i] if i < len(translations) else (0.0, 0.0, 0.0),
                bind_rotation=rotations[i] if i < len(rotations) else identity,
                pre_rotation=pre[i] if i < len(pre) else identity,
                post_rotation=post[i] if i < len(post) else identity,
            )
        )
    return skeleton


# --- chunk helpers ---------------------------------------------------------


def _names(node: IffNode | None, count: int) -> list[str]:
    if node is None:
        return []
    parts = [p.decode("latin-1") for p in node.data.split(b"\0")]
    return [p for p in parts if p][:count]


def _ints(node: IffNode | None, count: int) -> list[int]:
    if node is None or len(node.data) < count * 4:
        return []
    return list(struct.unpack_from(f"<{count}i", node.data, 0))


def _vec3(node: IffNode | None, count: int) -> list[tuple[float, float, float]]:
    if node is None or len(node.data) < count * 12:
        return []
    flat = struct.unpack_from(f"<{count * 3}f", node.data, 0)
    return [tuple(flat[i * 3 : i * 3 + 3]) for i in range(count)]  # type: ignore[misc]


def _quats(node: IffNode | None, count: int) -> list[tuple[float, float, float, float]]:
    """Read w,x,y,z quaternions and return them glTF-ordered as x,y,z,w."""
    if node is None or len(node.data) < count * 16:
        return []
    flat = struct.unpack_from(f"<{count * 4}f", node.data, 0)
    out: list[tuple[float, float, float, float]] = []
    for i in range(count):
        w, x, y, z = flat[i * 4 : i * 4 + 4]
        out.append((x, y, z, w))
    return out


def _compose(
    translation: tuple[float, float, float],
    rotation: tuple[float, float, float, float],
) -> np.ndarray:
    """Build a 4x4 from a translation and a glTF-ordered quaternion."""
    x, y, z, w = rotation
    norm = (x * x + y * y + z * z + w * w) ** 0.5
    if norm > 0:
        x, y, z, w = x / norm, y / norm, z / norm, w / norm

    matrix = np.identity(4, dtype=np.float64)
    matrix[0, 0] = 1 - 2 * (y * y + z * z)
    matrix[0, 1] = 2 * (x * y - z * w)
    matrix[0, 2] = 2 * (x * z + y * w)
    matrix[1, 0] = 2 * (x * y + z * w)
    matrix[1, 1] = 1 - 2 * (x * x + z * z)
    matrix[1, 2] = 2 * (y * z - x * w)
    matrix[2, 0] = 2 * (x * z - y * w)
    matrix[2, 1] = 2 * (y * z + x * w)
    matrix[2, 2] = 1 - 2 * (x * x + y * y)
    matrix[0, 3], matrix[1, 3], matrix[2, 3] = translation
    return matrix
