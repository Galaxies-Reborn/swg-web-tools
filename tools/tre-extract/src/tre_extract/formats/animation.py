"""Keyframe animation (``.ans``) reader.

Two root forms exist, and the compressed one is overwhelmingly the common
case — of the 8,590 animations the client ships, 7,770 are ``CKAT`` and 817 are
``KFAT``. They carry the same information in different encodings:

* ``KFAT`` stores full 32-bit floats and 32-bit counts.
* ``CKAT`` stores 16-bit counts and frame numbers, and packs each rotation into
  a single 32-bit word with a per-channel precision format. See ``cquat.py``.

Structure (``KFAT`` → ``0002`` or ``0003``)::

    INFO   f32 framesPerSecond
           i32 frameCount
           i32 transformInfoCount
           i32 rotationChannelCount
           i32 staticRotationCount
           i32 translationChannelCount
           i32 staticTranslationCount

    XFRM   one XFIN chunk per animated transform:
             cstring boneName
             (0003)  i8  hasAnimatedRotation
                     i32 rotationChannelIndex
             (0002)  u32 rotationMask
                     i32 x/y/z rotation channel indices
             u32 translationMask
             i32 x/y/z translation channel indices

    AROT   rotationChannelCount x QCHN
             i32 keyCount, then per key: i32 frame, 4 x f32
    SROT   staticRotationCount x (0003: quaternion, 0002: f32 euler angle)
    ATRN   translationChannelCount x CHNL
             i32 keyCount, then per key: i32 frame, f32 value
    STRN   staticTranslationCount x f32
    MSGS   animation event messages — not needed for playback
    LOCT/LOCR  locomotion, which drives root motion in game rather than the rig

Two facts decide whether the result animates correctly:

* **Quaternions are stored w,x,y,z**, as in skeletons. glTF wants x,y,z,w.
* **A channel index means different things depending on its mask bit.** When
  the bit is set the index addresses the *animated* channel list; when it is
  clear the same number addresses the *static* list. Reading it as one or the
  other unconditionally silently animates the wrong bone.

Version 0002 stores rotations as three separate Euler angle channels and is
composed as ``qz * (qy * qx)``; 0003 stores quaternions directly. Both are
handled, and 0003 is what the shipped Pre-CU animations use.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

from ..iff import IffError, IffNode, parse
from . import cquat

# Channel component flags, from KeyframeSkeletalAnimationTemplateDef.h.
SATCCF_X_ROTATION = 0b0000_0001
SATCCF_Y_ROTATION = 0b0000_0010
SATCCF_Z_ROTATION = 0b0000_0100
SATCCF_ROTATION_MASK = 0b0000_0111
SATCCF_X_TRANSLATION = 0b0000_1000
SATCCF_Y_TRANSLATION = 0b0001_0000
SATCCF_Z_TRANSLATION = 0b0010_0000
SATCCF_TRANSLATION_MASK = 0b0011_1000


@dataclass(slots=True)
class TransformInfo:
    """One animated bone, and where to find its channels."""

    name: str
    has_animated_rotation: bool
    #: Index into the animated rotation channels, or the static list.
    rotation_channel: int
    translation_mask: int
    #: Per axis: index into the animated translation channels, or the statics.
    translation_channels: tuple[int, int, int]
    #: 0002 only: which Euler components animate, and their channel indices.
    rotation_mask: int = 0
    euler_rotation_channels: tuple[int, int, int] = (0, 0, 0)

    def animates_translation(self, axis: int) -> bool:
        bit = (SATCCF_X_TRANSLATION, SATCCF_Y_TRANSLATION, SATCCF_Z_TRANSLATION)[axis]
        return (self.translation_mask & bit) != 0


@dataclass(slots=True)
class Animation:
    name: str
    version: int
    #: True for CKAT, which packs rotations into one word per key.
    compressed: bool
    frames_per_second: float
    frame_count: int
    transforms: list[TransformInfo] = field(default_factory=list)
    #: Animated rotation channels: each is (frames, quaternions x,y,z,w).
    rotation_channels: list[tuple[np.ndarray, np.ndarray]] = field(default_factory=list)
    #: Static rotations as glTF-ordered quaternions.
    static_rotations: list[tuple[float, float, float, float]] = field(default_factory=list)
    #: Animated translation channels: each is (frames, values).
    translation_channels: list[tuple[np.ndarray, np.ndarray]] = field(default_factory=list)
    static_translations: list[float] = field(default_factory=list)

    @property
    def duration(self) -> float:
        if self.frames_per_second <= 0:
            return 0.0
        # frameCount is the number of frames, so the last one sits at
        # (frameCount - 1) / fps.
        return max(0.0, (self.frame_count - 1) / self.frames_per_second)

    @property
    def is_empty(self) -> bool:
        return self.frame_count <= 1 or not self.transforms


def read_animation(data: bytes, name: str = "") -> Animation:
    """Read either an uncompressed (KFAT) or compressed (CKAT) animation."""
    root = parse(data)
    tag = root.name.strip()
    if tag not in ("KFAT", "CKAT"):
        raise IffError(f"{name or 'asset'} is {root.name}, not KFAT or CKAT")

    version_node = _newest_version_form(root)
    if version_node is None:
        raise IffError(f"{name or 'asset'} {tag} has no versioned form")
    version = int(version_node.name.strip())

    compressed = tag == "CKAT"
    if compressed and version != 1:
        raise IffError(f"{name or 'asset'} uses unsupported CKAT version {version:04d}")
    if not compressed and version not in (2, 3):
        raise IffError(f"{name or 'asset'} uses unsupported KFAT version {version:04d}")

    info = version_node.find("INFO")
    if info is None:
        raise IffError(f"{name or 'asset'} has no INFO chunk")

    reader = info.reader()
    frames_per_second = reader.f32()
    # CKAT narrows every count to 16 bits; reading the wrong width shifts the
    # entire header and yields a plausible but nonsensical animation.
    count = reader.i16 if compressed else reader.i32
    frame_count = count()
    transform_count = count()
    rotation_channel_count = count()
    static_rotation_count = count()
    translation_channel_count = count()
    static_translation_count = count()

    animation = Animation(
        name=name,
        version=version,
        compressed=compressed,
        frames_per_second=frames_per_second,
        frame_count=frame_count,
    )

    xfrm = version_node.find("XFRM")
    if xfrm is not None:
        animation.transforms = _read_transforms(xfrm, transform_count, version, compressed)

    arot = version_node.find("AROT")
    if arot is not None:
        animation.rotation_channels = (
            _read_compressed_rotation_channels(arot, rotation_channel_count)
            if compressed
            else _read_rotation_channels(arot, rotation_channel_count)
        )

    srot = version_node.find("SROT")
    if srot is not None:
        animation.static_rotations = (
            _read_compressed_static_rotations(srot, static_rotation_count)
            if compressed
            else _read_static_rotations(srot, static_rotation_count, version)
        )

    atrn = version_node.find("ATRN")
    if atrn is not None:
        animation.translation_channels = _read_translation_channels(
            atrn, translation_channel_count, compressed
        )

    strn = version_node.find("STRN")
    if strn is not None and len(strn.data) >= static_translation_count * 4:
        animation.static_translations = list(
            struct.unpack_from(f"<{static_translation_count}f", strn.data, 0)
        )

    return animation


# --- chunk readers ---------------------------------------------------------


def _newest_version_form(node: IffNode) -> IffNode | None:
    forms = [c for c in node.children if c.is_form and c.name.strip().isdigit()]
    if not forms:
        return None
    return max(forms, key=lambda c: int(c.name.strip()))


def _read_transforms(
    xfrm: IffNode, count: int, version: int, compressed: bool
) -> list[TransformInfo]:
    out: list[TransformInfo] = []
    for node in xfrm.find_all("XFIN")[:count]:
        reader = node.reader()
        bone = reader.cstring()

        if compressed:
            # CKAT narrows the channel indices to 16 bits and the translation
            # mask to a single byte.
            has_animated_rotation = reader.u8() != 0
            rotation_channel = reader.i16()
            translation_mask = reader.u8()
            translation_channels = (reader.i16(), reader.i16(), reader.i16())
            out.append(
                TransformInfo(
                    name=bone,
                    has_animated_rotation=has_animated_rotation,
                    rotation_channel=rotation_channel,
                    translation_mask=translation_mask,
                    translation_channels=translation_channels,
                )
            )
            continue

        if version >= 3:
            has_animated_rotation = reader.u8() != 0
            rotation_channel = reader.i32()
            rotation_mask = 0
            euler_channels = (0, 0, 0)
        else:
            rotation_mask = reader.u32()
            euler_channels = (reader.i32(), reader.i32(), reader.i32())
            has_animated_rotation = (rotation_mask & SATCCF_ROTATION_MASK) != 0
            # 0002 has no single rotation channel; the Euler triple is used.
            rotation_channel = -1

        translation_mask = reader.u32()
        translation_channels = (reader.i32(), reader.i32(), reader.i32())

        out.append(
            TransformInfo(
                name=bone,
                has_animated_rotation=has_animated_rotation,
                rotation_channel=rotation_channel,
                translation_mask=translation_mask,
                translation_channels=translation_channels,
                rotation_mask=rotation_mask,
                euler_rotation_channels=euler_channels,
            )
        )
    return out


def _read_rotation_channels(arot: IffNode, count: int) -> list[tuple[np.ndarray, np.ndarray]]:
    channels: list[tuple[np.ndarray, np.ndarray]] = []
    for node in arot.find_all("QCHN")[:count]:
        reader = node.reader()
        keys = reader.i32()
        if keys <= 0 or reader.remaining < keys * 20:
            channels.append((np.zeros(0, np.float32), np.zeros((0, 4), np.float32)))
            continue
        frames = np.empty(keys, np.float32)
        rotations = np.empty((keys, 4), np.float32)
        for i in range(keys):
            frames[i] = reader.i32()
            w, x, y, z = reader.f32(), reader.f32(), reader.f32(), reader.f32()
            # Stored w,x,y,z; glTF wants x,y,z,w.
            rotations[i] = (x, y, z, w)
        channels.append((frames, rotations))
    return channels


def _read_static_rotations(
    srot: IffNode, count: int, version: int
) -> list[tuple[float, float, float, float]]:
    reader = srot.reader()
    out: list[tuple[float, float, float, float]] = []

    if version >= 3:
        for _ in range(count):
            if reader.remaining < 16:
                break
            w, x, y, z = reader.f32(), reader.f32(), reader.f32(), reader.f32()
            out.append((x, y, z, w))
        return out

    # 0002 stores a flat list of Euler angles that transform infos index into
    # individually, so they cannot be grouped here; the caller composes them.
    angles = []
    for _ in range(count):
        if reader.remaining < 4:
            break
        angles.append(reader.f32())
    return [(a, 0.0, 0.0, 0.0) for a in angles]


def _read_compressed_rotation_channels(
    arot: IffNode, count: int
) -> list[tuple[np.ndarray, np.ndarray]]:
    """QCHN: i16 keyCount, three format bytes, then i16 frame + u32 rotation."""
    channels: list[tuple[np.ndarray, np.ndarray]] = []
    for node in arot.find_all("QCHN")[:count]:
        reader = node.reader()
        keys = reader.i16()
        if keys <= 0 or reader.remaining < 3 + keys * 6:
            channels.append((np.zeros(0, np.float32), np.zeros((0, 4), np.float32)))
            continue
        # One format per component, shared by every key in the channel.
        x_format, y_format, z_format = reader.u8(), reader.u8(), reader.u8()

        frames = np.empty(keys, np.float32)
        packed = np.empty(keys, np.uint32)
        for i in range(keys):
            frames[i] = reader.i16()
            packed[i] = reader.u32()

        channels.append((frames, cquat.expand(packed, x_format, y_format, z_format)))
    return channels


def _read_compressed_static_rotations(
    srot: IffNode, count: int
) -> list[tuple[float, float, float, float]]:
    """Each static rotation carries its own three format bytes."""
    reader = srot.reader()
    out: list[tuple[float, float, float, float]] = []
    for _ in range(count):
        if reader.remaining < 7:
            break
        x_format, y_format, z_format = reader.u8(), reader.u8(), reader.u8()
        packed = reader.u32()
        quaternion = cquat.expand(packed, x_format, y_format, z_format)[0]
        out.append(tuple(float(v) for v in quaternion))  # type: ignore[arg-type]
    return out


def _read_translation_channels(
    atrn: IffNode, count: int, compressed: bool = False
) -> list[tuple[np.ndarray, np.ndarray]]:
    channels: list[tuple[np.ndarray, np.ndarray]] = []
    # Only the frame number narrows in CKAT; the value stays a full float.
    frame_size = 2 if compressed else 4
    for node in atrn.find_all("CHNL")[:count]:
        reader = node.reader()
        keys = reader.i16() if compressed else reader.i32()
        if keys <= 0 or reader.remaining < keys * (frame_size + 4):
            channels.append((np.zeros(0, np.float32), np.zeros(0, np.float32)))
            continue
        frames = np.empty(keys, np.float32)
        values = np.empty(keys, np.float32)
        for i in range(keys):
            frames[i] = reader.i16() if compressed else reader.i32()
            values[i] = reader.f32()
        channels.append((frames, values))
    return channels


# --- sampling --------------------------------------------------------------


def euler_to_quaternion(x: float, y: float, z: float) -> tuple[float, float, float, float]:
    """Compose three Euler angles as the engine does: ``qz * (qy * qx)``.

    Returned glTF-ordered (x, y, z, w).
    """
    cx, sx = np.cos(x / 2), np.sin(x / 2)
    cy, sy = np.cos(y / 2), np.sin(y / 2)
    cz, sz = np.cos(z / 2), np.sin(z / 2)

    # qx = (cx, sx, 0, 0) as (w,x,y,z), and so on.
    def multiply(a, b):
        aw, ax, ay, az = a
        bw, bx, by, bz = b
        return (
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        )

    qx = (cx, sx, 0.0, 0.0)
    qy = (cy, 0.0, sy, 0.0)
    qz = (cz, 0.0, 0.0, sz)
    w, x_, y_, z_ = multiply(qz, multiply(qy, qx))
    return (x_, y_, z_, w)


def sample_channel(frames: np.ndarray, values: np.ndarray, frame: float) -> np.ndarray | float:
    """Value of a channel at a (possibly fractional) frame, linearly interpolated."""
    if frames.size == 0:
        return 0.0 if values.ndim == 1 else np.zeros(values.shape[1], np.float32)
    if frame <= frames[0]:
        return values[0]
    if frame >= frames[-1]:
        return values[-1]
    index = int(np.searchsorted(frames, frame))
    lo, hi = index - 1, index
    span = frames[hi] - frames[lo]
    t = 0.0 if span <= 0 else float((frame - frames[lo]) / span)
    return values[lo] + (values[hi] - values[lo]) * t
