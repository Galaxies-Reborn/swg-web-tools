"""Build the string bundle the web tier uses to resolve `@table:key` names.

The game stores display names as references, never literals: an `objects` row
carries `name_string_table = 'item_n'` and `name_string_text = 'inventory'`,
and only the client's string tables turn that into "Inventory".

Extracting every table would produce roughly 300k strings across 5,500 files.
The bundle is instead scoped to the tables the live database actually
references, plus the handful the dashboards need for their own labels — which
keeps it small enough to hold in memory in the API and ship as one JSON file.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .formats.stf import StfError, read_stf, table_name
from .vfs import AssetVfs

#: Tables referenced by `objects.name_string_table` on a live galaxy, in
#: descending order of use, plus those the dashboards label things with.
#: Verified against the running cluster rather than guessed.
DEFAULT_TABLES = (
    # Object names, by far the bulk of what the dashboards render.
    "item_n",
    "static_item_n",
    "weapon_name",
    "wearables_name",
    "medicine_name",
    "obj_n",
    "food_name",
    "hair_name",
    "craft_item_ingredients_n",
    # Note: `string_id_table` is referenced by a few dozen objects but the
    # client ships no such table, so those names are unresolvable by design
    # and are not requested here.
    # Creatures, ships, and species.
    "creature_names",
    "space_ship",
    "space_item",
    "species",
    # Descriptions, for detail panels.
    "item_d",
    "static_item_d",
    "weapon_detail",
    # Dashboard vocabulary: resources, skills, experience, attributes.
    "resource_names",
    "obj_attr_n",
    "skl_n",
    "exp_n",
    "att_n",
    "building_name",
    "crafting",
)


@dataclass(slots=True)
class StringBundle:
    locale: str
    tables: dict[str, dict[str, str]]

    @property
    def entry_count(self) -> int:
        return sum(len(t) for t in self.tables.values())

    def to_json(self) -> str:
        payload = {
            "locale": self.locale,
            "tableCount": len(self.tables),
            "entryCount": self.entry_count,
            # Sorted so re-running the extractor produces a byte-identical file
            # when nothing changed, which keeps diffs and caches meaningful.
            "tables": {
                name: dict(sorted(entries.items()))
                for name, entries in sorted(self.tables.items())
            },
        }
        return json.dumps(payload, ensure_ascii=False, indent=0, separators=(",", ":"))

    def write(self, path: str | Path) -> None:
        Path(path).write_text(self.to_json(), encoding="utf-8")


def build_bundle(
    vfs: AssetVfs,
    *,
    locale: str = "en",
    tables: tuple[str, ...] | None = None,
    include_all: bool = False,
) -> tuple[StringBundle, list[str]]:
    """Read the wanted tables out of the mounted archives.

    Returns the bundle and a list of warnings — missing tables and unreadable
    files are reported rather than silently dropped, because a missing table
    shows up later as an unresolved `@item_n:foo` in the UI and the cause is
    otherwise invisible.
    """
    wanted = set(tables or DEFAULT_TABLES)
    prefix = f"string/{locale.lower()}/"
    warnings: list[str] = []
    collected: dict[str, dict[str, str]] = {}

    seen: set[str] = set()
    for path in sorted(vfs.paths(prefix=prefix, suffix=".stf")):
        name = table_name(path)
        if not include_all and name not in wanted:
            continue
        seen.add(name)
        try:
            table = read_stf(vfs.read(path), path)
        except StfError as exc:
            # Several shipped tables are empty stubs; that is not worth a
            # warning, but a real parse failure is.
            if "too short" not in str(exc):
                warnings.append(f"{path}: {exc}")
            continue

        # A table name can appear in more than one subdirectory (`mob/`,
        # `space/`). Merge rather than letting the last one win, since they
        # hold disjoint keys.
        bucket = collected.setdefault(name, {})
        bucket.update(table.entries)

    if not include_all:
        for missing in sorted(wanted - seen):
            warnings.append(f"table {missing!r} not found under {prefix}")

    return StringBundle(locale=locale, tables=collected), warnings


def tables_from_template_index(path: str | Path) -> tuple[str, ...] | None:
    """Read the string tables a template index references.

    Better than a hand-maintained list: it is derived from what the objects in
    the world actually name themselves with, so a content update that
    introduces a new table is picked up by re-running the pipeline rather than
    by someone noticing unresolved names in the UI.
    """
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    tables: set[str] = set()
    for entry in payload.get("entries", {}).values():
        name = entry.get("name")
        if isinstance(name, list) and name:
            # References may carry a path (`mob/creature_names`); the extractor
            # flattens tables to their last segment.
            tables.add(str(name[0]).rsplit("/", 1)[-1])
    return tuple(sorted(tables)) if tables else None


def available_locales(vfs: AssetVfs) -> list[str]:
    """Locale subdirectories present under `string/`."""
    locales: set[str] = set()
    for path in vfs.paths(prefix="string/", suffix=".stf"):
        parts = path.split("/")
        if len(parts) >= 3:
            locales.add(parts[1])
    return sorted(locales)
