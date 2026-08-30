"""Vertex buffer decoding.

The buffer's layout is derived entirely from a 32-bit flags word, exactly as
``SystemVertexBuffer`` builds its descriptor:

    position          3 x f32   (always present in practice)
    ooz               1 x f32   when "transformed"
    normal            3 x f32
    pointSize         1 x f32
    color0            u32 BGRA
    color1            u32 BGRA
    texcoord[i]       dim(i) x f32, for each declared set

Two details bite: point size is written into the stream but was never given a
descriptor offset by the engine, and texture coordinate *dimension* is a
per-set 2-bit field, so a set can carry 1, 2, 3, or 4 floats. Assuming 2
silently shears the UVs of any asset that uses 3D coordinates.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

from ..iff import ChunkReader, IffError, IffNode

F_POSITION = 0x0001
F_TRANSFORMED = 0x0002
F_NORMAL = 0x0004
F_COLOR0 = 0x0008
F_COLOR1 = 0x0010
F_POINT_SIZE = 0x0020

TEXCOORD_COUNT_SHIFT = 8
TEXCOORD_COUNT_MASK = 0b1111
TEXCOORD_DIM_BASE_SHIFT = 12
TEXCOORD_DIM_PER_SET_SHIFT = 2
TEXCOORD_DIM_MASK = 0b11
TEXCOORD_DIM_ADJUST = 1

MAX_TEXCOORD_SETS = 8


@dataclass(frozen=True, slots=True)
class VertexFormat:
    flags: int

    @property
    def has_position(self) -> bool:
        return bool(self.flags & F_POSITION)

    @property
    def is_transformed(self) -> bool:
        return bool(self.flags & F_TRANSFORMED)

    @property
    def has_normal(self) -> bool:
        return bool(self.flags & F_NORMAL)

    @property
    def has_point_size(self) -> bool:
        return bool(self.flags & F_POINT_SIZE)

    @property
    def has_color0(self) -> bool:
        return bool(self.flags & F_COLOR0)

    @property
    def has_color1(self) -> bool:
        return bool(self.flags & F_COLOR1)

    @property
    def texcoord_sets(self) -> int:
        return (self.flags >> TEXCOORD_COUNT_SHIFT) & TEXCOORD_COUNT_MASK

    def texcoord_dim(self, index: int) -> int:
        shift = TEXCOORD_DIM_BASE_SHIFT + index * TEXCOORD_DIM_PER_SET_SHIFT
        return ((self.flags >> shift) & TEXCOORD_DIM_MASK) + TEXCOORD_DIM_ADJUST

    @property
    def stride(self) -> int:
        size = 0
        if self.has_position:
            size += 12
        if self.is_transformed:
            size += 4
        if self.has_normal:
            size += 12
        if self.has_point_size:
            size += 4
        if self.has_color0:
            size += 4
        if self.has_color1:
            size += 4
        for i in range(self.texcoord_sets):
            size += 4 * self.texcoord_dim(i)
        return size

    def describe(self) -> str:
        parts = []
        if self.has_position:
            parts.append("pos")
        if self.has_normal:
            parts.append("nrm")
        if self.has_color0:
            parts.append("col0")
        if self.has_color1:
            parts.append("col1")
        for i in range(self.texcoord_sets):
            parts.append(f"uv{i}:{self.texcoord_dim(i)}d")
        return "+".join(parts) or "empty"


@dataclass(slots=True)
class VertexData:
    format: VertexFormat
    positions: np.ndarray  # (n, 3) float32
    normals: np.ndarray | None  # (n, 3) float32
    colors: np.ndarray | None  # (n, 4) float32, linear RGBA
    # One entry per declared set; each is (n, dim) float32.
    texcoords: list[np.ndarray]

    @property
    def count(self) -> int:
        return int(self.positions.shape[0])

    def uv_set(self, index: int = 0) -> np.ndarray | None:
        """The first two components of a set, as glTF wants them."""
        if index >= len(self.texcoords):
            return None
        uv = self.texcoords[index]
        if uv.shape[1] < 2:
            return None
        return np.ascontiguousarray(uv[:, :2], dtype=np.float32)


def decode_vertex_buffer(flags: int, count: int, payload: bytes) -> VertexData:
    fmt = VertexFormat(flags)
    stride = fmt.stride
    if stride == 0:
        raise IffError(f"vertex format {flags:#010x} declares no data")

    needed = stride * count
    if len(payload) < needed:
        raise IffError(
            f"vertex data is {len(payload)} bytes, need {needed} "
            f"({count} x {stride}, format {fmt.describe()})"
        )

    raw = np.frombuffer(payload, dtype=np.uint8, count=needed).reshape(count, stride)
    offset = 0

    def take_floats(n: int) -> np.ndarray:
        nonlocal offset
        block = raw[:, offset : offset + 4 * n]
        offset += 4 * n
        return block.copy().view(np.float32).reshape(count, n)

    def take_u32() -> np.ndarray:
        nonlocal offset
        block = raw[:, offset : offset + 4]
        offset += 4
        return block.copy().view(np.uint32).reshape(count)

    positions = take_floats(3) if fmt.has_position else np.zeros((count, 3), np.float32)
    if fmt.is_transformed:
        offset += 4
    normals = take_floats(3) if fmt.has_normal else None
    if fmt.has_point_size:
        offset += 4

    colors: np.ndarray | None = None
    if fmt.has_color0:
        colors = _unpack_bgra(take_u32())
    if fmt.has_color1:
        # The second colour set is a specular term the web viewer has no use
        # for; skip it rather than smuggle it into vertex colours.
        offset += 4

    texcoords: list[np.ndarray] = []
    for i in range(fmt.texcoord_sets):
        texcoords.append(take_floats(fmt.texcoord_dim(i)))

    return VertexData(fmt, positions, normals, colors, texcoords)


def _unpack_bgra(packed: np.ndarray) -> np.ndarray:
    """PackedArgb is stored 0xAARRGGBB; glTF wants linear float RGBA."""
    a = ((packed >> 24) & 0xFF).astype(np.float32) / 255.0
    r = ((packed >> 16) & 0xFF).astype(np.float32) / 255.0
    g = ((packed >> 8) & 0xFF).astype(np.float32) / 255.0
    b = (packed & 0xFF).astype(np.float32) / 255.0
    srgb = np.stack([r, g, b], axis=1)
    linear = np.where(
        srgb <= 0.04045, srgb / 12.92, np.power((srgb + 0.055) / 1.055, 2.4)
    ).astype(np.float32)
    return np.concatenate([linear, a[:, None]], axis=1)


def read_vertex_buffer(node: IffNode) -> VertexData:
    """Read a ``VTXA`` form (any version) into vertex arrays."""
    if node.name.strip() != "VTXA":
        raise IffError(f"expected VTXA, got {node.name}")
    version = node.only_child()
    info = version.chunk("INFO")
    flags = info.u32()
    count = info.i32()
    data_node = version.find("DATA")
    if data_node is None:
        raise IffError("VTXA has no DATA chunk")
    return decode_vertex_buffer(flags, count, data_node.data)


def read_index_buffer(reader: ChunkReader) -> np.ndarray:
    """Read an ``INDX`` chunk: a count followed by 16-bit indices."""
    count = reader.i32()
    if count < 0 or count * 2 > reader.remaining:
        raise IffError(f"index buffer claims {count} indices, {reader.remaining} bytes left")
    return np.frombuffer(reader.raw(count * 2), dtype="<u2").astype(np.uint32)


def unpack_floats(payload: bytes, count: int) -> tuple[float, ...]:
    return struct.unpack(f"<{count}f", payload[: 4 * count])
