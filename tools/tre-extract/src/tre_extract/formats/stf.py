"""String table (``.stf``) reader.

Every user-visible name in the game is a string-table reference, not a literal:
an object row carries `@obj_n:pistol_cdef`, and the client resolves it at
display time. Without these tables the web dashboards can only show the raw
key, which is why extracting them turns "Pistol Cdef" into "CDEF Pistol".

Format, from external/ours/library/localization (all little endian)::

    u32  magic            0xABCD
    u8   version          1
    u32  nextUniqueId
    u32  entryCount

    entryCount x string records:
        u32  id
        u32  sourceCrc       0xFFFFFFFF when unset
        u32  length          in UTF-16 code units, excluding the terminator
        u16 x length         the text, UTF-16LE

    entryCount x name records:
        u32  id              matches a string record above
        u32  length          in bytes, excluding the terminator
        u8 x length          the ASCII key

The two halves are separate passes over the same ids, so a table has to be read
in full before any key can be resolved — there is no index.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

MAGIC = 0xABCD
SUPPORTED_VERSIONS = (0, 1)
NULL_CRC = 0xFFFFFFFF

_U32 = struct.Struct("<I")


class StfError(Exception):
    pass


@dataclass(slots=True)
class StringTable:
    """One `.stf`, as a key → text mapping."""

    name: str
    version: int
    entries: dict[str, str]

    def get(self, key: str, default: str | None = None) -> str | None:
        return self.entries.get(key, default)

    def __len__(self) -> int:
        return len(self.entries)


def read_stf(data: bytes, name: str = "") -> StringTable:
    if len(data) < 13:
        raise StfError(f"{name or 'table'}: too short to be a string table")

    magic = _U32.unpack_from(data, 0)[0]
    if magic != MAGIC:
        raise StfError(f"{name or 'table'}: bad magic {magic:#06x}")

    version = data[4]
    if version not in SUPPORTED_VERSIONS:
        raise StfError(f"{name or 'table'}: unsupported version {version}")

    pos = 5
    pos += 4  # nextUniqueId, only meaningful to the editor
    (count,) = _U32.unpack_from(data, pos)
    pos += 4

    # Pass one: id → text.
    texts: dict[int, str] = {}
    for _ in range(count):
        if pos + 12 > len(data):
            raise StfError(f"{name or 'table'}: truncated string record")
        entry_id, _crc, length = struct.unpack_from("<3I", data, pos)
        pos += 12
        # `length` counts UTF-16 code units, so a 170-char string is 340 bytes.
        byte_length = length * 2
        if pos + byte_length > len(data):
            raise StfError(f"{name or 'table'}: string {entry_id} runs past the end")
        texts[entry_id] = data[pos : pos + byte_length].decode("utf-16-le", errors="replace")
        pos += byte_length

    # Pass two: id → key.
    entries: dict[str, str] = {}
    for _ in range(count):
        if pos + 8 > len(data):
            raise StfError(f"{name or 'table'}: truncated name record")
        entry_id, length = struct.unpack_from("<2I", data, pos)
        pos += 8
        if pos + length > len(data):
            raise StfError(f"{name or 'table'}: key for {entry_id} runs past the end")
        key = data[pos : pos + length].decode("latin-1")
        pos += length
        text = texts.get(entry_id)
        if text is not None:
            entries[key] = text

    return StringTable(name=table_name(name), version=version, entries=entries)


def table_name(path: str) -> str:
    """`string/en/obj_n.stf` → `obj_n`.

    Locale-qualified subdirectories collapse: an object referencing `@obj_n:x`
    means whichever locale is loaded, so the locale is a pipeline choice rather
    than part of the identity.
    """
    stem = path.replace("\\", "/").rsplit("/", 1)[-1]
    return stem[:-4] if stem.lower().endswith(".stf") else stem


def parse_reference(reference: str) -> tuple[str, str] | None:
    """`@obj_n:pistol_cdef` → `("obj_n", "pistol_cdef")`.

    Returns None for anything that is not a reference, so callers can pass
    display strings through unchanged.
    """
    if not reference.startswith("@"):
        return None
    body = reference[1:]
    colon = body.rfind(":")
    if colon <= 0:
        return None
    table = body[:colon]
    key = body[colon + 1 :]
    if not table or not key:
        return None
    # Some references carry a path, e.g. `@ui/loc:key`; the table is the last
    # path segment.
    return table.rsplit("/", 1)[-1], key
