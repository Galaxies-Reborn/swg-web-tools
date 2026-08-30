"""CRC string table (``CSTB``) reader.

`objects.object_template_id` is not an id into any table — it is the CRC of the
object's template path. Turning it back into `object/weapon/ranged/pistol/
pistol_cdef.iff` needs the lookup table the client ships at
``misc/object_template_crc_string_table.iff``.

Layout::

    FORM CSTB
      FORM 0000
        CHUNK DATA   u32 count
        CHUNK CRCT   count x u32   CRCs, ascending (the client binary-searches)
        CHUNK STRT   count x u32   byte offsets into STNG
        CHUNK STNG   NUL-separated paths

The same shape carries the quest and planet CRC tables.

One trap: Oracle stores the CRC in a signed column, so a template whose CRC has
the high bit set arrives as a negative number. Looking that up without
converting to unsigned finds nothing, silently.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from ..iff import IffError, parse


@dataclass(slots=True)
class CrcStringTable:
    """CRC → string, plus the reverse mapping."""

    by_crc: dict[int, str]

    def __len__(self) -> int:
        return len(self.by_crc)

    def get(self, crc: int) -> str | None:
        """Look up a CRC, accepting the signed form Oracle hands back."""
        return self.by_crc.get(to_unsigned(crc))

    def items(self):
        return self.by_crc.items()


def to_unsigned(value: int) -> int:
    """Signed 32-bit → unsigned. `-640104330` becomes `3654862966`."""
    return value & 0xFFFFFFFF


def to_signed(value: int) -> int:
    """Unsigned 32-bit → signed, matching how Oracle stores it."""
    value &= 0xFFFFFFFF
    return value - 0x100000000 if value >= 0x80000000 else value


def read_crc_table(data: bytes, name: str = "") -> CrcStringTable:
    root = parse(data)
    if root.name.strip() != "CSTB":
        raise IffError(f"{name or 'table'} is {root.name}, not CSTB")

    version = root.children[0] if root.children else None
    if version is None or not version.is_form:
        raise IffError(f"{name or 'table'}: no versioned form")

    count_node = version.find("DATA")
    crc_node = version.find("CRCT")
    offset_node = version.find("STRT")
    string_node = version.find("STNG")
    if not (count_node and crc_node and offset_node and string_node):
        raise IffError(f"{name or 'table'}: missing one of DATA/CRCT/STRT/STNG")

    (count,) = struct.unpack_from("<I", count_node.data, 0)
    if len(crc_node.data) < count * 4 or len(offset_node.data) < count * 4:
        raise IffError(f"{name or 'table'}: declares {count} entries but the chunks are short")

    crcs = struct.unpack_from(f"<{count}I", crc_node.data, 0)
    offsets = struct.unpack_from(f"<{count}I", offset_node.data, 0)
    blob = string_node.data

    by_crc: dict[int, str] = {}
    for crc, offset in zip(crcs, offsets, strict=False):
        if offset >= len(blob):
            continue
        end = blob.find(b"\0", offset)
        if end == -1:
            end = len(blob)
        by_crc[crc] = blob[offset:end].decode("latin-1").replace("\\", "/")

    return CrcStringTable(by_crc=by_crc)
