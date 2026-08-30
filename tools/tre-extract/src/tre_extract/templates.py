"""Build the object-template index the web tier joins against.

`objects.object_template_id` is a key into the server's own `object_templates`
table, which gives a path like `object/weapon/melee/axe/axe_heavy_duty.iff`.
That path alone says nothing about how the item looks or what category it is —
those live in the client's *shared* template, which the database does not have.

This walks every shared template in the archives and emits, keyed by the server
path the database will hand us:

    "object/weapon/melee/axe/axe_heavy_duty.iff": {
      "appearance": "appearance/wp_mle_axe_heavy_duty.apt",
      "model": "mesh/wp_mle_axe_heavy_duty",
      "name": ["weapon_name", "axe_heavy_duty"],
      "got": 131080
    }

`model` is the manifest key of the converted GLB, so the viewer can show an
inventory item without any further lookup. It is null when the appearance was
not converted — skinned meshes, mostly.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .convert import Converter, asset_key
from .formats.portal import read_exterior_appearance
from .formats.template import SharedTemplate, resolve_template
from .vfs import AssetVfs


@dataclass(slots=True)
class TemplateEntry:
    appearance: str | None
    model: str | None
    name: tuple[str, str] | None
    got: int | None
    container_volume: int | None


@dataclass(slots=True)
class TemplateIndex:
    entries: dict[str, TemplateEntry]

    @property
    def with_models(self) -> int:
        return sum(1 for e in self.entries.values() if e.model)

    @property
    def with_names(self) -> int:
        return sum(1 for e in self.entries.values() if e.name)

    def to_json(self) -> str:
        payload = {
            "count": len(self.entries),
            "withModels": self.with_models,
            "withNames": self.with_names,
            "entries": {
                path: {
                    "appearance": entry.appearance,
                    "model": entry.model,
                    "name": list(entry.name) if entry.name else None,
                    "got": entry.got,
                    "containerVolume": entry.container_volume,
                }
                for path, entry in sorted(self.entries.items())
            },
        }
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    def write(self, path: str | Path) -> None:
        Path(path).write_text(self.to_json(), encoding="utf-8")


def server_path(shared: str) -> str:
    """`.../shared_axe_heavy_duty.iff` → `.../axe_heavy_duty.iff`.

    The database stores the server path; the client ships only the shared one.
    Indexing by the server path means the API needs no rewriting at request
    time.
    """
    normalized = shared.replace("\\", "/")
    directory, _, filename = normalized.rpartition("/")
    filename = filename.removeprefix("shared_")
    return f"{directory}/{filename}" if directory else filename



def _exterior_of(vfs, portal_layout: str, cache: dict[str, str | None]) -> str | None:
    """The exterior appearance a portal layout points at, memoised."""
    key = portal_layout.lower()
    if key in cache:
        return cache[key]
    raw = vfs.try_read(portal_layout)
    found = read_exterior_appearance(raw, portal_layout) if raw is not None else None
    cache[key] = found
    return found


def build_index(
    vfs: AssetVfs,
    *,
    converted_keys: set[str] | None = None,
    progress: object = None,
) -> tuple[TemplateIndex, list[str]]:
    """Resolve every shared template in the archives.

    `converted_keys` is the set of manifest keys the conversion run produced;
    an appearance not in it gets `model: null` rather than a link to a file
    that does not exist.
    """
    resolver_cache: dict[str, SharedTemplate] = {}
    # Portal layouts are shared between templates -- every planet's variant of a
    # house points at the same handful -- so resolving one twice is common.
    portal_cache: dict[str, str | None] = {}
    entries: dict[str, TemplateEntry] = {}
    warnings: list[str] = []

    shared_templates = [
        p
        for p in vfs.paths(prefix="object/", suffix=".iff")
        if "/shared_" in p or p.startswith("shared_")
    ]

    converter = Converter(vfs) if converted_keys is None else None

    for index, path in enumerate(sorted(shared_templates)):
        template = resolve_template(vfs, path, cache=resolver_cache)
        if template is None:
            continue

        # A building names no appearance of its own: its geometry lives in a
        # portal layout, one cell per room plus the exterior. Without this
        # every house, city hall and cantina in the game resolved to no model
        # while every crate and chair had one.
        appearance = template.appearance
        if not appearance and template.portal_layout:
            appearance = _exterior_of(vfs, template.portal_layout, portal_cache)

        model: str | None = None
        if appearance:
            key = asset_key(appearance)
            if converted_keys is not None:
                model = key if key in converted_keys else None
            else:
                # Without a manifest to check against, confirm the appearance
                # at least resolves to geometry; a dangling reference would
                # otherwise become a 404 in the viewer.
                assert converter is not None
                model = key if not converter.resolve(appearance).is_empty else None

        entries[server_path(path)] = TemplateEntry(
            appearance=appearance,
            model=model,
            name=template.object_name,
            got=template.game_object_type,
            container_volume=template.container_volume_limit,
        )

        if callable(progress) and index % 2000 == 0 and index:
            progress(index, len(shared_templates))

    return TemplateIndex(entries=entries), warnings


def load_converted_keys(manifest_path: str | Path) -> set[str] | None:
    """Read the manifest keys a previous conversion run produced."""
    try:
        payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return {entry["key"] for entry in payload.get("entries", []) if "key" in entry}


def referenced_string_tables(index: TemplateIndex) -> list[str]:
    """Every string table the indexed templates name.

    Feeding this back into the `strings` command guarantees the bundle covers
    exactly the names the items in the world actually use, instead of a list
    someone maintained by hand.
    """
    tables = {entry.name[0] for entry in index.entries.values() if entry.name}
    return sorted(tables)
