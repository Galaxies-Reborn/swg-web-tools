"""Quaternion decompression, ported from sharedMath/CompressedQuaternion.cpp.

Most SWG animations pack each rotation into a single 32-bit word::

    [MSB]  x : 11 bits (shift 21)   y : 11 bits (shift 10)   z : 10 bits

``w`` is not stored at all. The compressor flips any quaternion with a
negative ``w`` so the sign is known, and the magnitude is recovered as
``sqrt(1 - (x² + y² + z²))``.

Each component carries a per-channel *format* byte chosen when the animation
was exported. The format encodes two things at once: how wide a value range the
component spans, and where that range is centred. Precision is then spent only
on the range a component actually uses, which is why a bone that barely rotates
still comes back smooth.

A format byte splits into a precision level (0-6) and a base index:

    level 0: id 0b11111110, 1 base,  separation 2/2
    level 1: id 0b11111100, 2 bases, separation 2/3
    ...
    level 6: id 0b10000000, 64 bases, separation 2/65

The base value is ``-1 + (index + 1) * separation``, and the half-range is
``0.5 * 4/(2^level + 1)``. Decoding is then base +/- steps * (halfRange / maxSteps),
with the sign in the top bit of the field.
"""

from __future__ import annotations

import numpy as np

X_SHIFT = 21
Y_SHIFT = 10

ELEVEN_BIT_MASK = 0x3FF  # 1023
ELEVEN_BIT_SIGN = 0x400
TEN_BIT_MASK = 0x1FF  # 511
TEN_BIT_SIGN = 0x200

MAX_FORMAT = 254

#: (formatId, baseIndexMask) per precision level, from s_formatPrecisionInfo.
_PRECISION_LEVELS = (
    (0b1111_1110, 0b0000_0000),
    (0b1111_1100, 0b0000_0001),
    (0b1111_1000, 0b0000_0011),
    (0b1111_0000, 0b0000_0111),
    (0b1110_0000, 0b0000_1111),
    (0b1100_0000, 0b0001_1111),
    (0b1000_0000, 0b0011_1111),
)


def _build_tables() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Precompute base value and expand factors for every format byte.

    Mirrors `CompressedQuaternion::install`, which fills the same table at
    startup. Doing it once here keeps decompression to a pair of array lookups.
    """
    base_values = np.zeros(MAX_FORMAT + 1, np.float64)
    expand_eleven = np.zeros(MAX_FORMAT + 1, np.float64)
    expand_ten = np.zeros(MAX_FORMAT + 1, np.float64)

    for level, (format_id, _mask) in enumerate(_PRECISION_LEVELS):
        base_count = 1 << level
        separation = 2.0 / (base_count + 1)
        half_range = 0.5 * (4.0 / (base_count + 1))

        for index in range(base_count):
            format_byte = (format_id | index) & 0xFF
            if format_byte > MAX_FORMAT:
                continue
            base_values[format_byte] = -1.0 + (index + 1) * separation
            expand_eleven[format_byte] = half_range / ELEVEN_BIT_MASK
            expand_ten[format_byte] = half_range / TEN_BIT_MASK

    return base_values, expand_eleven, expand_ten


_BASE, _EXPAND_11, _EXPAND_10 = _build_tables()


def expand(
    packed: np.ndarray | int,
    x_format: int,
    y_format: int,
    z_format: int,
) -> np.ndarray:
    """Expand packed rotations to glTF-ordered quaternions (x, y, z, w).

    Accepts a scalar or an array of packed words and returns shape (n, 4).
    """
    data = np.atleast_1d(np.asarray(packed, dtype=np.uint32))

    x = _expand_component(data >> X_SHIFT, x_format, eleven_bit=True)
    y = _expand_component(data >> Y_SHIFT, y_format, eleven_bit=True)
    z = _expand_component(data, z_format, eleven_bit=False)

    # w is always non-negative: the compressor negates the whole quaternion
    # when w < 0, which describes the same rotation.
    w = np.sqrt(np.clip(1.0 - (x * x + y * y + z * z), 0.0, 1.0))

    return np.stack([x, y, z, w], axis=1).astype(np.float32)


def _expand_component(field: np.ndarray, format_byte: int, *, eleven_bit: bool) -> np.ndarray:
    format_byte = int(format_byte) & 0xFF
    if format_byte > MAX_FORMAT:
        # An out-of-range format would index past the table; the least precise
        # format is the only one guaranteed to cover the full range.
        format_byte = _PRECISION_LEVELS[0][0]

    if eleven_bit:
        magnitude = (field & ELEVEN_BIT_MASK).astype(np.float64)
        negative = (field & ELEVEN_BIT_SIGN) != 0
        step = _EXPAND_11[format_byte]
    else:
        magnitude = (field & TEN_BIT_MASK).astype(np.float64)
        negative = (field & TEN_BIT_SIGN) != 0
        step = _EXPAND_10[format_byte]

    base = _BASE[format_byte]
    return np.where(negative, base - magnitude * step, base + magnitude * step)
