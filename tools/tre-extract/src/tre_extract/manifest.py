"""The manifest the web app reads to know what assets exist.

One JSON file, written once at the end of a run, listing every converted asset
with the numbers the viewer needs before it downloads anything: bounds (to
frame the camera without loading the model), triangle count (to warn on heavy
assets), and the object templates that use the appearance (to search by item
name rather than by mesh filename).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass(slots=True)
class ManifestEntry:
    key: str
    name: str
    kind: str
    model: str
    bounds: dict[str, list[float]]
    triangles: int
    vertices: int
    lodCount: int
    materials: int
    textures: int
    sizeBytes: int
    templates: list[str] = field(default_factory=list)
    #: Names of the animation clips baked into the GLB, in the order the file
    #: declares them, so a viewer can offer a clip picker without downloading
    #: the model first to find out whether it has any.
    animations: list[str] = field(default_factory=list)
    #: Names of the attachment points emitted as empty nodes in the GLB, so a
    #: tool can tell what a model can carry without downloading it first.
    hardpoints: list[str] = field(default_factory=list)
    #: Palette-driven colour channels this model's shaders declare -- a ship's
    #: paint. Each is {variable, textureTag, palette, index}; see
    #: formats/shader.HueChannel for what those mean.
    hue: list[dict] = field(default_factory=list)
    #: Swappable texture sets -- the ship's patterns. Files live beside the
    #: models under patterns/, because only one option is shown at a time.
    pattern: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class Manifest:
    generatedAt: str
    generator: str
    sourceLabel: str
    entries: list[ManifestEntry] = field(default_factory=list)

    def deduped(self) -> list[ManifestEntry]:
        """Entries by key, LAST wins.

        The key is what every consumer indexes by, so two rows sharing one is a
        defect wherever it came from -- an overlapping pattern, or a manifest
        merged from an older run that already had one.

        Last wins because within a run the GLB is written once per entry, so for
        a duplicated key the file left on disk is the one the LAST entry
        describes. Several assets are reachable by two entry points that reduce
        to one key -- `foo.apt` and `foo.sat` -- and the `.sat` (skinned, with
        clips) converts second and overwrites the rigid `.apt` output. Keeping
        the first row left the manifest claiming those assets had no animations
        and the wrong size and bounds, so the browser offered no clip picker for
        the wampa, the AT-ST or the protocol droid.

        Carried entries cannot collide with fresh ones -- merge_existing skips
        any key this run already produced -- so last-wins here still means
        "entries this run produced win".
        """
        by_key: dict[str, ManifestEntry] = {}
        for entry in self.entries:
            by_key[entry.key] = entry
        return list(by_key.values())

    def to_json(self) -> str:
        entries = self.deduped()
        payload = {
            "generatedAt": self.generatedAt,
            "generator": self.generator,
            "sourceLabel": self.sourceLabel,
            "count": len(entries),
            "totalTriangles": sum(e.triangles for e in entries),
            "totalBytes": sum(e.sizeBytes for e in entries),
            "entries": [asdict(e) for e in sorted(entries, key=lambda e: e.key)],
        }
        return json.dumps(payload, indent=2)

    def write(self, path: str | Path) -> None:
        Path(path).write_text(self.to_json(), encoding="utf-8")

    def merge_existing(self, path: str | Path) -> int:
        """Fold in entries from a manifest already on disk.

        Conversion runs are routinely incremental — a narrow `--pattern` to add
        one category, or a re-run that skips models already written. Without
        this, each run would replace the manifest with only what it converted,
        silently unpublishing every asset from every previous run while leaving
        the .glb files sitting there.

        Entries this run produced win; anything else is carried forward.
        """
        try:
            payload = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return 0

        # Deduped as we go, not just against this run. Two appearance paths can
        # reduce to one key -- `foo.apt` and `foo.lod` both stem to `foo` -- so
        # a run whose pattern caught both emits the key twice, and a manifest
        # already holding a duplicate would otherwise carry both forward. A
        # duplicate key is not harmless: the browser renders the list by key and
        # React drops or doubles rows that share one.
        seen = {entry.key for entry in self.entries}
        carried = 0
        for raw in payload.get("entries", []):
            key = raw.get("key")
            if not key or key in seen:
                continue
            try:
                self.entries.append(ManifestEntry(**raw))
                seen.add(key)
                carried += 1
            except TypeError:
                # An older manifest with a different shape is not worth
                # failing over; it will be rebuilt by a full run.
                continue
        return carried


def display_name(key: str) -> str:
    """`mesh/frn_tato_vase_s02_l0` → `Frn Tato Vase S02`.

    LOD suffixes are stripped because the manifest only ever holds the highest
    detail level, and leaving `_l0` on every name makes the asset browser
    unreadable.
    """
    stem = key.rsplit("/", 1)[-1]
    for suffix in ("_l0", "_l1", "_l2", "_l3", "_lod0"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    words = [w for w in stem.replace("-", "_").split("_") if w]
    return " ".join(w.upper() if len(w) <= 2 and w.isalpha() else w.capitalize() for w in words)


def build_template_index(entries: Iterable[tuple[str, str]]) -> dict[str, list[str]]:
    """Group `(appearanceKey, templatePath)` pairs into a key → templates map."""
    index: dict[str, list[str]] = {}
    for key, template in entries:
        index.setdefault(key, []).append(template)
    for templates in index.values():
        templates.sort()
    return index
