"""Resolve an appearance reference down to concrete mesh files.

An object template names an appearance, but that name is rarely a mesh. The
chain runs through several indirections, each a different IFF root tag:

    APT   → a single NAME chunk pointing at the real appearance
    MLOD  → `.lmg`, a flat list of LOD mesh names, l0 first (highest detail)
    DTLA  → `.lod`, LOD children as `u32 index` + a path relative to
            `appearance/`, listed *coarsest first*
    CMPA  → `.cmp`, a composite of several appearances with transforms
    SMAT  → `.sat`, a skeletal appearance: `MSGN` chunks name the mesh
            generators, `SKTI` the skeleton. This is how every wearable and
            every creature is referenced.
    MESH  → the terminal case

Only the highest-detail level is exported: a web viewer that streams one model
at a time has no use for the LOD ladder, and l0 is what a screenshot needs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..iff import IffError, IffNode, parse
from ..vfs import AssetVfs

APPEARANCE_ROOT = "appearance/"

#: Root tags this module knows how to walk.
KNOWN_ROOTS = {"APT", "MLOD", "DTLA", "CMPA", "MESH", "SMAT", "SKTM", "SLOD", "CLDF"}


@dataclass(slots=True)
class ResolvedAppearance:
    """Where a lookup ended up."""

    #: The path originally asked for.
    source: str
    #: Static mesh files to load, in draw order.
    meshes: list[str] = field(default_factory=list)
    #: Skinned mesh files, when the appearance is a creature or wearable.
    skinned: list[str] = field(default_factory=list)
    #: Every path visited, for diagnostics and cache invalidation.
    chain: list[str] = field(default_factory=list)
    #: Number of LOD levels the source declared, before collapsing to l0.
    lod_count: int = 1

    @property
    def kind(self) -> str:
        if self.skinned and not self.meshes:
            return "skinned"
        if len(self.meshes) > 1:
            return "component"
        return "static"

    @property
    def is_empty(self) -> bool:
        return not self.meshes and not self.skinned


class AppearanceResolver:
    """Walks appearance references, memoising results per VFS."""

    def __init__(self, vfs: AssetVfs, *, max_depth: int = 12) -> None:
        self._vfs = vfs
        self._max_depth = max_depth
        self._cache: dict[str, ResolvedAppearance] = {}

    def resolve(self, path: str) -> ResolvedAppearance:
        key = _norm(path)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        result = ResolvedAppearance(source=key)
        self._walk(key, result, depth=0)
        self._cache[key] = result
        return result

    # -- internals ----------------------------------------------------------

    def _walk(self, path: str, out: ResolvedAppearance, depth: int) -> None:
        if depth > self._max_depth:
            raise IffError(f"appearance chain from {out.source} exceeded {self._max_depth} hops")
        path = _norm(path)
        if path in out.chain:
            return  # cycles exist in a couple of shipped assets
        out.chain.append(path)

        if path.endswith(".mgn"):
            out.skinned.append(path)
            return
        if path.endswith(".msh"):
            out.meshes.append(path)
            return

        data = self._vfs.try_read(path)
        if data is None:
            return

        try:
            root = parse(data)
        except IffError:
            return

        tag = root.name.strip()
        if tag == "MESH":
            out.meshes.append(path)
        elif tag == "APT":
            self._walk_apt(root, out, depth)
        elif tag == "MLOD":
            self._walk_mlod(root, out, depth)
        elif tag == "DTLA":
            self._walk_dtla(root, out, depth)
        elif tag == "CMPA":
            self._walk_cmpa(root, out, depth)
        elif tag == "SMAT":
            self._walk_smat(root, out, depth)
        elif tag in ("SKTM", "SLOD"):
            self._walk_skeletal(root, out, depth)
        # Anything else (collision data, particle systems, terrain) has no
        # renderable geometry for the viewer, so it resolves to nothing.

    def _walk_apt(self, root: IffNode, out: ResolvedAppearance, depth: int) -> None:
        for node in root.walk():
            if not node.is_form and node.name.strip() == "NAME":
                target = node.reader().cstring()
                if target:
                    self._walk(target, out, depth + 1)
                return

    def _walk_mlod(self, root: IffNode, out: ResolvedAppearance, depth: int) -> None:
        version = _version_form(root)
        if version is None:
            return
        names = [c.reader().cstring() for c in version.children if c.name.strip() == "NAME"]
        names = [n for n in names if n]
        if not names:
            return
        out.lod_count = max(out.lod_count, len(names))
        # MLOD lists finest first: `_l0` is index 0.
        self._walk(names[0], out, depth + 1)

    def _walk_dtla(self, root: IffNode, out: ResolvedAppearance, depth: int) -> None:
        version = _version_form(root)
        if version is None:
            return
        data = version.find("DATA")
        if data is None:
            return

        children: list[tuple[int, str]] = []
        for chunk in data.children:
            if chunk.is_form or chunk.name.strip() != "CHLD":
                continue
            reader = chunk.reader()
            index = reader.u32()
            name = reader.cstring()
            if name:
                children.append((index, name))
        if not children:
            return

        out.lod_count = max(out.lod_count, len(children))
        # DTLA lists coarsest first, so the highest index is the finest level.
        _, finest = max(children, key=lambda c: c[0])
        # CHLD paths are relative to `appearance/`.
        target = finest if finest.startswith(APPEARANCE_ROOT) else APPEARANCE_ROOT + finest
        self._walk(target, out, depth + 1)

    def _walk_cmpa(self, root: IffNode, out: ResolvedAppearance, depth: int) -> None:
        """A composite draws several appearances together, one per `PART`.

        Not `NAME`: a composite stores its members in `PART` chunks, each a
        NUL-terminated path followed by a twelve-float transform. Looking for
        `NAME` found nothing in any of the 165 shipped composites, so every one
        of them resolved to no geometry at all.

        The path is relative to `appearance/`, which is why it is prefixed
        here rather than walked as written.

        The part transforms are read past but not applied. Most are identity;
        85 of 779 are not, so a composite with an offset member assembles with
        that member at the origin. Fixing that needs the resolver to carry a
        transform down the chain, which it currently has no way to express.
        """
        for node in root.walk():
            if node.is_form or node.name.strip() != "PART":
                continue
            target = node.reader().cstring()
            if not target:
                continue
            path = target if target.lower().startswith("appearance/") else f"appearance/{target}"
            self._walk(path, out, depth + 1)

    def _walk_smat(self, root: IffNode, out: ResolvedAppearance, depth: int) -> None:
        """A skeletal appearance names its mesh generators in `MSGN` chunks.

        There is one per body part or wearable layer, so a creature resolves
        to several. `SKTI` names the skeleton, which a bind-pose export does
        not need.
        """
        for node in root.walk():
            if node.is_form or node.name.strip() != "MSGN":
                continue
            target = node.reader().cstring()
            if target:
                self._walk(target, out, depth + 1)

    def _walk_skeletal(self, root: IffNode, out: ResolvedAppearance, depth: int) -> None:
        for node in root.walk():
            if node.is_form:
                continue
            text = node.reader().cstring()
            if text.endswith((".mgn", ".lmg")):
                self._walk(text, out, depth + 1)


def _version_form(node: IffNode) -> IffNode | None:
    forms = [c for c in node.children if c.is_form and c.name.strip().isdigit()]
    if not forms:
        return node.children[0] if node.children and node.children[0].is_form else None
    return max(forms, key=lambda c: int(c.name.strip()))


def _norm(path: str) -> str:
    return path.replace("\\", "/").strip().lstrip("./")
