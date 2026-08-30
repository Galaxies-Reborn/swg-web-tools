"""Bind a decoded ``.ans`` clip onto a skeleton, as glTF animation channels.

The animation and the skeleton are authored separately and only meet here. An
animation names its bones as strings; the skeleton owns the joint order that
glTF channels must target. Matching is case-insensitive because an animation
writes ``lclav`` where its skeleton writes ``lClav`` — the same mismatch the
mesh binding hits.

Two conversions have to agree with the geometry, or a correctly-decoded clip
still plays wrong:

* **Handedness.** Geometry negates Z. Translations must negate Z too, and
  rotations must mirror: x and y negate, z and w do not.
* **Static versus animated.** A channel index addresses the animated list when
  its mask bit is set and the static list when it is clear. A bone with a
  static rotation is simply not animated — emitting a constant channel for it
  would be correct but wasteful, so it is skipped.

Crucially, a clip's stored values are **not** a joint's local transform.
Skeleton.cpp composes::

    localRotation    = post * ((animationRotation * bindRotation) * pre)
    localTranslation = bindTranslation + animationTranslation

A glTF channel replaces the node's transform outright, so that composition has
to be baked into every key. Writing the raw value instead leaves the model
correct at rest and rotates it bodily as soon as anything plays.
"""

from __future__ import annotations

import numpy as np

from .formats.animation import (
    SATCCF_X_TRANSLATION,
    SATCCF_Y_TRANSLATION,
    SATCCF_Z_TRANSLATION,
    Animation,
    sample_channel,
)
from .formats.skeleton import Skeleton, quat_multiply
from .gltf import GltfAnimation, GltfAnimationChannel

_TRANSLATION_BITS = (SATCCF_X_TRANSLATION, SATCCF_Y_TRANSLATION, SATCCF_Z_TRANSLATION)


def build_animation(
    animation: Animation,
    skeleton: Skeleton,
    *,
    name: str | None = None,
    convert_handedness: bool = True,
) -> GltfAnimation | None:
    """Convert a clip into glTF channels against a skeleton, or None if unusable."""
    if animation.is_empty or animation.frames_per_second <= 0:
        return None

    joint_by_name = {bone.name.lower(): index for index, bone in enumerate(skeleton.bones)}
    fps = animation.frames_per_second
    channels: list[GltfAnimationChannel] = []

    for transform in animation.transforms:
        joint = joint_by_name.get(transform.name.lower())
        if joint is None:
            # A clip authored for a different skeleton; the caller decides
            # whether that is worth reporting.
            continue

        rotation = _rotation_channel(
            animation, transform, joint, fps, convert_handedness, skeleton
        )
        if rotation is not None:
            channels.append(rotation)

        translation = _translation_channel(
            animation, transform, joint, fps, convert_handedness, skeleton
        )
        if translation is not None:
            channels.append(translation)

    if not channels:
        return None
    return GltfAnimation(name=name or _clip_name(animation.name), channels=channels)


def coverage(animation: Animation, skeleton: Skeleton) -> float:
    """How well a clip and a skeleton correspond, as the weaker of two ratios.

    Asking only "are the clip's bones present?" is not enough, and the failure
    is not subtle. `orb_loc_walk` animates two bones; both exist on the rancor,
    so it scores a perfect 1.0 and binds — producing a rancor that twitches one
    joint. Small clips pass that test against almost any skeleton.

    So the reverse question is asked as well: how much of the *skeleton* does
    the clip drive? On real data the two together separate cleanly — against
    the rancor's 45 bones, its own walk scores 1.00/0.98 while frog, tauntaun,
    orb and bantha walks score at most 0.57/0.40. Taking the minimum lets one
    threshold reject all of them.
    """
    if not animation.transforms or not skeleton.bones:
        return 0.0
    skeleton_names = {bone.name.lower() for bone in skeleton.bones}
    clip_names = {t.name.lower() for t in animation.transforms}
    matched = len(clip_names & skeleton_names)
    return min(matched / len(clip_names), matched / len(skeleton_names))


# --- channel construction --------------------------------------------------


