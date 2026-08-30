"""A virtual filesystem over the client's TRE stack.

The client resolves an asset path by walking its search nodes in priority order
and taking the first hit, which is how patch archives override base data. The
order comes from ``live.cfg``'s ``searchTree_NN`` entries; when no config is
supplied, :func:`default_search_order` reproduces the shipped ordering by
sorting the archive names, which puts later patches ahead of earlier ones.

Loose directories can be mounted too, at higher priority than any archive, so
an override checked into ``pre-cu-reborn-assets`` wins over the TRE that ships
the same path — exactly as the running client sees it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Self

from .tre import TreeFile, TreeFileError


@dataclass(frozen=True, slots=True)
class Source:
    label: str
    priority: int


class AssetVfs:
    """Read-only, case-insensitive view over mounted archives and directories.

    Lower `priority` wins. Mounting is eager (each archive's TOC is read up
    front) but file data is only touched on :meth:`read`.
    """

    def __init__(self) -> None:
        self._archives: list[tuple[int, TreeFile]] = []
        self._dirs: list[tuple[int, Path]] = []
        self._index: dict[str, tuple[int, object]] = {}

    # -- mounting -----------------------------------------------------------

    def mount_archive(self, path: str | Path, priority: int) -> None:
        archive = TreeFile(path)
        self._archives.append((priority, archive))
        for entry in archive.entries:
            key = _key(entry.name)
            existing = self._index.get(key)
            if existing is None or priority < existing[0]:
                self._index[key] = (priority, (archive, entry))

    def mount_dir(self, path: str | Path, priority: int) -> None:
        root = Path(path)
        if not root.is_dir():
            raise FileNotFoundError(f"{root} is not a directory")
        self._dirs.append((priority, root))
        for file in root.rglob("*"):
            if not file.is_file():
                continue
            key = _key(str(file.relative_to(root)))
            existing = self._index.get(key)
            if existing is None or priority < existing[0]:
                self._index[key] = (priority, file)

    # -- access -------------------------------------------------------------

    def __contains__(self, name: str) -> bool:
        return _key(name) in self._index

    def __len__(self) -> int:
        return len(self._index)

    def read(self, name: str) -> bytes:
        found = self._index.get(_key(name))
        if found is None:
            raise KeyError(name)
        _, target = found
        if isinstance(target, Path):
            return target.read_bytes()
        archive, entry = target  # type: ignore[misc]
        return archive.read_entry(entry)

    def try_read(self, name: str) -> bytes | None:
        try:
            return self.read(name)
        except KeyError:
            return None

    def paths(self, prefix: str = "", suffix: str = "") -> Iterator[str]:
        """Every mounted path, filtered by prefix and/or extension."""
        lo_prefix = prefix.lower().replace("\\", "/")
        lo_suffix = suffix.lower()
        for key in self._index:
            if lo_prefix and not key.startswith(lo_prefix):
                continue
            if lo_suffix and not key.endswith(lo_suffix):
                continue
            yield key

    def close(self) -> None:
        for _, archive in self._archives:
            archive.close()
        self._archives.clear()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def describe(self) -> list[str]:
        rows = [f"{p:>4}  dir  {d}" for p, d in sorted(self._dirs)]
        rows += [
            f"{p:>4}  tre  {a.path.name} ({len(a)} files)"
            for p, a in sorted(self._archives, key=lambda t: t[0])
        ]
        return rows


def _key(name: str) -> str:
    return name.replace("\\", "/").lstrip("./").lower()


# ---------------------------------------------------------------------------
# Search-order construction
# ---------------------------------------------------------------------------

_PATCH_RE = re.compile(r"^patch(?:_sku\d+)?_(\d+)(?:_(\d+))?\.tre$", re.IGNORECASE)
_DATA_RE = re.compile(r"^data_(.+?)_(\d+)\.tre$", re.IGNORECASE)


def default_search_order(tre_dir: str | Path) -> list[Path]:
    """Archives in the order the client would search them, highest priority first.

    The rule the shipped ``live.cfg`` files encode is: project-specific
    archives first, then patches newest-to-oldest, then the base data sets.
    Sorting numerically on the patch index matters — a plain lexical sort puts
    ``patch_11`` ahead of ``patch_9``, which silently serves stale geometry.
    """
    root = Path(tre_dir)
    files = sorted(p for p in root.glob("*.tre") if p.is_file())

    custom: list[Path] = []
    patches: list[tuple[tuple[int, int], Path]] = []
    data: list[Path] = []
    other: list[Path] = []

    for path in files:
        name = path.name.lower()
        patch = _PATCH_RE.match(name)
        if patch:
            major = int(patch.group(1))
            minor = int(patch.group(2) or 0)
            patches.append(((major, minor), path))
        elif _DATA_RE.match(name):
            data.append(path)
        elif name.startswith(("precu_", "swgsource_")):
            custom.append(path)
        else:
            other.append(path)

    # Newest patch wins, so sort descending on the numeric index.
    patches.sort(key=lambda t: t[0], reverse=True)

    return [*custom, *(p for _, p in patches), *other, *data]


def build_vfs(
    tre_dir: str | Path | None = None,
    *,
    archives: Iterable[str | Path] | None = None,
    loose_dirs: Iterable[str | Path] = (),
) -> AssetVfs:
    """Mount loose directories then archives, in descending priority."""
    vfs = AssetVfs()
    priority = 0

    for directory in loose_dirs:
        vfs.mount_dir(directory, priority)
        priority += 1

    ordered: list[Path]
    if archives is not None:
        ordered = [Path(a) for a in archives]
    elif tre_dir is not None:
        ordered = default_search_order(tre_dir)
    else:
        ordered = []

    for archive in ordered:
        try:
            vfs.mount_archive(archive, priority)
        except TreeFileError as exc:
            # A corrupt or non-TreeFile .tre in the client directory should not
            # abort a 2 GB conversion run; report and keep going.
            print(f"  skipping {Path(archive).name}: {exc}")
        priority += 1

    return vfs
