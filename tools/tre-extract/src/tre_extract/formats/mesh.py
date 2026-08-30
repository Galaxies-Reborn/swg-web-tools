"""Static mesh (``.msh``) reader.

Structure, from MeshAppearanceTemplate + ShaderPrimitiveSetTemplate::

    FORM MESH
      FORM 0002..0005
        FORM APPR ...            bounding volumes, hardpoints, floor — skipped
        FORM SPS
          FORM 0000|0001
            CHUNK CNT   int32 shaderCount
            FORM <n>                          one per shader
              CHUNK NAME  "shader/foo.sht"    (or an inline shader template)
              CHUNK INFO  int32 primitiveCount
              FORM 0000|0001                  one per primitive
                CHUNK INFO  int32 primitiveType, bool hasIndices, bool hasSorted
                FORM VTXA ...
                CHUNK INDX  int32 count, u16 x count
                CHUNK SIDX  direction-sorted index sets — ignored

The direction-sorted index buffers exist so the fixed-function pipeline could
draw alpha-blended geometry back-to-front without sorting at runtime. They are
duplicates of INDX and are skipped.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..iff import IffError, IffNode, parse
from .vertex import VertexData, read_index_buffer, read_vertex_buffer

# ShaderPrimitiveSetPrimitiveType, in declaration order.
SPSPT_POINT_LIST = 0
SPSPT_LINE_LIST = 1
SPSPT_LINE_STRIP = 2
SPSPT_TRIANGLE_LIST = 3
SPSPT_TRIANGLE_STRIP = 4
SPSPT_TRIANGLE_FAN = 5
SPSPT_INDEXED_POINT_LIST = 6
SPSPT_INDEXED_LINE_LIST = 7
SPSPT_INDEXED_LINE_STRIP = 8
SPSPT_INDEXED_TRIANGLE_LIST = 9
SPSPT_INDEXED_TRIANGLE_STRIP = 10
SPSPT_INDEXED_TRIANGLE_FAN = 11

_TRIANGLE_TYPES = {
    SPSPT_TRIANGLE_LIST,
    SPSPT_TRIANGLE_STRIP,
    SPSPT_TRIANGLE_FAN,
    SPSPT_INDEXED_TRIANGLE_LIST,
    SPSPT_INDEXED_TRIANGLE_STRIP,
    SPSPT_INDEXED_TRIANGLE_FAN,
}


@dataclass(slots=True)
class Primitive:
    shader: str
    vertices: VertexData
    #: Triangle list, (m, 3) uint32. Strips and fans are converted on read.
    triangles: np.ndarray

    @property
    def triangle_count(self) -> int:
        return int(self.triangles.shape[0])


@dataclass(slots=True)
class StaticMesh:
    name: str
    primitives: list[Primitive] = field(default_factory=list)

    @property
    def triangle_count(self) -> int:
        return sum(p.triangle_count for p in self.primitives)

    @property
    def vertex_count(self) -> int:
        return sum(p.vertices.count for p in self.primitives)

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        if not self.primitives:
            zero = np.zeros(3, np.float32)
            return zero, zero.copy()
        lo = np.full(3, np.inf, np.float32)
        hi = np.full(3, -np.inf, np.float32)
        for prim in self.primitives:
            if prim.vertices.count == 0:
                continue
            lo = np.minimum(lo, prim.vertices.positions.min(axis=0))
            hi = np.maximum(hi, prim.vertices.positions.max(axis=0))
        if not np.isfinite(lo).all():
            zero = np.zeros(3, np.float32)
            return zero, zero.copy()
        return lo, hi


def read_mesh(data: bytes, name: str = "") -> StaticMesh:
    root = parse(data)
    if root.name.strip() != "MESH":
        raise IffError(f"{name or 'asset'} is {root.name}, not MESH")
    version = _newest_version_form(root)
    if version is None:
        raise IffError(f"{name or 'asset'} MESH has no versioned form")
    sps = version.find("SPS")
    if sps is None:
        raise IffError(f"{name or 'asset'} MESH {version.name} has no SPS form")
    mesh = StaticMesh(name=name)
    mesh.primitives.extend(_read_sps(sps))
    return mesh


def _newest_version_form(node: IffNode) -> IffNode | None:
    """Pick the highest-numbered ``NNNN`` child form.

    A handful of shipped meshes carry two version forms — an old one kept for
    a legacy tool alongside the current export. The engine reads whichever the
    IFF cursor lands on first; taking the newest gives the same geometry with
    the richer vertex format.
    """
    candidates = [c for c in node.children if c.is_form and c.name.strip().isdigit()]
    if not candidates:
        return None
    return max(candidates, key=lambda c: int(c.name.strip()))


def _read_sps(sps: IffNode) -> list[Primitive]:
    version = _newest_version_form(sps)
    if version is None:
        raise IffError("SPS has no versioned form")
    count_node = version.find("CNT")
    if count_node is None:
        raise IffError("SPS has no CNT chunk")
    shader_count = count_node.reader().i32()

    # Shader groups are the unnamed forms after CNT; their tag is the group
    # index rendered as ASCII, so match by position rather than by name.
    groups = [c for c in version.children if c.is_form]
    if len(groups) < shader_count:
        raise IffError(f"SPS declares {shader_count} shaders but has {len(groups)} groups")

    primitives: list[Primitive] = []
    for group in groups[:shader_count]:
        shader = _read_shader_reference(group)
        info = group.find("INFO")
        primitive_count = info.reader().i32() if info else 0
        prim_forms = [c for c in group.children if c.is_form]
        for prim in prim_forms[:primitive_count]:
            decoded = _read_primitive(prim, shader)
            if decoded is not None:
                primitives.append(decoded)
    return primitives


def _read_shader_reference(group: IffNode) -> str:
    """The shader is either a NAME chunk or an inline shader template form."""
    name_node = group.find("NAME")
    if name_node is not None:
        return name_node.reader().cstring()
    # An inline template still carries its own NAME somewhere below; take the
    # first one so the material at least resolves to the right textures.
    for node in group.walk():
        if node.name == "NAME" and not node.is_form:
            return node.reader().cstring()
    return ""


def _read_primitive(form: IffNode, shader: str) -> Primitive | None:
    version = form.name.strip()
    info_node = form.find("INFO")
    if info_node is None:
        return None
    info = info_node.reader()

    if version == "0000":
        # The unversioned/old layout has no primitive-type field: it is always
        # an indexed triangle list.
        primitive_type = SPSPT_INDEXED_TRIANGLE_LIST
        has_indices = True
        has_sorted = False
    else:
        primitive_type = info.i32()
        has_indices = info.bool8()
        has_sorted = info.bool8()
    del has_sorted  # SIDX buffers duplicate INDX; nothing to do with them.

    vtxa = form.find("VTXA")
    if vtxa is None:
        return None
    vertices = read_vertex_buffer(vtxa)

    indices: np.ndarray
    indx = form.find("INDX")
    if has_indices and indx is not None:
        indices = read_index_buffer(indx.reader())
    else:
        indices = np.arange(vertices.count, dtype=np.uint32)

    triangles = _to_triangles(primitive_type, indices)
    if triangles is None:
        return None
    return Primitive(shader=shader, vertices=vertices, triangles=triangles)


def _to_triangles(primitive_type: int, indices: np.ndarray) -> np.ndarray | None:
    """Normalise every triangle topology to a plain list; drop points/lines."""
    if primitive_type not in _TRIANGLE_TYPES:
        return None

    if primitive_type in (SPSPT_TRIANGLE_LIST, SPSPT_INDEXED_TRIANGLE_LIST):
        usable = (indices.size // 3) * 3
        return indices[:usable].reshape(-1, 3)

    if primitive_type in (SPSPT_TRIANGLE_STRIP, SPSPT_INDEXED_TRIANGLE_STRIP):
        if indices.size < 3:
            return np.zeros((0, 3), np.uint32)
        a, b, c = indices[:-2], indices[1:-1], indices[2:]
        tris = np.stack([a, b, c], axis=1)
        # Every other triangle in a strip has reversed winding.
        odd = np.arange(tris.shape[0]) % 2 == 1
        tris[odd] = tris[odd][:, [0, 2, 1]]
        # Degenerate triangles are the standard way strips stitch together.
        keep = (tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 0] != tris[:, 2])
        return tris[keep]

    # Fan
    if indices.size < 3:
        return np.zeros((0, 3), np.uint32)
    hub = np.full(indices.size - 2, indices[0], dtype=np.uint32)
    return np.stack([hub, indices[1:-1], indices[2:]], axis=1)
