"""Decorations a player can put down, with the volume each one occupies.

A city is not only its buildings. Players place furniture, statues, lights and
signs, and those take up room: a plan that ignores them is a plan that will not
fit when it is built.

The collider for each is the appearance's own collision extent where it has
one, and its render bounds where it does not -- which is the engine's own
fallback, not a guess. Most props are the second case: of the shipped LOD
files, the overwhelming majority carry NULL there.

`shape` travels with each prop so a consumer can tell the difference. A "box"
is the object's real collision volume; a "bounds" is its visual extent standing
in for one; a "mesh" is a triangle soup reduced outward to a box. They are
increasingly approximate and the field says which you have, rather than
presenting all three as equally exact.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from . import iff
from .formats.extent import collision_extent

#: Template families a player can actually place as decoration.
PLACEABLE_FAMILIES = (
    "object/tangible/furniture/",
    "object/tangible/lair/",
    "object/tangible/terminal/",
    "object/tangible/sign/",
)

#: Below this a prop is an ornament rather than an obstacle -- a cup, a datapad.
#: It is still placeable; it simply does not take part in collision.
MIN_COLLIDING_METRES = 0.5


@dataclass(frozen=True)
class Prop:
    template: str
    model: str
    name: str
    half_x: float
    half_z: float
    height: float
    #: Where the volume came from: the collision extent, or the render bounds.
    shape: str

    @property
    def collides(self) -> bool:
        return max(self.half_x, self.half_z) * 2 >= MIN_COLLIDING_METRES


def _readable(template: str, name_parts: list | None) -> str:
    """A name a person can pick from a list.

    The string table would be better and needs a bundle to resolve, so the
    template stem is used and tidied. It is the same convention the rest of the
    tools use for unresolved names, which keeps them consistent rather than
    each inventing its own.
    """
    stem = template.rsplit("/", 1)[-1].removesuffix(".iff")
    for prefix in ("shared_", "frn_all_", "frn_", "ply_", "eqp_"):
        stem = stem.removeprefix(prefix)
    words = [w for w in stem.split("_") if w and not w.startswith("s0")]
    return " ".join(w.capitalize() for w in words) or stem


def collect(
    vfs,
    templates: dict,
    manifest_bounds: dict,
    families: tuple[str, ...] = PLACEABLE_FAMILIES,
) -> tuple[list[Prop], dict[str, int]]:
    props: list[Prop] = []
    counts = {"candidates": 0, "no_model": 0, "collision_extent": 0, "render_bounds": 0}
    seen: set[str] = set()

    for template, entry in templates.items():
        if not template.startswith(families):
            continue
        counts["candidates"] += 1
        model = entry.get("model")
        if not model or model in seen:
            continue
        bounds = manifest_bounds.get(model)
        if bounds is None:
            counts["no_model"] += 1
            continue
        seen.add(model)

        extent = _collision_for(vfs, entry.get("appearance"))
        if extent is not None:
            half_x, half_z, height, shape = (
                extent.half_x,
                extent.half_z,
                extent.height,
                extent.shape,
            )
            counts["collision_extent"] += 1
        else:
            half_x = (bounds["max"][0] - bounds["min"][0]) / 2
            half_z = (bounds["max"][2] - bounds["min"][2]) / 2
            height = bounds["max"][1] - bounds["min"][1]
            shape = "bounds"
            counts["render_bounds"] += 1

        props.append(
            Prop(
                template=template,
                model=model,
                name=_readable(template, entry.get("name")),
                half_x=half_x,
                half_z=half_z,
                height=height,
                shape=shape,
            )
        )
    props.sort(key=lambda p: p.name)
    return props, counts


def _collision_for(vfs, appearance: str | None):
    """The appearance's collision extent, if it has one on disk.

    The extent lives in the `.lod`, not the `.msh`, so an appearance that points
    at a mesh is followed to its LOD first. A miss is normal and means "use the
    render bounds", so it is answered with None rather than raised.
    """
    if not appearance:
        return None
    stem = appearance.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    # The .apt is only a pointer -- it parses as IFF but holds no APPR, so it
    # answers None for every object. Returning that first answer meant no prop
    # ever reached its LOD, and all 665 silently fell back to render bounds.
    # Keep looking until something actually has an extent.
    for path in (f"appearance/lod/{stem}.lod", f"appearance/{stem}.lod", appearance):
        raw = vfs.try_read(path) if hasattr(vfs, "try_read") else None
        if not raw:
            continue
        try:
            found = collision_extent(iff.parse(raw))
        except Exception:
            continue
        if found is not None:
            return found
    return None


def write(out: Path, props: list[Prop]) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "count": len(props),
        "props": [
            {
                "template": p.template,
                "model": p.model,
                "name": p.name,
                "halfX": round(p.half_x, 2),
                "halfZ": round(p.half_z, 2),
                "height": round(p.height, 2),
                "shape": p.shape,
                "collides": p.collides,
            }
            for p in props
        ],
        "note": (
            "shape says where the volume came from: 'box'/'sphere'/'cylinder' is "
            "the object's own collision extent, 'bounds' is its render extent "
            "standing in for one, 'mesh'/'cmpt'/'dtal' is a complex shape "
            "reduced outward to a box."
        ),
    }
    out.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return out
