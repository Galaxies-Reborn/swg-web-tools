"""What is already standing where a player wants to build.

The world snapshot lists everything the client draws on a planet, which is
thousands of objects and mostly not obstacles: loose weapons, chairs, sound
emitters, litter. A planner wants the things a city has to go around, so this
reduces the snapshot to those and writes them out per planet.

Three filters, each for a reason rather than for tidiness:

  * Contained objects are dropped. A chair inside a cantina has coordinates in
    the cantina's space, so treating it as a world position puts furniture on a
    hillside a kilometre away.
  * Sound objects are dropped. They have a position and no substance.
  * Anything under a metre across is dropped. That is the carbine lying in the
    sand, and there are more of those than there are buildings.

What survives keeps its real footprint, taken from the converted model's own
bounds rather than from the snapshot's `radius` -- that field is the server's
network update range and runs to hundreds of metres for a fence post.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from .formats.snapshot import read as read_snapshot

#: Below this the object is scenery rather than an obstacle.
MIN_FOOTPRINT_METRES = 1.0

#: Template families that never block, whatever their size.
_IGNORED_PREFIXES = ("object/soundobject/",)


@dataclass(frozen=True)
class Blocker:
    template: str
    model: str | None
    x: float
    z: float
    yaw: float
    #: Half-extents in metres, from the model's own bounds, yaw not applied.
    half_x: float
    half_z: float
    height: float


def _unshared(path: str) -> str:
    """Snapshot paths name the CLIENT template; the index keys the server one.

    Only the file name carries the prefix, so the directory is rejoined as it
    was -- and a path with no directory keeps none, rather than gaining a
    leading slash that would match nothing.
    """
    head, sep, base = path.rpartition("/")
    if not base.startswith("shared_"):
        return path
    return f"{head}{sep}{base[7:]}"


def collect(
    snapshot_bytes: bytes,
    templates: dict,
    manifest_bounds: dict,
) -> tuple[list[Blocker], dict[str, int]]:
    blockers: list[Blocker] = []
    counts = {"records": 0, "outdoors": 0, "unresolved": 0, "no_model": 0, "too_small": 0}

    for obj in read_snapshot(snapshot_bytes):
        counts["records"] += 1
        if not obj.is_outdoors:
            continue
        if obj.template.startswith(_IGNORED_PREFIXES):
            continue
        counts["outdoors"] += 1

        entry = templates.get(_unshared(obj.template))
        if entry is None:
            counts["unresolved"] += 1
            continue
        model = entry.get("model")
        bounds = manifest_bounds.get(model) if model else None
        if bounds is None:
            counts["no_model"] += 1
            continue

        half_x = (bounds["max"][0] - bounds["min"][0]) / 2
        half_z = (bounds["max"][2] - bounds["min"][2]) / 2
        height = bounds["max"][1] - bounds["min"][1]
        if max(half_x, half_z) * 2 < MIN_FOOTPRINT_METRES:
            counts["too_small"] += 1
            continue

        blockers.append(
            Blocker(
                template=obj.template,
                model=model,
                x=obj.x,
                z=obj.z,
                yaw=obj.yaw,
                half_x=half_x,
                half_z=half_z,
                height=height,
            )
        )
    return blockers, counts


def write(out_dir: Path, planet: str, blockers: list[Blocker]) -> Path:
    """One file per planet, as parallel arrays.

    Arrays rather than objects because this is a few thousand rows of numbers
    and the key names would be most of the bytes. Coordinates are rounded to a
    decimetre and angles to a milliradian: finer than that is below what a plan
    view can show, and it roughly halves the file.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    models: list[str] = []
    index: dict[str, int] = {}
    xs: list[float] = []
    zs: list[float] = []
    yaws: list[float] = []
    hx: list[float] = []
    hz: list[float] = []
    hy: list[float] = []

    for blocker in blockers:
        key = blocker.model or ""
        if key not in index:
            index[key] = len(models)
            models.append(key)
        xs.append(round(blocker.x, 1))
        zs.append(round(blocker.z, 1))
        yaws.append(round(blocker.yaw, 3))
        hx.append(round(blocker.half_x, 2))
        hz.append(round(blocker.half_z, 2))
        hy.append(round(blocker.height, 1))

    payload = {
        "planet": planet,
        "count": len(blockers),
        "models": models,
        "model": [index[b.model or ""] for b in blockers],
        "x": xs,
        "z": zs,
        "yaw": yaws,
        "halfX": hx,
        "halfZ": hz,
        "height": hy,
        "note": (
            "Footprints are the converted model's own bounds. The snapshot's "
            "radius field is a network update range, not a size, and is not used."
        ),
    }
    path = out_dir / f"{planet}.json"
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


def load_indexes(assets: Path) -> tuple[dict, dict]:
    """The two lookups a snapshot needs to become a list of obstacles."""
    templates = json.loads((assets / "templates.json").read_text(encoding="utf-8"))
    entries = templates.get("entries", templates)

    manifest = json.loads((assets / "manifest.json").read_text(encoding="utf-8"))
    bounds = {
        entry["key"]: entry["bounds"]
        for entry in manifest.get("entries", [])
        if isinstance(entry, dict) and entry.get("key") and entry.get("bounds")
    }
    return entries, bounds


def footprint_radius(blocker: Blocker) -> float:
    """A single radius, for callers that want a circle rather than a box."""
    return math.hypot(blocker.half_x, blocker.half_z)
