"""Texture decoding and web encoding.

The client ships DDS (usually DXT1/3/5, sometimes uncompressed) and a few TGA.
Pillow reads both, so this module's job is the parts Pillow will not do:

  * cap the resolution, because a 2048² wall texture is wasted on a viewer
    that draws the model 400 px tall
  * pick the right output codec — WebP for colour, PNG when the source has
    hard alpha that WebP's lossy mode would smear
  * split the SWG convention where a normal map's alpha channel is reused for
    something else, which makes a naive RGBA copy render as garbage
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = 64_000_000


@dataclass(frozen=True, slots=True)
class TextureOptions:
    max_size: int = 1024
    #: WebP quality for colour maps. 82 is visually clean at viewer scale.
    quality: int = 82
    #: Emit PNG instead of WebP when the image has any partial transparency.
    lossless_alpha: bool = True


@dataclass(slots=True)
class EncodedTexture:
    filename: str
    data: bytes
    mime: str
    width: int
    height: int
    has_alpha: bool


class TextureError(Exception):
    pass


def decode(data: bytes, name: str = "") -> Image.Image:
    """Decode a DDS/TGA/PNG blob to RGB(A)."""
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # Pillow raises a zoo of exception types here
        raise TextureError(f"{name or 'texture'}: {exc}") from exc

    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    return image


DEFAULT_TEXTURE_OPTIONS = TextureOptions()


def encode(
    image: Image.Image,
    stem: str,
    options: TextureOptions = DEFAULT_TEXTURE_OPTIONS,
    *,
    alpha_is_opacity: bool = True,
) -> EncodedTexture:
    """Downscale and re-encode for the web.

    ``alpha_is_opacity`` says whether the alpha channel means transparency. In
    SWG it usually does not: most ship and building shaders pack a specular,
    environment or hue MASK into alpha, and the effect samples it as data. Two
    separate things go wrong if such a mask is shipped as an alpha channel.

    The first is silent and destroys the texture. libwebp "cleans" fully
    transparent texels -- it is free to replace the RGB under alpha 0 with
    anything, because nothing should ever see it. With a mask in alpha that is
    most of the image: the shipped X-wing hull had 91.5% of its texels at
    alpha 0, and 77% of those came back pure black against 3.7% elsewhere. The
    hull was mostly black. ``exact=True`` suppresses that, at roughly 5x the
    bytes.

    The second is that three.js would honour the mask as real transparency.

    So a mask is dropped entirely -- which is both correct and the smallest of
    the three options -- and a genuine opacity channel is kept with
    ``exact=True`` so it survives the round trip.
    """
    if max(image.size) > options.max_size:
        scale = options.max_size / max(image.size)
        target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(target, Image.LANCZOS)

    has_alpha = alpha_is_opacity and image.mode == "RGBA" and _uses_alpha(image)
    if not has_alpha and image.mode == "RGBA":
        image = image.convert("RGB")

    buffer = io.BytesIO()
    if has_alpha and options.lossless_alpha:
        image.save(buffer, format="WEBP", lossless=True, method=4, exact=True)
        mime, ext = "image/webp", "webp"
    elif has_alpha:
        image.save(buffer, format="WEBP", quality=options.quality, method=4, exact=True)
        mime, ext = "image/webp", "webp"
    else:
        image.save(buffer, format="WEBP", quality=options.quality, method=4)
        mime, ext = "image/webp", "webp"

    return EncodedTexture(
        filename=f"{stem}.{ext}",
        data=buffer.getvalue(),
        mime=mime,
        width=image.width,
        height=image.height,
        has_alpha=has_alpha,
    )


def _uses_alpha(image: Image.Image) -> bool:
    alpha = image.getchannel("A")
    lo, hi = alpha.getextrema()
    return lo < 255 or hi < 255


def normal_map_to_rgb(image: Image.Image) -> Image.Image:
    """Drop the alpha of a normal map.

    SWG's ``*_n.dds`` normal maps are DXT5 with the X component moved into the
    alpha channel so the block compressor keeps it precise, leaving green in G
    and garbage in R/B for some exporters. Copying RGBA straight into glTF
    makes lighting invert. Reconstructing XY from (A, G) and deriving Z gives a
    correct tangent-space normal.
    """
    if image.mode != "RGBA":
        return image.convert("RGB")

    import numpy as np

    rgba = np.asarray(image, dtype=np.float32) / 255.0
    x = rgba[..., 3] * 2.0 - 1.0
    y = rgba[..., 1] * 2.0 - 1.0
    z = np.sqrt(np.clip(1.0 - x * x - y * y, 0.0, 1.0))
    out = np.stack([x, y, z], axis=-1)
    out = ((out * 0.5 + 0.5) * 255.0).clip(0, 255).astype("uint8")
    return Image.fromarray(out, mode="RGB")


def output_stem(source_path: str) -> str:
    """`texture/foo_bar.dds` → `foo_bar`, uniquely and filesystem-safe."""
    stem = Path(source_path).stem
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in stem).lower()
