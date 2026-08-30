"""Shader template (``.sht``) reader — just enough to find the textures.

A shader template is a full fixed-function/effect description. The web viewer
only needs the material inputs, so this reader pulls out:

  * texture bindings, keyed by the effect's texture tag (MAIN, NRML, …)
  * the material colours, when the template declares any
  * the alpha behaviour, inferred from the referenced ``.eft`` effect name

Texture bindings live in ``TXM`` forms. Version 0000 writes
``bool placeholder, u32 tag``; 0001 and 0002 write ``u32 tag, bool placeholder``
and then sampler state. The texture path itself is a ``NAME`` chunk written by
``TextureList::fetch`` immediately after — so rather than reimplement the whole
effect-capability check the engine does, this walks each TXM form and takes the
tag from its DATA chunk and the path from its NAME chunk.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..iff import IffNode, parse, tag_name

# Effect texture tags that carry the base colour, in preference order. SWG's
# effects name the diffuse sampler inconsistently across generations.
DIFFUSE_TAGS = ("MAIN", "DIFF", "DOT3", "BASE")
# CNRM is what the ship shaders actually use -- 62 of the 95 distinct ship
# shaders bind one, and none of them bind NRML, BUMP or NORM. Leaving it out
# dropped every ship normal map, so hulls rendered flat and detail-free.
NORMAL_TAGS = ("NRML", "BUMP", "NORM", "CNRM")
SPECULAR_TAGS = ("SPEC", "GLOS")


@dataclass(slots=True)
class HueChannel:
    """One palette-driven colour on a customisable shader.

    `variable` is the customisation variable a player changes
    (`index_color_1`); `texture_tag` is the sampler whose ALPHA masks where the
    colour lands, so a hue only tints the parts the artist marked -- on an
    X-wing that is the flame markings, about 8% of the hull. `index` is the
    shipped default.
    """

    variable: str
    texture_tag: str
    palette: str
    index: int


@dataclass(slots=True)
class PatternChannel:
    """One texture slot a pattern swaps.

    `texture_tag` is the sampler being swapped; `options` are the texture paths
    it can take, in index order. Every channel on a shader is driven by the same
    `variable`, so choosing pattern N binds option N in each of them at once --
    that is what makes a pattern a matched set rather than independent choices.
    """

    variable: str
    texture_tag: str
    options: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ShaderTemplate:
    name: str
    #: Texture path by effect tag, e.g. ``{"MAIN": "texture/foo.dds"}``.
    textures: dict[str, str] = field(default_factory=dict)
    effect: str | None = None
    #: Palette-driven colour channels, from the customisable shader's TFAC form.
    #: These are a ship's paint: each names a palette and the index it defaults
    #: to, and tints the texture whose tag it targets, masked by that texture's
    #: alpha.
    hue: list[HueChannel] = field(default_factory=list)
    #: Texture sets the shader can swap between -- a ship's PATTERN. The colours
    #: above are painted through whichever set is bound.
    pattern: list[PatternChannel] = field(default_factory=list)
    #: Vertex-colour tint, when the template declares a material.
    diffuse_color: tuple[float, float, float, float] | None = None

    @property
    def diffuse(self) -> str | None:
        return _first(self.textures, DIFFUSE_TAGS)

    @property
    def normal(self) -> str | None:
        return _first(self.textures, NORMAL_TAGS)

    @property
    def specular(self) -> str | None:
        return _first(self.textures, SPECULAR_TAGS)

    @property
    def is_alpha_blended(self) -> bool:
        """Effects encode blending in their filename; there is no flag for it.

        Names observed across the shipped shader set: ``a_alpha``,
        ``a_alpha_fade``, ``a_add``, and the ``*_blend`` family blend; the
        ``a_punchout`` family is a hard cutout.
        """
        if not self.effect:
            return False
        stem = self.effect.rsplit("/", 1)[-1].lower()
        return "alpha" in stem or "blend" in stem or stem.startswith("a_add")

    @property
    def is_alpha_tested(self) -> bool:
        if not self.effect:
            return False
        stem = self.effect.rsplit("/", 1)[-1].lower()
        return "punchout" in stem or "cutout" in stem or "test" in stem


def _first(textures: dict[str, str], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = textures.get(key)
        if value:
            return value
    return None


def read_shader(data: bytes, name: str = "") -> ShaderTemplate:
    """Parse an ``SSHT`` (static) or ``CSHT`` (customizable) shader template."""
    root = parse(data)
    shader = ShaderTemplate(name=name)

    for node in root.walk():
        if node.is_form and node.name.strip() == "TXM":
            _read_texture_binding(node, shader)
        elif not node.is_form and node.name.strip() == "MATL":
            _read_material(node, shader)

    # The effect is a bare NAME chunk sitting alongside the MATS/TXMS forms
    # under the template's version form, e.g. `effect\a_specmap_bump.eft`.
    # A static shader is `SSHT > 0000 > NAME`, but a CUSTOMISABLE one wraps it:
    # `CSHD > 0001 > SSHT > 0000 > NAME`. Walking to the innermost SSHT handles
    # both layouts, where iterating the root's own children only ever found the
    # static one -- and every hue-tinted ship shader is the customisable kind,
    # so their effect came back None and their alpha behaviour with it.
    holder = next(
        (n for n in root.walk() if n.is_form and n.name.strip() == "SSHT"),
        root,
    )
    for version in holder.children:
        if not version.is_form:
            continue
        effect_node = next(
            (c for c in version.children if not c.is_form and c.name.strip() == "NAME"), None
        )
        if effect_node is not None:
            shader.effect = _normalize_path(effect_node.reader().cstring())
            break

    _read_hue_channels(root, shader)
    _read_pattern_channels(root, shader)

    return shader


def _read_hue_channels(root: IffNode, shader: ShaderTemplate) -> None:
    """Read the TFAC form's PAL chunks.

    Each is: a NUL-terminated variable name, a four-character texture tag
    stored back to front (`NIAM` is `MAIN`), a NUL-terminated palette path, and
    a little-endian uint32 default index.
    """
    for node in root.walk():
        if node.is_form or node.name.strip() != "PAL":
            continue
        try:
            # Read the payload directly: the layout has NUL padding between
            # the variable name and the tag, and stepping over it by hand is
            # clearer than threading a peek through the reader.
            raw = node.data
            end = raw.index(b"\x00")
            variable = raw[:end].decode("latin-1")
            cursor = end
            while cursor < len(raw) and raw[cursor] == 0:
                cursor += 1
            tag = raw[cursor : cursor + 4].decode("latin-1")[::-1].strip()
            cursor += 4
            stop = raw.index(b"\x00", cursor)
            palette = raw[cursor:stop].decode("latin-1")
            index = int.from_bytes(raw[stop + 1 : stop + 5], "little")
        except Exception:
            continue
        if not variable or not palette:
            continue
        shader.hue.append(
            HueChannel(
                variable=variable,
                texture_tag=tag,
                palette=_normalize_path(palette),
                index=index,
            )
        )


def _normalize_path(path: str) -> str:
    """Asset paths mix separators even within one file; settle on forward."""
    return path.replace("\\", "/").strip()


def _read_texture_binding(txm: IffNode, shader: ShaderTemplate) -> None:
    version = next((c for c in txm.children if c.is_form), None)
    if version is None:
        return
    data_node = version.find("DATA")
    name_node = version.find("NAME")
    if data_node is None:
        return

    reader = data_node.reader()
    if version.name.strip() == "0000":
        reader.bool8()  # placeholder
        texture_tag = reader.tag()
    else:
        texture_tag = reader.tag()

    path = _normalize_path(name_node.reader().cstring()) if name_node is not None else ""
    if path:
        shader.textures[tag_name(texture_tag).strip()] = path


def _read_material(chunk: IffNode, shader: ShaderTemplate) -> None:
    # MATL is ambient/diffuse/specular/emissive as 4 x 4 floats, then power.
    reader = chunk.reader()
    if reader.remaining < 32:
        return
    reader.raw(16)  # ambient
    r, g, b, a = (reader.f32() for _ in range(4))
    shader.diffuse_color = (r, g, b, a)


def _read_pattern_channels(root: IffNode, shader: ShaderTemplate) -> None:
    """Read the TXTR form: the texture list, and which slice each sampler uses.

    The form holds one DATA chunk -- a uint16 count then that many
    NUL-terminated texture paths -- and a CUST form of TX1D chunks. Each TX1D is
    a four-character sampler tag stored back to front, a uint16 offset into the
    list, a uint16 count, and the customisation variable that drives it.

    So an X-wing's list is twelve paths: the HUEB sampler takes 0..5 and MAIN
    takes 6..11, both driven by `index_texture_1`. Six patterns, each a matched
    pair.
    """
    textures: list[str] = []
    for node in root.walk():
        if node.is_form or node.name.strip() != "DATA" or len(node.data) < 3:
            continue
        raw = node.data
        count = int.from_bytes(raw[0:2], "little")
        # A sampler's own DATA chunk is 11 bytes and would decode as nonsense.
        if count == 0 or count > 256 or len(raw) < 3 + count:
            continue
        cursor = 2
        found: list[str] = []
        for _ in range(count):
            stop = raw.find(bytes([0]), cursor)
            if stop == -1:
                break
            found.append(_normalize_path(raw[cursor:stop].decode("latin-1")))
            cursor = stop + 1
        if len(found) == count:
            textures = found
            break

    if not textures:
        return

    for node in root.walk():
        if node.is_form or node.name.strip() != "TX1D" or len(node.data) < 8:
            continue
        raw = node.data
        tag = raw[0:4].decode("latin-1")[::-1].strip()
        offset = int.from_bytes(raw[4:6], "little")
        count = int.from_bytes(raw[6:8], "little")
        stop = raw.find(bytes([0]), 8)
        variable = raw[8:stop].decode("latin-1") if stop != -1 else ""
        options = textures[offset : offset + count]
        if not variable or not options:
            continue
        shader.pattern.append(
            PatternChannel(variable=variable, texture_tag=tag, options=options)
        )
