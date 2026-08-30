"""Shared object template (``.iff``) reader.

A shared template is what the client loads to know how to draw an object. It
carries the three facts the web tier cannot get from the database:

  * ``appearanceFilename`` — which appearance, and so which converted model
  * ``objectName`` — the string-table reference for the display name
  * ``gameObjectType`` — the category the bazaar and inventory group by

Chunk encoding is uniform: a NUL-terminated field name, a one-byte "set here"
flag, then the value when set. Unset fields inherit from the template named in
the ``DERV`` chunk, so reading one file in isolation gives a mostly-empty
result — the derivation chain has to be walked, and it is often three or four
deep (`axe_heavy_duty` → `axe_base` → `weapon_base` → …).

The interesting fields live in the innermost ``SHOT`` form; the enclosing
``SWOT``/``STOT`` forms carry server and tangible properties the client ignores.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from ..iff import IffError, IffNode, parse
from ..vfs import AssetVfs

#: Fields worth extracting, and how their value is encoded.
_STRING_FIELDS = frozenset(
    {
        "appearanceFilename",
        "portalLayoutFilename",
        "clientDataFile",
        "slotDescriptorFilename",
        "structureFootprintFileName",
    }
)
_STRING_ID_FIELDS = frozenset({"objectName", "detailedDescription", "lookAtText"})
_INT_FIELDS = frozenset({"gameObjectType", "containerType", "containerVolumeLimit"})


@dataclass(slots=True)
class SharedTemplate:
    path: str
    derived_from: str | None = None
    appearance: str | None = None
    portal_layout: str | None = None
    client_data: str | None = None
    #: `(table, key)` from `objectName`, e.g. `("weapon_name", "axe_heavy_duty")`.
    object_name: tuple[str, str] | None = None
    detailed_description: tuple[str, str] | None = None
    game_object_type: int | None = None
    container_type: int | None = None
    container_volume_limit: int | None = None
    #: The .sfp naming the lots this thing reserves, for anything placeable.
    structure_footprint: str | None = None
    #: Templates visited while resolving, nearest first.
    chain: list[str] = field(default_factory=list)

    @property
    def is_complete(self) -> bool:
        """Whether the fields the web tier needs are all filled in."""
        return self.appearance is not None and self.game_object_type is not None


def read_shared_template(data: bytes, path: str = "") -> SharedTemplate | None:
    """Read one template file, without following its derivation.

    Returns None for anything that is not parseable IFF. A few hundred paths
    under `object/` are zero-byte placeholders or non-template data, and one
    bad file must not abort an index run over 30,000 of them.
    """
    template = SharedTemplate(path=path)
    try:
        root = parse(data)
    except IffError:
        return None

    # DERV appears at every nesting level and always names the same parent;
    # take the first.
    for node in root.walk():
        if node.is_form and node.name.strip() == "DERV":
            for child in node.children:
                if not child.is_form:
                    parent = child.reader().cstring().replace("\\", "/")
                    if parent:
                        template.derived_from = parent
                    break
            break

    for node in root.walk():
        if node.is_form or node.name.strip() != "XXXX":
            continue
        _read_field(node, template)

    return template


def _read_field(node: IffNode, template: SharedTemplate) -> None:
    reader = node.reader()
    name = reader.cstring()
    if not name or reader.eof():
        return

    # A zero flag means "not set here"; the value comes from the parent.
    if reader.u8() == 0:
        return

    try:
        if name in _STRING_FIELDS:
            value = reader.cstring().replace("\\", "/")
            if not value:
                return
            if name == "appearanceFilename":
                template.appearance = value
            elif name == "portalLayoutFilename":
                template.portal_layout = value
            elif name == "clientDataFile":
                template.client_data = value
            elif name == "structureFootprintFileName":
                template.structure_footprint = value

        elif name in _STRING_ID_FIELDS:
            # StringId is a length-flagged pair: <u8> table <u8> key.
            reader.u8()
            table = reader.cstring()
            if reader.eof():
                return
            reader.u8()
            key = reader.cstring()
            if not table or not key:
                return
            if name == "objectName":
                template.object_name = (table, key)
            elif name == "detailedDescription":
                template.detailed_description = (table, key)

        elif name in _INT_FIELDS:
            # Integer fields carry a data-type byte before the value.
            reader.u8()
            if reader.remaining < 4:
                return
            value = reader.i32()
            if name == "gameObjectType":
                template.game_object_type = value
            elif name == "containerType":
                template.container_type = value
            elif name == "containerVolumeLimit":
                template.container_volume_limit = value
    except Exception:
        # A field encoded differently than expected must not abort the file;
        # the remaining fields are still worth having.
        return


def resolve_template(
    vfs: AssetVfs,
    path: str,
    *,
    max_depth: int = 12,
    cache: dict[str, SharedTemplate] | None = None,
) -> SharedTemplate | None:
    """Read a template and fill unset fields from its derivation chain."""
    if cache is not None and path in cache:
        return cache[path]

    data = vfs.try_read(path)
    if data is None:
        return None

    resolved = read_shared_template(data, path)
    if resolved is None:
        return None
    resolved.chain.append(path)

    parent_path = resolved.derived_from
    depth = 0
    while parent_path and not resolved.is_complete and depth < max_depth:
        if parent_path in resolved.chain:
            break  # a couple of shipped templates derive from themselves
        parent_data = vfs.try_read(parent_path)
        if parent_data is None:
            break
        parent = read_shared_template(parent_data, parent_path)
        if parent is None:
            break
        resolved.chain.append(parent_path)
        resolved = _inherit(resolved, parent)
        parent_path = parent.derived_from
        depth += 1

    if cache is not None:
        cache[path] = resolved
    return resolved


def _inherit(child: SharedTemplate, parent: SharedTemplate) -> SharedTemplate:
    """Fill the child's unset fields from the parent, keeping the child's chain."""
    return replace(
        child,
        appearance=child.appearance if child.appearance is not None else parent.appearance,
        portal_layout=child.portal_layout
        if child.portal_layout is not None
        else parent.portal_layout,
        client_data=child.client_data if child.client_data is not None else parent.client_data,
        object_name=child.object_name if child.object_name is not None else parent.object_name,
        detailed_description=child.detailed_description
        if child.detailed_description is not None
        else parent.detailed_description,
        game_object_type=child.game_object_type
        if child.game_object_type is not None
        else parent.game_object_type,
        container_type=child.container_type
        if child.container_type is not None
        else parent.container_type,
        container_volume_limit=child.container_volume_limit
        if child.container_volume_limit is not None
        else parent.container_volume_limit,
        structure_footprint=child.structure_footprint
        if child.structure_footprint is not None
        else parent.structure_footprint,
    )


def shared_path(server_path: str) -> str:
    """`object/weapon/melee/axe/axe_heavy_duty.iff` → the `shared_` sibling.

    The database stores the *server* template path; only the shared one ships
    to the client, and the convention is a `shared_` prefix on the filename.
    """
    normalized = server_path.replace("\\", "/").strip()
    directory, _, filename = normalized.rpartition("/")
    if filename.startswith("shared_"):
        return normalized
    return f"{directory}/shared_{filename}" if directory else f"shared_{filename}"
