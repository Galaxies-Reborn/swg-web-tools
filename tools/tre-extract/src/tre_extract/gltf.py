"""Minimal glTF 2.0 / GLB writer.

Written by hand rather than pulled from a library because the input is
unusual: geometry arrives as many small primitives that each already own their
vertex buffer, textures are embedded, and the whole thing must land in a single
self-contained ``.glb`` the web viewer can fetch in one request.

Coordinate handedness: SWG is Y-up, Z-forward, left-handed. glTF is Y-up,
Z-backward, right-handed. Negating Z on positions and normals and flipping
triangle winding converts between them; skipping either step yields a model
that renders inside-out or mirrored.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from typing import Any

import numpy as np

GLB_MAGIC = 0x46546C67  # 'glTF'
GLB_VERSION = 2
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

COMPONENT_FLOAT = 5126
COMPONENT_UINT = 5125
COMPONENT_USHORT = 5123

TARGET_ARRAY_BUFFER = 34962
TARGET_ELEMENT_ARRAY_BUFFER = 34963

ALPHA_OPAQUE = "OPAQUE"
ALPHA_MASK = "MASK"
ALPHA_BLEND = "BLEND"


@dataclass(slots=True)
class GltfTexture:
    name: str
    data: bytes
    mime: str


@dataclass(slots=True)
class GltfMaterial:
    name: str
    base_color_texture: str | None = None
    normal_texture: str | None = None
    metallic_roughness_texture: str | None = None
    base_color_factor: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)
    metallic_factor: float = 0.0
    roughness_factor: float = 0.85
    alpha_mode: str = ALPHA_OPAQUE
    alpha_cutoff: float = 0.5
    double_sided: bool = True


@dataclass(slots=True)
class GltfPrimitive:
    positions: np.ndarray  # (n, 3) float32
    indices: np.ndarray  # (m, 3) uint32
    normals: np.ndarray | None = None
    uvs: np.ndarray | None = None
    colors: np.ndarray | None = None  # (n, 4) float32
    material: str | None = None
    #: Skin attributes. Only written when the builder has a skeleton; a
    #: JOINTS_0 without a skin makes the file invalid.
    joints: np.ndarray | None = None  # (n, 4) uint16
    weights: np.ndarray | None = None  # (n, 4) float32


@dataclass(slots=True)
class GltfJoint:
    """One bone of a skin's skeleton, in rest pose."""

    name: str
    parent: int
    translation: tuple[float, float, float]
    rotation: tuple[float, float, float, float]  # x, y, z, w


@dataclass(slots=True)
class GltfAnimationChannel:
    """One animated property of one joint."""

    joint: int
    #: 'rotation' or 'translation'.
    path: str
    #: Key times in seconds, strictly increasing.
    times: np.ndarray
    #: (n, 4) quaternions for rotation, (n, 3) vectors for translation.
    values: np.ndarray


@dataclass(slots=True)
class GltfAnimation:
    name: str
    channels: list[GltfAnimationChannel] = field(default_factory=list)


@dataclass(slots=True)
class GltfSkin:
    joints: list[GltfJoint]
    #: (n, 4, 4) row-major, mapping model space into each joint's local space.
    inverse_bind_matrices: np.ndarray


@dataclass(slots=True)
class GltfHardpoint:
    """A named attachment point, emitted as an empty node.

    glTF has no hardpoint concept, and inventing an extension would mean every
    consumer needing to understand it. An empty node carries exactly the same
    information in the form every loader already reads: three.js finds it with
    `getObjectByName`, and anything added as its child inherits the attachment
    transform for free.
    """

    name: str
    translation: tuple[float, float, float]
    #: Rotation as a glTF-ordered quaternion (x, y, z, w).
    rotation: tuple[float, float, float, float]


@dataclass(slots=True)
class GltfMesh:
    name: str
    primitives: list[GltfPrimitive] = field(default_factory=list)


