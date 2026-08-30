"""Turn an appearance reference into a self-contained GLB plus a manifest row."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .animate import build_animation, coverage
from .formats.animation import read_animation
from .formats.appearance import AppearanceResolver, ResolvedAppearance
from .formats.hardpoint import Hardpoint, dedupe, read_hardpoints
from .formats.mesh import Primitive, StaticMesh, read_mesh
from .formats.shader import ShaderTemplate, read_shader
from .formats.skeleton import Skeleton, read_skeleton
from .formats.skinned import read_skinned_mesh
from .formats.texture import (
    TextureError,
    TextureOptions,
    decode,
    encode,
    normal_map_to_rgb,
    output_stem,
)
from .gltf import (
    ALPHA_BLEND,
    ALPHA_MASK,
    ALPHA_OPAQUE,
    GlbBuilder,
    GltfHardpoint,
    GltfJoint,
    GltfMaterial,
    GltfMesh,
    GltfPrimitive,
    GltfSkin,
    GltfTexture,
)
from .vfs import AssetVfs


@dataclass(slots=True)
class ConvertOptions:
    #: Animation clips to attach, as VFS paths. Only those whose bones match
    #: the model's skeleton are used.
    animations: tuple[str, ...] = ()
    #: Minimum correspondence between a clip and a skeleton before the clip is
    #: accepted, measured in both directions — see `animate.coverage`. Checking
    #: only that a clip's bones exist lets a two-bone clip bind to anything.
    animation_coverage: float = 0.5
    #: Most clips to bake into one model, 0 for no cap. Clips are not shared
    #: between GLBs, so every one is paid for per asset: thirteen humanoid
    #: clips on each of 4,748 wearables cost 1.7 GB of near-duplicate data.
    animation_limit: int = 6
    textures: TextureOptions = field(default_factory=TextureOptions)
    #: Skip textures entirely. Useful for a fast geometry-only pass.
    include_textures: bool = True
    #: Reconstruct normal maps from SWG's DXT5 swizzle. Costs a numpy pass per
    #: texture; worth it because the naive copy inverts lighting.
    fix_normal_maps: bool = True
    convert_handedness: bool = True


@dataclass(slots=True)
class ConvertResult:
    key: str
    glb: bytes
    bounds_min: list[float]
    bounds_max: list[float]
    triangles: int
    vertices: int
    materials: int
    textures: int
    lod_count: int
    kind: str
    #: Clip names baked into the GLB, in declaration order. Surfaced in the
    #: manifest so a viewer can list what a model can play without fetching it.
    animations: list[str] = field(default_factory=list)
    #: Named attachment points emitted as empty nodes. Surfaced in the manifest
    #: so a tool can tell whether a model can carry an attachment before
    #: downloading it.
    hardpoints: list[str] = field(default_factory=list)
    #: Palette-driven colour channels from the model's customisable shaders.
    hue: list[dict] = field(default_factory=list)
    #: Swappable texture sets -- the ship's patterns -- as
    #: {variable, textureTag, options:[{base, mask}]}, naming files written
    #: beside the models rather than embedded in the GLB, because they are
    #: alternatives only one of which is shown at a time.
    pattern: list[dict] = field(default_factory=list)
    #: Pattern texture blobs to write out: filename -> bytes.
    pattern_files: dict[str, bytes] = field(default_factory=dict)
    #: Source paths that could not be read; empty on a clean conversion.
    warnings: list[str] = field(default_factory=list)


class Converter:
    """Converts appearances to GLB, sharing texture work across a whole run."""

    def __init__(
        self,
        vfs: AssetVfs,
        options: ConvertOptions | None = None,
    ) -> None:
        self._vfs = vfs
        self._options = options or ConvertOptions()
        self._resolver = AppearanceResolver(vfs)
        self._shader_cache: dict[str, ShaderTemplate | None] = {}
        self._skeleton_cache: dict[str, Skeleton | None] = {}
        self._animation_cache: dict[str, object] = {}
        #: Skeleton of the model currently being built, for animation binding.
        self._last_skeleton: Skeleton | None = None
        self._texture_cache: dict[str, GltfTexture | None] = {}
        #: Hue channels for the model currently being built, keyed by variable.
        self._hue: dict[str, dict] = {}
        #: Pattern channels for the model currently being built.
        self._pattern: dict[str, dict] = {}
        #: Pattern textures written beside the models, filename -> bytes.
        self._pattern_files: dict[str, bytes] = {}
        #: Every palette any converted shader referenced, so they can be dumped
        #: alongside the manifest for the web tools.
        self._palettes_seen: set[str] = set()
        self.stats = {
            "appearances": 0,
            "meshes": 0,
            "skinned": 0,
            "rigged": 0,
            "animations": 0,
            "textures_encoded": 0,
            "texture_bytes": 0,
        }

    def resolve(self, appearance: str) -> ResolvedAppearance:
        return self._resolver.resolve(appearance)

    def convert(self, appearance: str) -> ConvertResult | None:
        """Build a GLB for one appearance, or None when it has no geometry."""
        resolved = self._resolver.resolve(appearance)
        if resolved.is_empty:
            return None

        builder = GlbBuilder(convert_handedness=self._options.convert_handedness)
        warnings: list[str] = []
        self._last_skeleton = None
        self._hue = {}
        self._pattern = {}
        self._pattern_files = {}

        for mesh_path in resolved.meshes:
            raw = self._vfs.try_read(mesh_path)
            if raw is None:
                warnings.append(f"missing mesh {mesh_path}")
                continue
            try:
                mesh = read_mesh(raw, mesh_path)
            except Exception as exc:
                warnings.append(f"{mesh_path}: {exc}")
                continue
            self.stats["meshes"] += 1
            self._add_mesh(builder, mesh, warnings)

        for mesh_path in resolved.skinned:
            raw = self._vfs.try_read(mesh_path)
            if raw is None:
                warnings.append(f"missing skinned mesh {mesh_path}")
                continue
            try:
                skinned = read_skinned_mesh(raw, mesh_path)
            except Exception as exc:
                warnings.append(f"{mesh_path}: {exc}")
                continue
            self.stats["skinned"] += 1
            self._add_skinned(builder, skinned, warnings)

        if not builder.is_empty:
            self._attach_hardpoints(builder, resolved)

        if not builder.is_empty and self._options.animations and builder.has_skin:
            self._attach_animations(builder, appearance, warnings)

        if builder.is_empty:
            return None

        stats = builder.stats()
        lo, hi = builder.bounds()
        self.stats["appearances"] += 1

        return ConvertResult(
            key=asset_key(appearance),
            glb=builder.build(),
            bounds_min=lo,
            bounds_max=hi,
            triangles=stats["triangles"],
            vertices=stats["vertices"],
            materials=stats["materials"],
            textures=stats["textures"],
            lod_count=resolved.lod_count,
            kind=resolved.kind,
            animations=builder.animation_names,
            hardpoints=builder.hardpoint_names,
            hue=list(self._hue.values()),
            pattern=list(self._pattern.values()),
            pattern_files=dict(self._pattern_files),
            warnings=warnings,
        )

    # -- internals ----------------------------------------------------------

    def _add_mesh(self, builder: GlbBuilder, mesh: StaticMesh, warnings: list[str]) -> None:
        gltf_mesh = GltfMesh(name=Path(mesh.name).stem or "mesh")
        for primitive in mesh.primitives:
            material_name = self._ensure_material(builder, primitive.shader, warnings)
            gltf_mesh.primitives.append(_to_gltf_primitive(primitive, material_name))
        if gltf_mesh.primitives:
            builder.add_mesh(gltf_mesh)

    def _add_skinned(self, builder: GlbBuilder, mesh, warnings: list[str]) -> None:
        """Export a skinned mesh, rigged when its skeleton can be resolved.

        The mesh names its skeleton, so the two are only joined here. When the
        skeleton is missing or its bones do not line up, the geometry is still
        exported — in bind pose, which is what the positions already hold — but
        without skin attributes, because a JOINTS_0 with no skin makes the file
        invalid.
        """
        skeleton, remap = self._resolve_skeleton(mesh, warnings)
        if skeleton is not None and not builder.has_skin:
            builder.set_skin(_to_skin(skeleton))
            self._last_skeleton = skeleton

        rigged = skeleton is not None and remap is not None
        gltf_mesh = GltfMesh(name=Path(mesh.name).stem or "skinned")
        for primitive in mesh.primitives:
            material_name = self._ensure_material(builder, primitive.shader, warnings)
            gltf_mesh.primitives.append(
                GltfPrimitive(
                    positions=np.ascontiguousarray(primitive.positions, dtype=np.float32),
                    indices=np.ascontiguousarray(primitive.triangles, dtype=np.uint32),
                    normals=(
                        np.ascontiguousarray(primitive.normals, dtype=np.float32)
                        if primitive.normals is not None
                        else None
                    ),
                    uvs=primitive.uvs,
                    colors=None,
                    material=material_name,
                    joints=(
                        _remap_joints(primitive.joints, remap)
                        if rigged and primitive.joints is not None and remap is not None
                        else None
                    ),
                    weights=primitive.weights if rigged else None,
                )
            )
        if gltf_mesh.primitives:
            builder.add_mesh(gltf_mesh)
            if rigged:
                self.stats["rigged"] += 1

    def _attach_hardpoints(self, builder: GlbBuilder, resolved: ResolvedAppearance) -> None:
        """Collect the appearance's attachment points and emit them as nodes.

        Gathered from every file in the resolution chain rather than from the
        mesh alone. A `.lod` or `.cmp` carries its own hardpoints and is
        frequently where the useful ones live -- an X-wing's `wing1` is on the
        body LOD, not on any single mesh -- so reading only the leaf would miss
        exactly the points an attachment tool needs.
        """
        collected: list[Hardpoint] = []
        for path in resolved.chain:
            raw = self._vfs.try_read(path)
            if raw is None:
                continue
            collected.extend(read_hardpoints(raw, path))

        for point in dedupe(collected):
            oriented = point.mirrored_z() if self._options.convert_handedness else point
            builder.add_hardpoint(
                GltfHardpoint(
                    name=oriented.name,
                    translation=oriented.translation,
                    rotation=_rotation_to_quaternion(oriented.rotation),
                )
            )

    def _attach_animations(self, builder: GlbBuilder, appearance: str, warnings: list[str]) -> None:
        """Attach the best-matching clips for this skeleton, up to the cap.

        Coverage alone cannot finish this job. Every humanoid character shares
        one skeleton, so a chef's apron scores perfectly against Boss Nass's
        walk, the protocol droid's walk, and the generic humanoid walk alike —
        all three are genuinely authored for those bones. Left unranked a
        wearable collected thirteen near-duplicate clips and grew 3.5x.

        So candidates are ranked by how well the clip *belongs* to this asset
        before the cap is applied: its own species first, then the generic
        `all_b` set, then anything else.
        """
        skeleton = self._last_skeleton
        if skeleton is None:
            return

        stem = asset_key(appearance).rsplit("/", 1)[-1]
        scored: list[tuple[int, str, object]] = []
        for path in self._options.animations:
            clip = self._load_animation(path)
            if clip is None:
                continue
            if coverage(clip, skeleton) < self._options.animation_coverage:
                continue
            scored.append((_clip_rank(path, stem), path, clip))

        # Sort by rank, then by path so a given asset converts identically on
        # every run — a manifest that reshuffles between runs is unreadable.
        scored.sort(key=lambda item: (item[0], item[1]))

        # Another character's clip is worth playing only when this asset has
        # nothing of its own and nothing generic. Otherwise it is filler that
        # describes some other model: a chef's apron does not need Boss Nass's
        # idle alongside the humanoid one it already has.
        if scored and scored[0][0] < 2:
            scored = [item for item in scored if item[0] < 2]

        # Build in rank order and stop once the cap is satisfied, rather than
        # capping first and building after. build_animation returns None for a
        # clip that decodes but produces no usable channels, so capping first
        # meant a model whose best `limit` clips all failed got no animation at
        # all while perfectly good lower-ranked ones sat unused.
        limit = self._options.animation_limit
        attached = 0
        considered = 0
        for _rank, _path, clip in scored:
            if limit > 0 and attached >= limit:
                break
            considered += 1
            gltf_clip = build_animation(
                clip, skeleton, convert_handedness=self._options.convert_handedness
            )
            if gltf_clip is not None:
                builder.add_animation(gltf_clip)
                self.stats["animations"] += 1
                attached += 1

        # Only a clip that was never looked at is a clip the cap dropped.
        dropped = len(scored) - considered
        if dropped > 0:
            warnings.append(f"kept {attached} of {len(scored)} matching clips")

    def _load_animation(self, path: str):
        if path in self._animation_cache:
            return self._animation_cache[path]
        raw = self._vfs.try_read(path)
        clip = None
        if raw is not None:
            try:
                clip = read_animation(raw, path)
            except Exception:
                clip = None
        self._animation_cache[path] = clip
        return clip

    def _resolve_skeleton(
        self, mesh, warnings: list[str]
    ) -> tuple[Skeleton | None, np.ndarray | None]:
        """Load the skeleton a mesh names, and map its joints onto that skeleton.

        A mesh's joint indices address *its own* bone list (`XFNM`), which is a
        subset of the skeleton in a different order — a shirt lists 15 bones
        starting at the spine, while the skeleton has 38 starting at the legs.
        Binding index to index would attach the collar to a thigh, so indices
        are remapped by name.
        """
        for path in mesh.skeletons:
            skeleton = self._load_skeleton(path)
            if skeleton is None:
                continue
            remap = _joint_remap(mesh.bones, skeleton)
            if remap is not None:
                return skeleton, remap
            warnings.append(
                f"{mesh.name}: bones are not all present in {path}; exported without a skin"
            )
        return None, None

    def _load_skeleton(self, path: str) -> Skeleton | None:
        if path in self._skeleton_cache:
            return self._skeleton_cache[path]
        raw = self._vfs.try_read(path)
        skeleton: Skeleton | None = None
        if raw is not None:
            try:
                skeleton = read_skeleton(raw, path)
            except Exception:
                skeleton = None
        self._skeleton_cache[path] = skeleton
        return skeleton

    def _ensure_material(
        self, builder: GlbBuilder, shader_path: str, warnings: list[str]
    ) -> str | None:
        if not shader_path:
            return None
        shader = self._load_shader(shader_path)
        name = Path(shader_path).stem
        if shader is None:
            builder.add_material(GltfMaterial(name=name))
            return name

        # Alpha is real transparency only when the effect actually blends or
        # tests on it. Every other SWG shader packs a specular, environment or
        # hue mask in there, and shipping that as an alpha channel both
        # destroys the colour underneath it and reads as see-through.
        alpha_is_opacity = shader.is_alpha_blended or shader.is_alpha_tested

        # A ship's paint. Keyed by variable so the same pair declared across
        # several materials is recorded once.
        for channel in shader.hue:
            self._hue.setdefault(
                channel.variable,
                {
                    "variable": channel.variable,
                    "textureTag": channel.texture_tag,
                    "palette": channel.palette,
                    "index": channel.index,
                },
            )
            self._palettes_seen.add(channel.palette)

        # A ship's patterns. Each option is exported twice: the base colour, and
        # the alpha on its own as a mask. The alpha is what decides WHERE a
        # colour lands -- on an X-wing about 8% of the hull -- and it cannot
        # ride along in the base texture's alpha channel, because libwebp is
        # free to destroy the RGB underneath a zero alpha.
        for channel in shader.pattern:
            key = f"{channel.variable}|{channel.texture_tag}"
            if key in self._pattern:
                continue
            options = []
            for path in channel.options:
                exported = self._export_pattern_texture(path, warnings)
                if exported:
                    options.append(exported)
            if options:
                self._pattern[key] = {
                    "variable": channel.variable,
                    "textureTag": channel.texture_tag,
                    # Which glTF material this pattern belongs to. A hull has
                    # several -- canopy, engine glow, fuselage -- and only the
                    # one whose shader declared the pattern may be painted.
                    "material": name,
                    "options": options,
                }

        base = normal = None
        if self._options.include_textures:
            base = self._ensure_texture(
                builder,
                shader.diffuse,
                is_normal_map=False,
                warnings=warnings,
                alpha_is_opacity=alpha_is_opacity,
            )
            if self._options.fix_normal_maps:
                normal = self._ensure_texture(
                    builder, shader.normal, is_normal_map=True, warnings=warnings
                )

        if shader.is_alpha_blended:
            alpha_mode = ALPHA_BLEND
        elif shader.is_alpha_tested:
            alpha_mode = ALPHA_MASK
        else:
            alpha_mode = ALPHA_OPAQUE

        builder.add_material(
            GltfMaterial(
                name=name,
                base_color_texture=base,
                normal_texture=normal,
                base_color_factor=shader.diffuse_color or (1.0, 1.0, 1.0, 1.0),
                alpha_mode=alpha_mode,
                # SWG relies on back-face culling being off for foliage and
                # cloth; doubling everything is safer than guessing per shader.
                double_sided=True,
                roughness_factor=0.6 if shader.specular else 0.9,
            )
        )
        return name

    def _load_shader(self, path: str) -> ShaderTemplate | None:
        if path in self._shader_cache:
            return self._shader_cache[path]
        raw = self._vfs.try_read(path)
        shader: ShaderTemplate | None = None
        if raw is not None:
            try:
                shader = read_shader(raw, path)
            except Exception:
                shader = None
        self._shader_cache[path] = shader
        return shader

    def _ensure_texture(
        self,
        builder: GlbBuilder,
        path: str | None,
        *,
        is_normal_map: bool,
        warnings: list[str],
        alpha_is_opacity: bool = True,
    ) -> str | None:
        if not path:
            return None
        # The same texture can be referenced by one shader that blends on its
        # alpha and another that masks with it, so the intent is part of the key.
        cache_key = f"{path}|{'n' if is_normal_map else 'c'}|{'o' if alpha_is_opacity else 'm'}"
        if cache_key in self._texture_cache:
            texture = self._texture_cache[cache_key]
        else:
            texture = self._encode_texture(
                path, is_normal_map, warnings, alpha_is_opacity=alpha_is_opacity
            )
            self._texture_cache[cache_key] = texture
        if texture is None:
            return None
        builder.add_texture(texture)
        return texture.name

    def _export_pattern_texture(self, path: str, warnings: list[str]) -> dict | None:
        """Write one pattern option out as a base image and a mask.

        Returned as filenames rather than embedded, because the options are
        alternatives: a hull shows one at a time and the viewer swaps between
        them without reloading the model.
        """
        raw = self._vfs.try_read(path)
        if raw is None:
            warnings.append(f"missing pattern texture {path}")
            return None
        try:
            image = decode(raw, path)
        except TextureError as exc:
            warnings.append(str(exc))
            return None

        stem = output_stem(path)
        base = encode(image, stem, self._options.textures, alpha_is_opacity=False)
        entry = {"base": base.filename}
        self._pattern_files[base.filename] = base.data

        # The mask is the alpha, on its own. A texture with no alpha masks
        # nothing, which is a real answer rather than a failure.
        if image.mode == "RGBA":
            mask = image.getchannel("A").convert("RGB")
            encoded = encode(mask, f"{stem}_m", self._options.textures, alpha_is_opacity=False)
            entry["mask"] = encoded.filename
            self._pattern_files[encoded.filename] = encoded.data

        return entry

    def _encode_texture(
        self,
        path: str,
        is_normal_map: bool,
        warnings: list[str],
        *,
        alpha_is_opacity: bool = True,
    ) -> GltfTexture | None:
        raw = self._vfs.try_read(path)
        if raw is None:
            warnings.append(f"missing texture {path}")
            return None
        try:
            image = decode(raw, path)
        except TextureError as exc:
            warnings.append(str(exc))
            return None
        if is_normal_map:
            image = normal_map_to_rgb(image)
        # The intent belongs in the NAME, not only in the cache key. A texture
        # bound by one shader that blends on its alpha and another that masks
        # with it is encoded twice -- RGBA and RGB -- and GlbBuilder.add_texture
        # keeps the first image registered under a given name. Without a
        # distinct name the RGB copy could win and leave a BLEND or MASK
        # material with no alpha to test, rendering cut-out foliage as solid
        # quads.
        stem = (
            output_stem(path)
            + ("_n" if is_normal_map else "")
            + ("" if (is_normal_map or alpha_is_opacity) else "_m")
        )
        # A normal map's alpha carries the reconstructed X, never opacity.
        encoded = encode(
            image,
            stem,
            self._options.textures,
            alpha_is_opacity=False if is_normal_map else alpha_is_opacity,
        )
        self.stats["textures_encoded"] += 1
        self.stats["texture_bytes"] += len(encoded.data)
        return GltfTexture(name=encoded.filename, data=encoded.data, mime=encoded.mime)


def _to_gltf_primitive(primitive: Primitive, material: str | None) -> GltfPrimitive:
    vertices = primitive.vertices
    return GltfPrimitive(
        positions=np.ascontiguousarray(vertices.positions, dtype=np.float32),
        indices=np.ascontiguousarray(primitive.triangles, dtype=np.uint32),
        normals=(
            np.ascontiguousarray(vertices.normals, dtype=np.float32)
            if vertices.normals is not None
            else None
        ),
        uvs=vertices.uv_set(0),
        colors=vertices.colors,
        material=material,
    )


#: Clips authored against the shared humanoid skeleton rather than one
#: character. They are the right fallback for any humanoid asset that has no
#: clips of its own — every wearable, and most NPCs.
_GENERIC_CLIP_PREFIX = "all_"


def _clip_rank(clip_path: str, asset_stem: str) -> int:
    """Lower is better. Ties are broken by path, so runs are reproducible."""
    name = clip_path.replace("\\", "/").rsplit("/", 1)[-1].removesuffix(".ans").lower()
    # `rancor_loc_walk` for `rancor`: authored for exactly this asset.
    if name.startswith(f"{asset_stem}_"):
        return 0
    if name.startswith(_GENERIC_CLIP_PREFIX):
        return 1
    # Another character that happens to share this skeleton. Correct to play,
    # but a poorer description of this asset than the generic set.
    return 2



def _rotation_to_quaternion(
    rows: tuple[
        tuple[float, float, float],
        tuple[float, float, float],
        tuple[float, float, float],
    ],
) -> tuple[float, float, float, float]:
    """A 3x3 rotation basis as a glTF-ordered quaternion (x, y, z, w).

    Shepperd's method: pick the largest diagonal term to divide by, rather than
    always taking the trace. The trace form loses all precision when w is near
    zero — a 180-degree hardpoint, which mirrored attachment points routinely
    are — and returns a quaternion that does not normalise.
    """
    m00, m01, m02 = rows[0]
    m10, m11, m12 = rows[1]
    m20, m21, m22 = rows[2]
    trace = m00 + m11 + m22

    if trace > 0.0:
        s = math.sqrt(trace + 1.0) * 2.0
        w = 0.25 * s
        x = (m21 - m12) / s
        y = (m02 - m20) / s
        z = (m10 - m01) / s
    elif m00 > m11 and m00 > m22:
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2.0
        w = (m21 - m12) / s
        x = 0.25 * s
        y = (m01 + m10) / s
        z = (m02 + m20) / s
    elif m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2.0
        w = (m02 - m20) / s
        x = (m01 + m10) / s
        y = 0.25 * s
        z = (m12 + m21) / s
    else:
        s = math.sqrt(1.0 + m22 - m00 - m11) * 2.0
        w = (m10 - m01) / s
        x = (m02 + m20) / s
        y = (m12 + m21) / s
        z = 0.25 * s

    length = math.sqrt(x * x + y * y + z * z + w * w)
    if length == 0.0:
        return (0.0, 0.0, 0.0, 1.0)
    return (x / length, y / length, z / length, w / length)


def asset_key(appearance: str) -> str:
    """`appearance/mesh/foo_l0.msh` → `mesh/foo_l0`, stable across runs."""
    path = appearance.replace("\\", "/").lower()
    path = path.removeprefix("appearance/")
    return path.rsplit(".", 1)[0]


class Timer:
    """Wall-clock helper used by the CLI for progress reporting."""

    def __init__(self) -> None:
        self.start = time.perf_counter()

    def elapsed(self) -> float:
        return time.perf_counter() - self.start

    def rate(self, count: int) -> float:
        seconds = self.elapsed()
        return count / seconds if seconds > 0 else 0.0


def _joint_remap(mesh_bones: list[str], skeleton: Skeleton) -> np.ndarray | None:
    """Map each of a mesh's bone slots onto a skeleton joint index.

    Returns None when any bone is absent from the skeleton, since a partial
    map would silently bind those vertices to joint zero — the root — and drag
    them to the model's origin.
    """
    if not mesh_bones:
        return None
    # Bone names are matched case-insensitively: a mesh writes `lclav` where
    # its skeleton writes `lClav`, and the engine hashes both through a
    # lower-cased CRC. Comparing them literally rejects every humanoid
    # wearable in the game.
    by_name = {bone.name.lower(): index for index, bone in enumerate(skeleton.bones)}
    mapped = [by_name.get(name.lower()) for name in mesh_bones]
    if any(index is None for index in mapped):
        return None
    return np.array(mapped, dtype=np.uint16)


def _remap_joints(joints: np.ndarray, remap: np.ndarray) -> np.ndarray:
    """Rewrite mesh-local joint slots as skeleton joint indices."""
    clipped = np.clip(joints, 0, len(remap) - 1)
    return np.ascontiguousarray(remap[clipped], dtype=np.uint16)


def _to_skin(skeleton: Skeleton) -> GltfSkin:
    return GltfSkin(
        joints=[
            GltfJoint(
                name=bone.name,
                parent=bone.parent,
                translation=bone.translation,
                rotation=bone.rotation,
            )
            for bone in skeleton.bones
        ],
        inverse_bind_matrices=skeleton.inverse_bind_matrices(),
    )