def _rotation_channel(
    animation: Animation,
    transform,
    joint: int,
    fps: float,
    convert: bool,
    skeleton: Skeleton,
) -> GltfAnimationChannel | None:
    if not transform.has_animated_rotation:
        # Static rotations belong to the rest pose, which the skin already
        # carries; animating them would be a constant channel.
        return None
    index = transform.rotation_channel
    if index < 0 or index >= len(animation.rotation_channels):
        return None

    frames, rotations = animation.rotation_channels[index]
    if frames.size == 0:
        return None

    # Bake the engine's composition into every key: a clip stores a rotation
    # relative to bind pose, wrapped by the joint's pre and post rotations.
    bone = skeleton.bones[joint]
    values = np.empty((len(rotations), 4), np.float64)
    for i, animated in enumerate(rotations):
        values[i] = quat_multiply(
            bone.post_rotation,
            quat_multiply(
                quat_multiply(
                    (
                        float(animated[0]),
                        float(animated[1]),
                        float(animated[2]),
                        float(animated[3]),
                    ),
                    bone.bind_rotation,
                ),
                bone.pre_rotation,
            ),
        )

    if convert:
        # Mirroring through the XY plane flips the sense of rotation about the
        # two axes that remain.
        values[:, 0] *= -1.0
        values[:, 1] *= -1.0

    return GltfAnimationChannel(
        joint=joint,
        path="rotation",
        times=_times(frames, fps),
        values=values.astype(np.float32),
    )


def _translation_channel(
    animation: Animation,
    transform,
    joint: int,
    fps: float,
    convert: bool,
    skeleton: Skeleton,
) -> GltfAnimationChannel | None:
    animated_axes = [
        axis for axis in range(3) if (transform.translation_mask & _TRANSLATION_BITS[axis]) != 0
    ]
    if not animated_axes:
        return None

    # The three axes are independent channels with their own keys, so resample
    # all of them onto the union of the animated axes' frames. glTF has one
    # timeline per channel and no way to express three separate ones.
    frame_union = sorted(
        {
            float(f)
            for axis in animated_axes
            for f in _axis_frames(animation, transform, axis)
        }
    )
    if not frame_union:
        return None

    values = np.zeros((len(frame_union), 3), np.float64)
    for axis in range(3):
        index = transform.translation_channels[axis]
        if (transform.translation_mask & _TRANSLATION_BITS[axis]) != 0:
            if index < 0 or index >= len(animation.translation_channels):
                continue
            frames, samples = animation.translation_channels[index]
            for row, frame in enumerate(frame_union):
                values[row, axis] = sample_channel(frames, samples, frame)
        else:
            # A static axis holds one value for the whole clip.
            if 0 <= index < len(animation.static_translations):
                values[:, axis] = animation.static_translations[index]

    # A clip stores an offset from the bind translation, not a position.
    values += np.array(skeleton.bones[joint].translation, np.float64)

    if convert:
        values[:, 2] *= -1.0

    return GltfAnimationChannel(
        joint=joint,
        path="translation",
        times=_times(np.array(frame_union, np.float32), fps),
        values=values.astype(np.float32),
    )


def _axis_frames(animation: Animation, transform, axis: int) -> np.ndarray:
    index = transform.translation_channels[axis]
    if index < 0 or index >= len(animation.translation_channels):
        return np.zeros(0, np.float32)
    return animation.translation_channels[index][0]


def _times(frames: np.ndarray, fps: float) -> np.ndarray:
    """Frame numbers to seconds, forced strictly increasing.

    glTF requires an animation input to ascend. A few shipped clips repeat a
    frame number, which some loaders reject outright.
    """
    times = np.asarray(frames, dtype=np.float64) / fps
    for i in range(1, times.size):
        if times[i] <= times[i - 1]:
            times[i] = times[i - 1] + 1e-6
    return times.astype(np.float32)


def _clip_name(path: str) -> str:
    """`appearance/animation/all_b_stand.ans` → `all_b_stand`."""
    stem = path.replace("\\", "/").rsplit("/", 1)[-1]
    return stem[:-4] if stem.lower().endswith(".ans") else stem