class GlbBuilder:
    """Accumulates meshes, materials, and textures, then emits one GLB."""

    def __init__(self, *, generator: str = "tre-extract", convert_handedness: bool = True) -> None:
        self._generator = generator
        self._convert = convert_handedness
        self._meshes: list[GltfMesh] = []
        self._materials: dict[str, GltfMaterial] = {}
        self._textures: dict[str, GltfTexture] = {}
        self._skin: GltfSkin | None = None
        self._animations: list[GltfAnimation] = []
        self._hardpoints: list[GltfHardpoint] = []

    # -- population ---------------------------------------------------------

    def add_texture(self, texture: GltfTexture) -> None:
        self._textures.setdefault(texture.name, texture)

    def add_material(self, material: GltfMaterial) -> None:
        self._materials.setdefault(material.name, material)

    def add_mesh(self, mesh: GltfMesh) -> None:
        self._meshes.append(mesh)

    def set_skin(self, skin: GltfSkin) -> None:
        """Attach a skeleton. Skin attributes are only written once this is set."""
        self._skin = skin

    @property
    def has_skin(self) -> bool:
        return self._skin is not None

    def add_hardpoint(self, hardpoint: GltfHardpoint) -> None:
        self._hardpoints.append(hardpoint)

    @property
    def hardpoint_names(self) -> list[str]:
        return [hardpoint.name for hardpoint in self._hardpoints]

    def add_animation(self, animation: GltfAnimation) -> None:
        """Attach a clip. Requires a skin, since channels target its joints."""
        if animation.channels:
            self._animations.append(animation)

    @property
    def animation_count(self) -> int:
        return len(self._animations)

    @property
    def animation_names(self) -> list[str]:
        """Clip names in declaration order, which is the order glTF indexes them."""
        return [animation.name for animation in self._animations]

    @property
    def is_empty(self) -> bool:
        return not any(m.primitives for m in self._meshes)

    def stats(self) -> dict[str, int]:
        triangles = sum(int(p.indices.shape[0]) for m in self._meshes for p in m.primitives)
        vertices = sum(int(p.positions.shape[0]) for m in self._meshes for p in m.primitives)
        return {
            "meshes": len(self._meshes),
            "primitives": sum(len(m.primitives) for m in self._meshes),
            "triangles": triangles,
            "vertices": vertices,
            "materials": len(self._materials),
            "textures": len(self._textures),
        }

    def bounds(self) -> tuple[list[float], list[float]]:
        lo = np.full(3, np.inf, np.float64)
        hi = np.full(3, -np.inf, np.float64)
        for mesh in self._meshes:
            for prim in mesh.primitives:
                if prim.positions.size == 0:
                    continue
                pos = self._orient(prim.positions)
                lo = np.minimum(lo, pos.min(axis=0))
                hi = np.maximum(hi, pos.max(axis=0))
        if not np.isfinite(lo).all():
            return [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
        return lo.tolist(), hi.tolist()

    # -- emission -----------------------------------------------------------

    def build(self) -> bytes:
        buffer = bytearray()
        buffer_views: list[dict[str, Any]] = []
        accessors: list[dict[str, Any]] = []

        def push_view(data: bytes, target: int | None) -> int:
            # glTF requires accessor-aligned views; 4 bytes covers every type
            # used here.
            while len(buffer) % 4:
                buffer.append(0)
            view = {"buffer": 0, "byteOffset": len(buffer), "byteLength": len(data)}
            if target is not None:
                view["target"] = target
            buffer.extend(data)
            buffer_views.append(view)
            return len(buffer_views) - 1

        def push_accessor(
            array: np.ndarray,
            component: int,
            type_name: str,
            target: int | None,
            *,
            with_bounds: bool = False,
        ) -> int:
            contiguous = np.ascontiguousarray(array)
            view = push_view(contiguous.tobytes(), target)
            accessor: dict[str, Any] = {
                "bufferView": view,
                "componentType": component,
                "count": int(contiguous.shape[0]),
                "type": type_name,
            }
            if with_bounds and contiguous.size:
                accessor["min"] = [float(v) for v in contiguous.min(axis=0)]
                accessor["max"] = [float(v) for v in contiguous.max(axis=0)]
            accessors.append(accessor)
            return len(accessors) - 1

        # --- textures and materials
        texture_names = list(self._textures)
        images: list[dict[str, Any]] = []
        samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        textures_json: list[dict[str, Any]] = []
        texture_index = {}
        for i, name in enumerate(texture_names):
            tex = self._textures[name]
            view = push_view(tex.data, None)
            images.append({"name": name, "bufferView": view, "mimeType": tex.mime})
            textures_json.append({"sampler": 0, "source": i})
            texture_index[name] = i

        material_names = list(self._materials)
        material_index = {name: i for i, name in enumerate(material_names)}
        materials_json = [
            self._material_json(self._materials[name], texture_index) for name in material_names
        ]

        # --- meshes
        meshes_json: list[dict[str, Any]] = []
        for mesh in self._meshes:
            primitives_json = []
            for prim in mesh.primitives:
                if prim.indices.size == 0 or prim.positions.size == 0:
                    continue
                attributes: dict[str, int] = {
                    "POSITION": push_accessor(
                        self._orient(prim.positions).astype(np.float32),
                        COMPONENT_FLOAT,
                        "VEC3",
                        TARGET_ARRAY_BUFFER,
                        with_bounds=True,
                    )
                }
                if prim.normals is not None:
                    attributes["NORMAL"] = push_accessor(
                        _normalize(self._orient(prim.normals)).astype(np.float32),
                        COMPONENT_FLOAT,
                        "VEC3",
                        TARGET_ARRAY_BUFFER,
                    )
                if prim.uvs is not None:
                    attributes["TEXCOORD_0"] = push_accessor(
                        np.ascontiguousarray(prim.uvs, dtype=np.float32),
                        COMPONENT_FLOAT,
                        "VEC2",
                        TARGET_ARRAY_BUFFER,
                    )
                if prim.colors is not None:
                    attributes["COLOR_0"] = push_accessor(
                        np.ascontiguousarray(prim.colors, dtype=np.float32),
                        COMPONENT_FLOAT,
                        "VEC4",
                        TARGET_ARRAY_BUFFER,
                    )
                # Skin attributes are only valid alongside a skin; writing
                # them without one produces a file strict loaders reject.
                if self._skin is not None and prim.joints is not None and prim.weights is not None:
                    attributes["JOINTS_0"] = push_accessor(
                        np.ascontiguousarray(prim.joints, dtype=np.uint16),
                        COMPONENT_USHORT,
                        "VEC4",
                        TARGET_ARRAY_BUFFER,
                    )
                    attributes["WEIGHTS_0"] = push_accessor(
                        np.ascontiguousarray(prim.weights, dtype=np.float32),
                        COMPONENT_FLOAT,
                        "VEC4",
                        TARGET_ARRAY_BUFFER,
                    )

                tris = prim.indices
                if self._convert:
                    tris = tris[:, [0, 2, 1]]
                vertex_count = int(prim.positions.shape[0])
                if vertex_count <= 65535:
                    index_array = tris.astype(np.uint16).reshape(-1)
                    component = COMPONENT_USHORT
                else:
                    index_array = tris.astype(np.uint32).reshape(-1)
                    component = COMPONENT_UINT
                index_accessor = push_accessor(
                    index_array.reshape(-1, 1),
                    component,
                    "SCALAR",
                    TARGET_ELEMENT_ARRAY_BUFFER,
                )
                # SCALAR accessors are counted in elements, and reshaping to
                # (n, 1) above already gives the right count.

                primitive_json: dict[str, Any] = {
                    "attributes": attributes,
                    "indices": index_accessor,
                    "mode": 4,
                }
                if prim.material and prim.material in material_index:
                    primitive_json["material"] = material_index[prim.material]
                primitives_json.append(primitive_json)

            if primitives_json:
                meshes_json.append({"name": mesh.name, "primitives": primitives_json})

        # --- skin
        # Joint nodes come first so mesh nodes can reference them by index
        # without a second pass.
        nodes: list[dict[str, Any]] = []
        skins_json: list[dict[str, Any]] = []
        skin_index: int | None = None

        if self._skin is not None and self._skin.joints:
            joint_base = 0
            for joint in self._skin.joints:
                node: dict[str, Any] = {"name": joint.name}
                translation = self._orient_point(joint.translation)
                if any(translation):
                    node["translation"] = list(translation)
                rotation = self._orient_quaternion(joint.rotation)
                if rotation != (0.0, 0.0, 0.0, 1.0):
                    node["rotation"] = list(rotation)
                nodes.append(node)

            for index, joint in enumerate(self._skin.joints):
                if joint.parent >= 0:
                    parent = nodes[joint_base + joint.parent]
                    parent.setdefault("children", []).append(joint_base + index)

            # Derive the inverse bind matrices from the joint nodes as written,
            # not from the source skeleton. The nodes have been mirrored for
            # handedness; matrices built in the original space would not cancel
            # against them, which shows up only once a skin is actually posed —
            # an unposed model draws its bind vertices directly and looks fine.
            inverse_bind = _inverse_bind_from_nodes(nodes, self._skin.joints)
            matrices = np.ascontiguousarray(
                # glTF matrices are column-major; numpy builds them row-major.
                inverse_bind.transpose(0, 2, 1),
                dtype=np.float32,
            ).reshape(-1, 16)
            ibm_accessor = push_accessor(matrices, COMPONENT_FLOAT, "MAT4", None)

            roots = [i for i, j in enumerate(self._skin.joints) if j.parent < 0]
            skins_json.append(
                {
                    "joints": list(range(len(self._skin.joints))),
                    "inverseBindMatrices": ibm_accessor,
                    **({"skeleton": roots[0]} if roots else {}),
                }
            )
            skin_index = 0

        mesh_node_start = len(nodes)
        for i, m in enumerate(meshes_json):
            node = {"name": m["name"], "mesh": i}
            if skin_index is not None:
                # A node with a skin must not inherit a transform from a joint,
                # so mesh nodes stay at the scene root.
                node["skin"] = skin_index
            nodes.append(node)

        # Hardpoints are scene-root children like the meshes: they are defined
        # in the appearance's own space, so nesting them under a mesh node
        # would apply that node's transform to them twice. They are appended
        # before scene_roots is taken, so they land in the scene alongside the
        # meshes rather than needing a range of their own.
        for hardpoint in self._hardpoints:
            nodes.append(
                {
                    "name": hardpoint.name,
                    "translation": list(hardpoint.translation),
                    "rotation": list(hardpoint.rotation),
                    # Marked so a consumer can tell an attachment point from an
                    # ordinary empty without matching on names.
                    "extras": {"hardpoint": True},
                }
            )

        scene_roots = list(range(mesh_node_start, len(nodes)))
        if self._skin is not None and self._skin.joints:
            scene_roots += [i for i, j in enumerate(self._skin.joints) if j.parent < 0]

        # --- animations
        # Channels target joint nodes, which are the first nodes emitted, so
        # a joint index is also its node index.
        animations_json: list[dict[str, Any]] = []
        if self._skin is not None:
            for animation in self._animations:
                # Deliberately not named `samplers`: that name already holds the
                # texture sampler list this function emits at the top level, and
                # rebinding it here left every animated, textured model claiming
                # its animation samplers were texture samplers — so each
                # `textures[].sampler` index pointed at an object with
                # input/output instead of magFilter/wrapS.
                clip_samplers: list[dict[str, Any]] = []
                channels_json: list[dict[str, Any]] = []
                for channel in animation.channels:
                    if channel.times.size == 0 or channel.joint >= len(self._skin.joints):
                        continue
                    time_accessor = push_accessor(
                        np.ascontiguousarray(channel.times, np.float32).reshape(-1, 1),
                        COMPONENT_FLOAT,
                        "SCALAR",
                        None,
                        # glTF requires min/max on an animation input, so a
                        # viewer can size the timeline without reading it all.
                        with_bounds=True,
                    )
                    value_accessor = push_accessor(
                        np.ascontiguousarray(channel.values, np.float32),
                        COMPONENT_FLOAT,
                        "VEC4" if channel.path == "rotation" else "VEC3",
                        None,
                    )
                    clip_samplers.append(
                        {
                            "input": time_accessor,
                            "output": value_accessor,
                            "interpolation": "LINEAR",
                        }
                    )
                    channels_json.append(
                        {
                            "sampler": len(clip_samplers) - 1,
                            "target": {"node": channel.joint, "path": channel.path},
                        }
                    )
                if channels_json:
                    animations_json.append(
                        {
                            "name": animation.name,
                            "samplers": clip_samplers,
                            "channels": channels_json,
                        }
                    )

        gltf: dict[str, Any] = {
            "asset": {"version": "2.0", "generator": self._generator},
            "scene": 0,
            "scenes": [{"nodes": scene_roots}],
            "nodes": nodes,
            "meshes": meshes_json,
            "accessors": accessors,
            "bufferViews": buffer_views,
            "buffers": [{"byteLength": len(buffer)}],
        }
        if materials_json:
            gltf["materials"] = materials_json
        if skins_json:
            gltf["skins"] = skins_json
        if animations_json:
            gltf["animations"] = animations_json
        if images:
            gltf["images"] = images
            gltf["samplers"] = samplers
            gltf["textures"] = textures_json

        return _pack_glb(gltf, bytes(buffer))

    # -- helpers ------------------------------------------------------------

    def _orient(self, array: np.ndarray) -> np.ndarray:
        if not self._convert:
            return array
        out = np.array(array, dtype=np.float64, copy=True)
        out[:, 2] *= -1.0
        return out

    def _orient_point(self, point: tuple[float, float, float]) -> tuple[float, float, float]:
        if not self._convert:
            return point
        return (point[0], point[1], -point[2])

    def _orient_quaternion(
        self, quaternion: tuple[float, float, float, float]
    ) -> tuple[float, float, float, float]:
        """Mirror a rotation through the XY plane, to match negating Z.

        Reflecting an axis flips the sense of rotation about the two axes that
        remain, so x and y negate while z and w do not. Negating the whole
        quaternion instead — the obvious guess — is a no-op, because q and -q
        describe the same rotation.
        """
        if not self._convert:
            return quaternion
        x, y, z, w = quaternion
        return (-x, -y, z, w)

    @staticmethod
    def _material_json(
        material: GltfMaterial, texture_index: dict[str, int]
    ) -> dict[str, Any]:
        pbr: dict[str, Any] = {
            "baseColorFactor": list(material.base_color_factor),
            "metallicFactor": material.metallic_factor,
            "roughnessFactor": material.roughness_factor,
        }
        if material.base_color_texture and material.base_color_texture in texture_index:
            pbr["baseColorTexture"] = {"index": texture_index[material.base_color_texture]}
        if (
            material.metallic_roughness_texture
            and material.metallic_roughness_texture in texture_index
        ):
            pbr["metallicRoughnessTexture"] = {
                "index": texture_index[material.metallic_roughness_texture]
            }

        out: dict[str, Any] = {
            "name": material.name,
            "pbrMetallicRoughness": pbr,
            "doubleSided": material.double_sided,
        }
        if material.normal_texture and material.normal_texture in texture_index:
            out["normalTexture"] = {"index": texture_index[material.normal_texture]}
        if material.alpha_mode != ALPHA_OPAQUE:
            out["alphaMode"] = material.alpha_mode
            if material.alpha_mode == ALPHA_MASK:
                out["alphaCutoff"] = material.alpha_cutoff
        return out


def _inverse_bind_from_nodes(
    nodes: list[dict[str, Any]], joints: list[GltfJoint]
) -> np.ndarray:
    """Inverse of each joint's rest world matrix, taken from the emitted nodes.

    Building these from the same TRS values the file carries is what guarantees
    they cancel: any transform applied to the joints — the handedness mirror,
    most of all — is then already baked into both sides.
    """
    world = np.zeros((len(joints), 4, 4), np.float64)
    for index, joint in enumerate(joints):
        node = nodes[index]
        local = np.identity(4, np.float64)
        local[:3, :3] = _quaternion_matrix(node.get("rotation", [0.0, 0.0, 0.0, 1.0]))
        local[:3, 3] = node.get("translation", [0.0, 0.0, 0.0])
        # Parents always precede their children in these skeletons.
        world[index] = local if joint.parent < 0 else world[joint.parent] @ local
    return np.linalg.inv(world)


def _quaternion_matrix(q: list[float] | tuple[float, ...]) -> np.ndarray:
    x, y, z, w = q
    norm = (x * x + y * y + z * z + w * w) ** 0.5
    if norm > 0:
        x, y, z, w = x / norm, y / norm, z / norm, w / norm
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def _normalize(vectors: np.ndarray) -> np.ndarray:
    lengths = np.linalg.norm(vectors, axis=1, keepdims=True)
    # Degenerate normals show up in a few exported assets; leaving them as
    # zeros makes lighting NaN, so point them up instead.
    safe = np.where(lengths > 1e-8, lengths, 1.0)
    out = vectors / safe
    out[lengths[:, 0] <= 1e-8] = (0.0, 1.0, 0.0)
    return out


def _pack_glb(gltf: dict[str, Any], binary: bytes) -> bytes:
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)
    bin_bytes = binary + b"\0" * (-len(binary) % 4)

    total = 12 + 8 + len(json_bytes) + (8 + len(bin_bytes) if bin_bytes else 0)
    out = bytearray()
    out += struct.pack("<III", GLB_MAGIC, GLB_VERSION, total)
    out += struct.pack("<II", len(json_bytes), CHUNK_JSON)
    out += json_bytes
    if bin_bytes:
        out += struct.pack("<II", len(bin_bytes), CHUNK_BIN)
        out += bin_bytes
    return bytes(out)
