"""Reader for SWG ``.tre`` archives (the engine calls them TreeFiles).

Layout, from sharedFile/TreeFile_SearchNode.{h,cpp}::

    header (36 bytes, little endian)
        token                  'EERT' on disk, i.e. TAG(T,R,E,E) read as LE u32
        version                '4000' / '5000' / '6000'
        numberOfFiles          u32
        tocOffset              u32
        tocCompressor          u32   0 none, 1 deprecated, 2 zlib
        sizeOfTOC              u32   on-disk (possibly compressed) TOC size
        blockCompressor        u32
        sizeOfNameBlock        u32
        uncompSizeOfNameBlock  u32

    table of contents         numberOfFiles entries at tocOffset
    name block                immediately after the TOC, NUL-separated paths
    file data                 anywhere; each entry carries its own offset

Versions 0004 and 0005 use a 24-byte TOC entry; 0006 (which the Reborn client
ships) widens it to 32 bytes and reorders the fields. Both are handled.
"""

from __future__ import annotations

import struct
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Self

TAG_TREE = 0x54524545  # 'TREE'
VERSION_0004 = 0x30303034
VERSION_0005 = 0x30303035
VERSION_0006 = 0x30303036

SUPPORTED_VERSIONS = (VERSION_0004, VERSION_0005, VERSION_0006)

CT_NONE = 0
CT_DEPRECATED = 1
CT_ZLIB = 2

_HEADER = struct.Struct("<9I")
_ENTRY_24 = struct.Struct("<I5i")
_ENTRY_32 = struct.Struct("<8I")


class TreeFileError(Exception):
    """Raised when an archive is not a TreeFile or uses an unknown layout."""


@dataclass(frozen=True, slots=True)
class TreeEntry:
    """One file inside an archive."""

    name: str
    crc: int
    offset: int
    length: int
    compressor: int
    compressed_length: int

    @property
    def is_compressed(self) -> bool:
        # The engine treats anything other than CT_none as compressed; only
        # zlib was ever shipped.
        return self.compressor != CT_NONE


def _decompress(raw: bytes, compressor: int, expected: int) -> bytes:
    if compressor == CT_NONE:
        return raw
    if compressor not in (CT_ZLIB, CT_DEPRECATED):
        raise TreeFileError(f"unknown compressor {compressor}")
    out = zlib.decompress(raw, bufsize=max(expected, 1))
    if expected and len(out) != expected:
        raise TreeFileError(f"decompressed to {len(out)} bytes, expected {expected}")
    return out


class TreeFile:
    """Random-access reader over a single ``.tre`` archive.

    The handle stays open for the lifetime of the object; use it as a context
    manager, or call :meth:`close`. Entry data is read on demand, so opening a
    100 MB archive costs only the TOC and name block.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._fh: BinaryIO = self.path.open("rb")
        try:
            self.version, self.entries = self._read_index()
        except Exception:
            self._fh.close()
            raise
        self._by_name = {_normalize(e.name): e for e in self.entries}

    # -- construction -------------------------------------------------------

    def _read_index(self) -> tuple[int, list[TreeEntry]]:
        head = self._fh.read(_HEADER.size)
        if len(head) < _HEADER.size:
            raise TreeFileError(f"{self.path.name}: truncated header")

        (
            token,
            version,
            file_count,
            toc_offset,
            toc_compressor,
            toc_size,
            block_compressor,
            name_block_size,
            name_block_uncompressed_size,
        ) = _HEADER.unpack(head)

        if token != TAG_TREE:
            raise TreeFileError(f"{self.path.name}: not a TreeFile (token {token:#010x})")
        if version not in SUPPORTED_VERSIONS:
            raise TreeFileError(f"{self.path.name}: unsupported version {version:#010x}")

        entry_size = 32 if version == VERSION_0006 else 24
        toc_uncompressed_size = entry_size * file_count

        self._fh.seek(toc_offset)
        if toc_compressor != CT_NONE:
            toc_bytes = _decompress(self._fh.read(toc_size), toc_compressor, toc_uncompressed_size)
            # A compressed TOC is followed immediately by the name block.
            name_pos = toc_offset + toc_size
        else:
            toc_bytes = self._fh.read(toc_uncompressed_size)
            name_pos = toc_offset + toc_uncompressed_size

        self._fh.seek(name_pos)
        names_raw = _decompress(
            self._fh.read(
                name_block_size
                if block_compressor != CT_NONE
                else name_block_uncompressed_size
            ),
            block_compressor,
            name_block_uncompressed_size,
        )

        entries = list(self._parse_entries(toc_bytes, names_raw, file_count, version))
        return version, entries

    @staticmethod
    def _parse_entries(
        toc: bytes, names: bytes, count: int, version: int
    ) -> Iterator[TreeEntry]:
        def name_at(offset: int) -> str:
            end = names.find(b"\0", offset)
            if end == -1:
                end = len(names)
            return names[offset:end].decode("latin-1").replace("\\", "/")

        if version == VERSION_0006:
            # 32-byte entry: crc, length, offset, _, _, nameOffset, compressor,
            # compressedLength. The two zero fields at [12..19] are unexplained
            # in the exporter but constant across every shipped archive.
            for i in range(count):
                crc, length, offset, _u1, _u2, name_off, compressor, clen = _ENTRY_32.unpack_from(
                    toc, i * 32
                )
                yield TreeEntry(name_at(name_off), crc, offset, length, compressor, clen)
        else:
            for i in range(count):
                crc, length, offset, compressor, clen, name_off = _ENTRY_24.unpack_from(
                    toc, i * 24
                )
                yield TreeEntry(name_at(name_off), crc, offset, length, compressor, clen)

    # -- access -------------------------------------------------------------

    def __contains__(self, name: str) -> bool:
        return _normalize(name) in self._by_name

    def __len__(self) -> int:
        return len(self.entries)

    def names(self) -> list[str]:
        return [e.name for e in self.entries]

    def entry(self, name: str) -> TreeEntry | None:
        return self._by_name.get(_normalize(name))

    def read(self, name: str) -> bytes:
        entry = self.entry(name)
        if entry is None:
            raise KeyError(f"{name} is not in {self.path.name}")
        return self.read_entry(entry)

    def read_entry(self, entry: TreeEntry) -> bytes:
        self._fh.seek(entry.offset)
        if entry.is_compressed:
            raw = self._fh.read(entry.compressed_length)
            return _decompress(raw, entry.compressor, entry.length)
        return self._fh.read(entry.length)

    def close(self) -> None:
        if not self._fh.closed:
            self._fh.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"<TreeFile {self.path.name} v{self.version:#010x} files={len(self.entries)}>"


def _normalize(name: str) -> str:
    return name.replace("\\", "/").lstrip("./")
