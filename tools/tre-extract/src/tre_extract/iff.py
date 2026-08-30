"""Minimal reader for SWG's IFF container format.

Every asset the engine loads is IFF: a tree of ``FORM`` nodes holding chunks.

    FORM <be_u32 length> <4-byte form type> <children...>
    <4-byte chunk tag> <be_u32 length> <payload...>

Node headers are big-endian; payloads are little-endian, because they were
written by ``memcpy`` on x86. That split is the single most common source of
bugs when reading these files by hand, so the two are kept strictly apart:
:class:`IffNode` walks the big-endian tree, :class:`ChunkReader` reads
little-endian scalars out of a payload.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator
from dataclasses import dataclass, field


def tag(text: str) -> int:
    """`tag('MESH')` → the u32 the engine compares against."""
    b = text.ljust(4)[:4].encode("ascii")
    return int.from_bytes(b, "big")


def tag_name(value: int) -> str:
    return value.to_bytes(4, "big").decode("latin-1")


TAG_FORM = tag("FORM")


class IffError(Exception):
    pass


@dataclass(slots=True)
class IffNode:
    """A FORM (with children) or a leaf chunk (with `data`)."""

    tag: int
    is_form: bool
    data: bytes = b""
    children: list[IffNode] = field(default_factory=list)

    @property
    def name(self) -> str:
        return tag_name(self.tag)

    # -- navigation ---------------------------------------------------------

    def find(self, *path: str) -> IffNode | None:
        """First descendant matching a tag path, e.g. `find('0004', 'SPS')`."""
        node: IffNode | None = self
        for step in path:
            if node is None:
                return None
            wanted = tag(step)
            node = next((c for c in node.children if c.tag == wanted), None)
        return node

    def find_all(self, name: str) -> list[IffNode]:
        wanted = tag(name)
        return [c for c in self.children if c.tag == wanted]

    def walk(self) -> Iterator[IffNode]:
        yield self
        for child in self.children:
            yield from child.walk()

    def chunk(self, name: str) -> ChunkReader:
        node = self.find(name)
        if node is None:
            raise IffError(f"{self.name} has no {name} chunk")
        return ChunkReader(node.data)

    def reader(self) -> ChunkReader:
        return ChunkReader(self.data)

    def only_child(self) -> IffNode:
        """The single child, for nodes that wrap exactly one versioned form."""
        if len(self.children) != 1:
            raise IffError(f"{self.name} has {len(self.children)} children, expected 1")
        return self.children[0]

    def __repr__(self) -> str:
        kind = "FORM" if self.is_form else "CHUNK"
        extra = f" children={len(self.children)}" if self.is_form else f" bytes={len(self.data)}"
        return f"<{kind} {self.name}{extra}>"


def parse(data: bytes | memoryview) -> IffNode:
    """Parse a complete IFF file and return its root node."""
    view = memoryview(data)
    node, consumed = _parse_node(view, 0)
    # Trailing bytes are not fatal — some exported assets pad to a multiple of
    # four — but anything larger than that is a real problem.
    if len(view) - consumed > 3:
        raise IffError(f"{len(view) - consumed} trailing bytes after root node")
    return node


def _parse_node(view: memoryview, offset: int) -> tuple[IffNode, int]:
    if offset + 8 > len(view):
        raise IffError(f"truncated node header at {offset}")
    node_tag = int.from_bytes(view[offset : offset + 4], "big")
    length = int.from_bytes(view[offset + 4 : offset + 8], "big")
    body = offset + 8
    end = body + length
    if end > len(view):
        raise IffError(f"node {tag_name(node_tag)} at {offset} claims {length} bytes, past EOF")

    if node_tag != TAG_FORM:
        return IffNode(node_tag, is_form=False, data=bytes(view[body:end])), end

    if length < 4:
        raise IffError(f"FORM at {offset} is too short to hold a type tag")
    form_type = int.from_bytes(view[body : body + 4], "big")
    node = IffNode(form_type, is_form=True)
    cursor = body + 4
    while cursor < end:
        child, cursor = _parse_node(view, cursor)
        node.children.append(child)
    # Note: unlike EA-85 IFF, SWG never pads odd-length nodes to an even
    # boundary. Adding the classic pad byte desynchronises the whole tree.
    return node, end


class ChunkReader:
    """Sequential little-endian reader over a chunk payload."""

    __slots__ = ("data", "pos")

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    @property
    def remaining(self) -> int:
        return len(self.data) - self.pos

    def eof(self) -> bool:
        return self.pos >= len(self.data)

    def _take(self, count: int) -> bytes:
        end = self.pos + count
        if end > len(self.data):
            raise IffError(f"read past end of chunk ({count} bytes at {self.pos})")
        out = self.data[self.pos : end]
        self.pos = end
        return out

    def u8(self) -> int:
        return self._take(1)[0]

    def i8(self) -> int:
        return struct.unpack("<b", self._take(1))[0]

    def bool8(self) -> bool:
        return self._take(1)[0] != 0

    def u16(self) -> int:
        return struct.unpack("<H", self._take(2))[0]

    def i16(self) -> int:
        return struct.unpack("<h", self._take(2))[0]

    def u32(self) -> int:
        return struct.unpack("<I", self._take(4))[0]

    def i32(self) -> int:
        return struct.unpack("<i", self._take(4))[0]

    def f32(self) -> float:
        return struct.unpack("<f", self._take(4))[0]

    def vec3(self) -> tuple[float, float, float]:
        return struct.unpack("<3f", self._take(12))

    def tag(self) -> int:
        """Tags inside payloads are written as u32, so they read reversed."""
        return int.from_bytes(self._take(4), "little")

    def cstring(self) -> str:
        end = self.data.find(b"\0", self.pos)
        if end == -1:
            end = len(self.data)
        out = self.data[self.pos : end].decode("latin-1")
        self.pos = min(end + 1, len(self.data))
        return out

    def raw(self, count: int) -> bytes:
        return self._take(count)

    def rest(self) -> bytes:
        out = self.data[self.pos :]
        self.pos = len(self.data)
        return out
