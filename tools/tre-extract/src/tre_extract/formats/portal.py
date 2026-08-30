"""Portal layouts (``.pob``): what a building looks like from outside.

A building has no ``appearanceFilename``. Its template names a
``portalLayoutFilename`` instead, and the portal layout owns the geometry — one
cell per room plus a cell for the outside world. Without reading it, every
building in the game resolves to no model at all, which is why houses and city
halls were missing from the asset index while every crate and chair was there.

Cell 0 is the exterior by construction: the portal system treats it as the cell
the player is in when not inside the building, so it is the shell you see from
the street. That is the one a map or a planner wants; cells 1..n are interior
rooms that are only visible through a door.
"""

from __future__ import annotations

from ..iff import IffNode, parse

#: Appearance suffixes a cell can name. `.apt` is an indirection to one of the
#: others, which the appearance resolver already follows.
_APPEARANCE_SUFFIXES = (".lod", ".apt", ".msh", ".cmp", ".lmg")


def read_exterior_appearance(data: bytes, path: str = "") -> str | None:
    """The appearance path of a portal layout's exterior cell, if it has one.

    Returns None rather than raising for anything unreadable: a building whose
    exterior cannot be resolved should fall back to having no model, exactly as
    it did before, rather than failing a whole conversion run.
    """
    try:
        root = parse(data)
    except Exception:
        return None
    return _exterior_from(root)


def _exterior_from(root: IffNode) -> str | None:
    cells = next((node for node in root.walk() if node.name == "CELS"), None)
    if cells is None or not cells.children:
        return None

    # Cell 0 only. Later cells are interior rooms, and picking the first
    # appearance found anywhere in the file would return whichever room the
    # exporter happened to write first.
    first_cell = cells.children[0]
    for node in first_cell.walk():
        if node.name != "DATA":
            continue
        found = _appearance_in(node.data)
        if found:
            return found
    return None


def _appearance_in(blob: bytes) -> str | None:
    """Pull an appearance path out of a cell's DATA chunk.

    The chunk interleaves flags, counts and several NUL-terminated strings —
    the cell's own name among them — so the fields are found by scanning for a
    string that looks like an appearance rather than by fixed offsets, which
    differ between layout versions.
    """
    for raw in blob.split(b"\0"):
        if not raw or len(raw) < 5:
            continue
        try:
            text = raw.decode("latin-1")
        except UnicodeDecodeError:  # pragma: no cover - latin-1 decodes anything
            continue
        lowered = text.lower()
        if lowered.startswith("appearance/") and lowered.endswith(_APPEARANCE_SUFFIXES):
            return text
    return None
