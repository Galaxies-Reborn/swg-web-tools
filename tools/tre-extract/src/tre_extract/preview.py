"""Render a converted GLB to a PNG, without a browser or a GPU.

Existing checks prove a model is *structurally* valid: the header is
self-consistent, every accessor sits inside its buffer view, the bounds are
plausible. None of that catches geometry that parses cleanly and looks wrong —
inverted winding, sheared UVs, a mesh turned inside out by a half-applied
handedness conversion.

This is a small software rasteriser so `preview` can answer the only question
that matters: does the thing look like what it claims to be. It is a
verification tool, not part of the web pipeline.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

GLB_MAGIC = 0x46546C67
_COMPONENT_DTYPE = {
    5120: "<i1",
    5121: "<u1",
    5122: "<i2",
    5123: "<u2",
    5125: "<u4",
    5126: "<f4",
}
_TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class PreviewError(Exception):
    pass


@dataclass(slots=True)
class LoadedMesh:
    positions: np.ndarray  # (n, 3)
    normals: np.ndarray | None
    triangles: np.ndarray  # (m, 3)
    joints: np.ndarray | None = None  # (n, 4) uint16
    weights: np.ndarray | None = None  # (n, 4) float32


def read_glb(path: str | Path) -> tuple[dict, bytes]:
    blob = Path(path).read_bytes()
    if len(blob) < 20:
        raise PreviewError("file is too short to be a GLB")
    magic, version, total = struct.unpack_from("<III", blob, 0)
    if magic != GLB_MAGIC:
        raise PreviewError(f"bad magic {magic:#010x}")
    if total != len(blob):
        raise PreviewError(f"header declares {total} bytes, file is {len(blob)}")

    offset = 12
    gltf: dict | None = None
    binary = b""
    while offset + 8 <= len(blob):
        length, kind = struct.unpack_from("<II", blob, offset)
        payload = blob[offset + 8 : offset + 8 + length]
        if kind == 0x4E4F534A:
            gltf = json.loads(payload)
        elif kind == 0x004E4942:
            binary = payload
        offset += 8 + length

    if gltf is None:
        raise PreviewError("no JSON chunk")
    _ = version
    return gltf, binary


def _accessor(gltf: dict, binary: bytes, index: int) -> np.ndarray:
    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    dtype = _COMPONENT_DTYPE[accessor["componentType"]]
    components = _TYPE_COUNT[accessor["type"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"] * components
    return np.frombuffer(binary, dtype=dtype, count=count, offset=start).reshape(
        accessor["count"], components
    )


def load_meshes(gltf: dict, binary: bytes) -> list[LoadedMesh]:
    out: list[LoadedMesh] = []
    for mesh in gltf.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            attributes = primitive.get("attributes", {})
            if "POSITION" not in primitive.get("attributes", {}):
                continue
            positions = _accessor(gltf, binary, attributes["POSITION"]).astype(np.float64)
            normals = (
                _accessor(gltf, binary, attributes["NORMAL"]).astype(np.float64)
                if "NORMAL" in attributes
                else None
            )
            if "indices" not in primitive:
                continue
            indices = _accessor(gltf, binary, primitive["indices"]).reshape(-1).astype(np.int64)
            usable = (indices.size // 3) * 3
            joints = (
                _accessor(gltf, binary, attributes["JOINTS_0"]).astype(np.int64)
                if "JOINTS_0" in attributes
                else None
            )
            weights = (
                _accessor(gltf, binary, attributes["WEIGHTS_0"]).astype(np.float64)
                if "WEIGHTS_0" in attributes
                else None
            )
            out.append(
                LoadedMesh(positions, normals, indices[:usable].reshape(-1, 3), joints, weights)
            )
    return out


# --- posing ----------------------------------------------------------------


def _quat_to_matrix(q) -> np.ndarray:
    x, y, z, w = q
    n = (x * x + y * y + z * z + w * w) ** 0.5
    if n > 0:
        x, y, z, w = x / n, y / n, z / n, w / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0.0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0.0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )


def _sample(times: np.ndarray, values: np.ndarray, t: float) -> np.ndarray:
    if times.size == 0:
        return values[0] if values.size else np.zeros(values.shape[1])
    if t <= times[0]:
        return values[0]
    if t >= times[-1]:
        return values[-1]
    i = int(np.searchsorted(times, t))
    span = times[i] - times[i - 1]
    a = 0.0 if span <= 0 else float((t - times[i - 1]) / span)
    return values[i - 1] + (values[i] - values[i - 1]) * a


def pose_meshes(
    gltf: dict, binary: bytes, meshes: list[LoadedMesh], animation_index: int, time: float
) -> list[LoadedMesh]:
    """Apply an animation clip at `time` and return CPU-skinned meshes.

    This is the check that structural validation cannot make: an animation can
    decode cleanly, target real joints, and still tear the model apart if the
    joint remap, the handedness mirror, or the bind matrices are wrong.
    """
    skins = gltf.get("skins", [])
    animations = gltf.get("animations", [])
    if not skins or animation_index >= len(animations):
        return meshes

    skin = skins[0]
    joint_nodes = skin["joints"]
    nodes = gltf["nodes"]

    # Start from each joint's rest transform.
    local_t = {}
    local_r = {}
    for node_index in joint_nodes:
        node = nodes[node_index]
        local_t[node_index] = np.array(node.get("translation", [0.0, 0.0, 0.0]), np.float64)
        local_r[node_index] = np.array(node.get("rotation", [0.0, 0.0, 0.0, 1.0]), np.float64)

    # Overlay the clip.
    clip = animations[animation_index]
    for channel in clip["channels"]:
        sampler = clip["samplers"][channel["sampler"]]
        target = channel["target"]["node"]
        if target not in local_t:
            continue
        times = _accessor(gltf, binary, sampler["input"]).reshape(-1).astype(np.float64)
        values = _accessor(gltf, binary, sampler["output"]).astype(np.float64)
        sampled = _sample(times, values, time)
        if channel["target"]["path"] == "rotation":
            local_r[target] = sampled
        else:
            local_t[target] = sampled

    # Accumulate to world.
    parent_of = {}
    for node_index in joint_nodes:
        for child in nodes[node_index].get("children", []):
            parent_of[child] = node_index

    world = {}

    def resolve(node_index):
        if node_index in world:
            return world[node_index]
        matrix = _quat_to_matrix(local_r[node_index])
        matrix[:3, 3] = local_t[node_index]
        parent = parent_of.get(node_index)
        world[node_index] = matrix if parent is None else resolve(parent) @ matrix
        return world[node_index]

    joint_world = np.stack([resolve(n) for n in joint_nodes])

    inverse_bind = _accessor(gltf, binary, skin["inverseBindMatrices"]).astype(np.float64)
    # glTF stores matrices column-major.
    inverse_bind = inverse_bind.reshape(-1, 4, 4).transpose(0, 2, 1)
    skinning = joint_world @ inverse_bind

    posed: list[LoadedMesh] = []
    for mesh in meshes:
        if mesh.joints is None or mesh.weights is None:
            posed.append(mesh)
            continue
        points = np.concatenate(
            [mesh.positions, np.ones((mesh.positions.shape[0], 1))], axis=1
        )
        out = np.zeros((points.shape[0], 3))
        for slot in range(mesh.joints.shape[1]):
            w = mesh.weights[:, slot]
            if not np.any(w):
                continue
            matrices = skinning[np.clip(mesh.joints[:, slot], 0, len(joint_nodes) - 1)]
            transformed = np.einsum("nij,nj->ni", matrices, points)[:, :3]
            out += transformed * w[:, None]
        posed.append(LoadedMesh(out, mesh.normals, mesh.triangles))
    return posed


def render(
    path: str | Path,
    size: int = 512,
    *,
    azimuth: float = 35.0,
    elevation: float = 20.0,
    animation: int | None = None,
    time: float = 0.0,
) -> Image.Image:
    """Rasterise a GLB from a three-quarter view with simple diffuse shading.

    Pass `animation` to pose the model with that clip at `time` seconds first.
    """
    gltf, binary = read_glb(path)
    meshes = load_meshes(gltf, binary)
    if not meshes:
        raise PreviewError("no renderable primitives")

    if animation is not None:
        meshes = pose_meshes(gltf, binary, meshes, animation, time)

    everything = np.concatenate([m.positions for m in meshes])
    centre = (everything.min(axis=0) + everything.max(axis=0)) / 2
    extent = float(np.max(everything.max(axis=0) - everything.min(axis=0))) or 1.0

    # Orbit the camera; the model stays put.
    a = np.radians(azimuth)
    e = np.radians(elevation)
    forward = np.array([np.cos(e) * np.sin(a), np.sin(e), np.cos(e) * np.cos(a)])
    right = np.array([np.cos(a), 0.0, -np.sin(a)])
    up = np.cross(forward, right)

    colour = np.zeros((size, size, 3), np.float32)
    depth = np.full((size, size), np.inf)
    # Light from over the camera's shoulder, so shading reads as shape.
    light = forward * 0.6 + up * 0.7 + right * 0.4
    light /= np.linalg.norm(light)

    for mesh in meshes:
        local = mesh.positions - centre
        screen_x = local @ right
        screen_y = local @ up
        view_depth = local @ forward

        # Orthographic: a perspective divide adds nothing to a shape check and
        # one more way to be wrong.
        scale = size / (extent * 1.25)
        px = (screen_x * scale + size / 2).astype(np.float64)
        py = (size / 2 - screen_y * scale).astype(np.float64)

        if mesh.normals is not None:
            shading = np.clip(mesh.normals @ light, 0.0, 1.0) * 0.75 + 0.25
        else:
            shading = np.full(len(local), 0.7)

        _rasterise(colour, depth, px, py, view_depth, shading, mesh.triangles)

    # A mid-grey background keeps both dark and light geometry legible.
    background = colour.sum(axis=2) == 0
    colour[background] = 0.09
    return Image.fromarray((np.clip(colour, 0, 1) * 255).astype(np.uint8))


def _rasterise(
    colour: np.ndarray,
    depth: np.ndarray,
    px: np.ndarray,
    py: np.ndarray,
    pz: np.ndarray,
    shading: np.ndarray,
    triangles: np.ndarray,
) -> None:
    size = colour.shape[0]
    for tri in triangles:
        i0, i1, i2 = tri
        x0, y0, z0 = px[i0], py[i0], pz[i0]
        x1, y1, z1 = px[i1], py[i1], pz[i1]
        x2, y2, z2 = px[i2], py[i2], pz[i2]

        min_x = max(int(np.floor(min(x0, x1, x2))), 0)
        max_x = min(int(np.ceil(max(x0, x1, x2))), size - 1)
        min_y = max(int(np.floor(min(y0, y1, y2))), 0)
        max_y = min(int(np.ceil(max(y0, y1, y2))), size - 1)
        if min_x > max_x or min_y > max_y:
            continue

        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area) < 1e-9:
            continue

        ys, xs = np.mgrid[min_y : max_y + 1, min_x : max_x + 1]
        xs = xs + 0.5
        ys = ys + 0.5

        w0 = ((x1 - xs) * (y2 - ys) - (x2 - xs) * (y1 - ys)) / area
        w1 = ((x2 - xs) * (y0 - ys) - (x0 - xs) * (y2 - ys)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue

        z = w0 * z0 + w1 * z1 + w2 * z2
        shade = w0 * shading[i0] + w1 * shading[i1] + w2 * shading[i2]

        window = depth[min_y : max_y + 1, min_x : max_x + 1]
        # Smaller view depth is nearer the camera.
        visible = inside & (z < window)
        if not visible.any():
            continue
        window[visible] = z[visible]
        target = colour[min_y : max_y + 1, min_x : max_x + 1]
        target[visible] = np.clip(shade[visible], 0, 1)[:, None]


def contact_sheet(paths: list[Path], cell: int = 256, columns: int = 4) -> Image.Image:
    """Render several models into one grid, for eyeballing a whole category."""
    rendered: list[tuple[Path, Image.Image]] = []
    for path in paths:
        try:
            rendered.append((path, render(path, size=cell)))
        except (PreviewError, ValueError, KeyError):
            continue
    if not rendered:
        raise PreviewError("nothing rendered")

    rows = (len(rendered) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell, rows * cell), (14, 17, 23))
    for index, (_, image) in enumerate(rendered):
        sheet.paste(image, ((index % columns) * cell, (index // columns) * cell))
    return sheet


def check_normals(path: str | Path) -> tuple[int, int]:
    """Count triangles whose winding agrees with their stored vertex normals.

    This is the check that catches a half-applied handedness conversion.
    Negating Z on positions without flipping triangle winding — or flipping
    winding without negating the normals — leaves a model that renders as a
    recognisable silhouette but lights as though lit from inside. Agreement
    should be at or very near 100%; anything lower means the two halves of the
    conversion have drifted apart.

    Returns `(agreeing, total)`.
    """
    gltf, binary = read_glb(path)
    agreeing = total = 0

    for mesh in load_meshes(gltf, binary):
        if mesh.normals is None:
            continue
        points = mesh.positions
        tris = mesh.triangles

        edge1 = points[tris[:, 1]] - points[tris[:, 0]]
        edge2 = points[tris[:, 2]] - points[tris[:, 0]]
        geometric = np.cross(edge1, edge2)
        geometric = _unit(geometric)

        stored = _unit(
            (mesh.normals[tris[:, 0]] + mesh.normals[tris[:, 1]] + mesh.normals[tris[:, 2]]) / 3
        )

        agreeing += int(((geometric * stored).sum(axis=1) > 0).sum())
        total += len(tris)

    return agreeing, total


def _unit(vectors: np.ndarray) -> np.ndarray:
    lengths = np.linalg.norm(vectors, axis=1, keepdims=True)
    lengths[lengths == 0] = 1.0
    return vectors / lengths


def animation_strip(
    path: str | Path,
    clip_name: str,
    *,
    cell: int = 300,
    frames: int = 6,
) -> Image.Image:
    """Render one model across a clip's timeline, left to right.

    A rigged model that exports cleanly can still tear apart the moment it is
    posed: an unposed model draws its bind vertices and never exercises the
    skin at all, so a wrong inverse bind matrix is invisible until something
    plays. Sampling across the clip is the only check that catches that.
    """
    gltf, _ = read_glb(path)
    clips = gltf.get("animations", [])
    names = [clip.get("name", "") for clip in clips]
    if clip_name not in names:
        raise PreviewError(f"no clip named {clip_name!r}; this model has {names or 'none'}")
    index = names.index(clip_name)

    # A clip runs as long as its longest channel. Sampler inputs carry their
    # own max, so the duration needs no decoding of the buffer.
    ends = [
        gltf["accessors"][sampler["input"]].get("max", [0.0])[0]
        for sampler in clips[index]["samplers"]
    ]
    duration = max(ends) if ends else 0.0
    if duration <= 0:
        raise PreviewError(f"{clip_name!r} has no duration")

    count = max(1, frames)
    sheet = Image.new("RGB", (cell * count, cell), (14, 17, 23))
    for i in range(count):
        # Stop short of `duration` itself: on a looping clip the last frame
        # equals the first, which wastes a cell.
        posed = render(path, size=cell, animation=index, time=duration * i / count)
        sheet.paste(posed, (i * cell, 0))
    return sheet
