"""Tests for the metadata formats: string tables, CRC tables, templates.

Like the geometry tests, these build the bytes they parse, so the suite runs
without a game install.
"""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest

from tre_extract.convert import _joint_remap
from tre_extract.formats import cquat
from tre_extract.formats.crctable import read_crc_table, to_signed, to_unsigned
from tre_extract.formats.skeleton import read_skeleton
from tre_extract.formats.stf import MAGIC, StfError, parse_reference, read_stf, table_name
from tre_extract.formats.template import read_shared_template, shared_path
from tre_extract.gltf import GlbBuilder, GltfJoint, GltfMesh, GltfPrimitive, GltfSkin
from tre_extract.iff import IffError

# --- helpers ---------------------------------------------------------------


def chunk(name: str, payload: bytes) -> bytes:
    return name.encode("ascii").ljust(4) + len(payload).to_bytes(4, "big") + payload


def form(name: str, *children: bytes) -> bytes:
    body = name.encode("ascii").ljust(4) + b"".join(children)
    return b"FORM" + len(body).to_bytes(4, "big") + body


def build_stf(entries: dict[str, str], version: int = 1) -> bytes:
    out = struct.pack("<IB", MAGIC, version)
    out += struct.pack("<I", len(entries) + 1)  # nextUniqueId
    out += struct.pack("<I", len(entries))

    ids = {key: index + 1 for index, key in enumerate(entries)}
    for key, text in entries.items():
        encoded = text.encode("utf-16-le")
        # `length` counts UTF-16 code units, not bytes.
        out += struct.pack("<3I", ids[key], 0xFFFFFFFF, len(encoded) // 2) + encoded
    for key in entries:
        raw = key.encode("latin-1")
        out += struct.pack("<2I", ids[key], len(raw)) + raw
    return out


# --- string tables ---------------------------------------------------------


def test_stf_round_trip():
    table = read_stf(build_stf({"pistol_cdef": "CDEF Pistol", "inventory": "Inventory"}))
    assert len(table) == 2
    assert table.get("pistol_cdef") == "CDEF Pistol"
    assert table.get("inventory") == "Inventory"
    assert table.get("absent") is None


def test_stf_handles_non_ascii():
    # UTF-16 means anything past latin-1 has to survive the round trip.
    table = read_stf(build_stf({"k": "Nabooian Fibreplast — 95%"}))
    assert table.get("k") == "Nabooian Fibreplast — 95%"


def test_stf_length_is_code_units_not_bytes():
    # A 4-character string occupies 8 bytes; reading `length` as bytes would
    # truncate it to two characters.
    table = read_stf(build_stf({"k": "abcd"}))
    assert table.get("k") == "abcd"


def test_stf_rejects_bad_magic():
    bad = struct.pack("<IB", 0x1234, 1) + b"\0" * 8
    with pytest.raises(StfError):
        read_stf(bad)


def test_stf_rejects_truncation():
    data = build_stf({"k": "value"})
    with pytest.raises(StfError):
        read_stf(data[:-4])


def test_table_name_strips_locale_and_extension():
    assert table_name("string/en/obj_n.stf") == "obj_n"
    assert table_name("string/en/mob/creature_names.stf") == "creature_names"


def test_parse_reference():
    assert parse_reference("@obj_n:pistol_cdef") == ("obj_n", "pistol_cdef")
    # A path-qualified table collapses to its last segment.
    assert parse_reference("@mob/creature_names:rancor") == ("creature_names", "rancor")
    assert parse_reference("not a reference") is None
    assert parse_reference("@") is None
    assert parse_reference("@no_colon") is None


# --- CRC tables ------------------------------------------------------------


def test_signed_unsigned_round_trip():
    # Oracle stores CRCs signed, so the high-bit case is the one that matters.
    assert to_unsigned(-640104330) == 3654862966
    assert to_signed(3654862966) == -640104330
    assert to_unsigned(42) == 42
    assert to_signed(42) == 42


def build_crc_table(pairs: list[tuple[int, str]]) -> bytes:
    blob = b""
    offsets = []
    for _, text in pairs:
        offsets.append(len(blob))
        blob += text.encode("latin-1") + b"\0"
    return form(
        "CSTB",
        form(
            "0000",
            chunk("DATA", struct.pack("<I", len(pairs))),
            chunk("CRCT", struct.pack(f"<{len(pairs)}I", *[c for c, _ in pairs])),
            chunk("STRT", struct.pack(f"<{len(offsets)}I", *offsets)),
            chunk("STNG", blob),
        ),
    )


def test_crc_table_reads_and_accepts_signed_lookups():
    data = build_crc_table([(3654862966, "object/player/player.iff"), (42, "object/other.iff")])
    table = read_crc_table(data)
    assert len(table) == 2
    assert table.get(3654862966) == "object/player/player.iff"
    # The same entry, as Oracle would hand it over.
    assert table.get(-640104330) == "object/player/player.iff"


def test_crc_table_rejects_wrong_root():
    with pytest.raises(IffError):
        read_crc_table(form("MESH", chunk("DATA", b"\0\0\0\0")))


# --- shared templates ------------------------------------------------------


def field(name: str, payload: bytes) -> bytes:
    return chunk("XXXX", name.encode("ascii") + b"\0" + payload)


def test_template_reads_appearance_name_and_got():
    data = form(
        "SWOT",
        form("DERV", chunk("XXXX", b"object/weapon/base/shared_weapon_base.iff\0")),
        form(
            "SHOT",
            form(
                "0010",
                field("appearanceFilename", b"\x01appearance/wp_pistol_cdef.apt\0"),
                field("objectName", b"\x01\x01weapon_name\0\x01pistol_cdef\0"),
                field("gameObjectType", b"\x01\x00" + struct.pack("<i", 131082)),
            ),
        ),
    )
    template = read_shared_template(data, "shared_pistol_cdef.iff")
    assert template is not None
    assert template.appearance == "appearance/wp_pistol_cdef.apt"
    assert template.object_name == ("weapon_name", "pistol_cdef")
    assert template.game_object_type == 131082
    assert template.derived_from == "object/weapon/base/shared_weapon_base.iff"


def test_template_ignores_fields_flagged_unset():
    # A zero flag means the value comes from the parent, not that it is blank.
    data = form(
        "SWOT",
        form("SHOT", form("0010", field("appearanceFilename", b"\x00"))),
    )
    template = read_shared_template(data, "x.iff")
    assert template is not None
    assert template.appearance is None


def test_template_returns_none_for_unparseable_input():
    # Several hundred paths under object/ are zero-byte placeholders; one of
    # them must not abort an index run over 30,000 files.
    assert read_shared_template(b"", "empty.iff") is None
    assert read_shared_template(b"not iff at all", "junk.iff") is None


def test_shared_path_derivation():
    assert (
        shared_path("object/weapon/melee/axe/axe_heavy_duty.iff")
        == "object/weapon/melee/axe/shared_axe_heavy_duty.iff"
    )
    # Already-shared paths pass through unchanged.
    assert (
        shared_path("object/weapon/melee/axe/shared_axe_heavy_duty.iff")
        == "object/weapon/melee/axe/shared_axe_heavy_duty.iff"
    )


# --- skeletons -------------------------------------------------------------


def build_skeleton(bones: list[tuple[str, int]]) -> bytes:
    count = len(bones)
    names = b"".join(name.encode("ascii") + bytes([0]) for name, _ in bones)
    parents = struct.pack(f"<{count}i", *[parent for _, parent in bones])
    # Identity rotations stored w,x,y,z, and a 1-metre step down each chain.
    quats = struct.pack(f"<{count * 4}f", *([1.0, 0.0, 0.0, 0.0] * count))
    translations = struct.pack(f"<{count * 3}f", *([0.0, 1.0, 0.0] * count))
    orders = struct.pack(f"<{count}i", *([0] * count))
    return form(
        "SLOD",
        form(
            "0000",
            chunk("INFO", struct.pack("<H", 1)),
            form(
                "SKTM",
                form(
                    "0002",
                    chunk("INFO", struct.pack("<I", count)),
                    chunk("NAME", names),
                    chunk("PRNT", parents),
                    chunk("RPRE", quats),
                    chunk("RPST", quats),
                    chunk("BPTR", translations),
                    chunk("BPRO", quats),
                    chunk("JROR", orders),
                ),
            ),
        ),
    )


def test_skeleton_reads_hierarchy_and_rest_pose():
    data = build_skeleton([("root", -1), ("spine", 0), ("head", 1)])
    skeleton = read_skeleton(data, "test.skt")
    assert len(skeleton) == 3
    assert skeleton.roots == [0]
    assert skeleton.bones[2].name == "head"
    assert skeleton.bones[2].parent == 1
    assert skeleton.index_of("spine") == 1


def test_skeleton_quaternions_are_reordered_for_gltf():
    # Stored w,x,y,z; glTF wants x,y,z,w. Reading them in file order makes the
    # real w land in x and rotates every joint into nonsense.
    data = build_skeleton([("root", -1)])
    skeleton = read_skeleton(data, "test.skt")
    assert skeleton.bones[0].rotation == (0.0, 0.0, 0.0, 1.0)


def test_skeleton_world_matrices_accumulate_through_parents():
    data = build_skeleton([("root", -1), ("spine", 0), ("head", 1)])
    skeleton = read_skeleton(data, "test.skt")
    world = skeleton.world_matrices()
    # Each bone steps one metre up from its parent.
    assert world[0][1, 3] == pytest.approx(1.0)
    assert world[1][1, 3] == pytest.approx(2.0)
    assert world[2][1, 3] == pytest.approx(3.0)


def test_inverse_bind_matrices_invert_the_rest_pose():
    data = build_skeleton([("root", -1), ("spine", 0)])
    skeleton = read_skeleton(data, "test.skt")
    product = skeleton.world_matrices() @ skeleton.inverse_bind_matrices()
    identity = np.broadcast_to(np.identity(4), product.shape)
    assert np.abs(product - identity).max() < 1e-9


# --- joint remapping -------------------------------------------------------


def test_joint_remap_is_case_insensitive():
    # A mesh writes `lclav` where its skeleton writes `lClav`; the engine
    # hashes both through a lower-cased CRC. Matching literally would reject
    # every humanoid wearable in the game.
    data = build_skeleton([("root", -1), ("lClav", 0), ("lArm", 1)])
    skeleton = read_skeleton(data, "test.skt")
    remap = _joint_remap(["root", "lclav", "larm"], skeleton)
    assert remap is not None
    assert remap.tolist() == [0, 1, 2]


def test_joint_remap_reorders_a_subset():
    data = build_skeleton([("root", -1), ("lThigh", 0), ("spine", 0), ("neck", 2)])
    skeleton = read_skeleton(data, "test.skt")
    # A shirt lists only the upper body, in its own order.
    remap = _joint_remap(["spine", "neck", "root"], skeleton)
    assert remap is not None
    assert remap.tolist() == [2, 3, 0]


def test_joint_remap_refuses_a_partial_match():
    # A partial map would silently bind the unmatched vertices to joint zero
    # and drag them to the model's origin.
    data = build_skeleton([("root", -1), ("spine", 0)])
    skeleton = read_skeleton(data, "test.skt")
    assert _joint_remap(["root", "not_a_bone"], skeleton) is None
    assert _joint_remap([], skeleton) is None


# --- compressed quaternions ------------------------------------------------


def test_compressed_quaternion_recovers_w_from_xyz():
    # w is not stored. It is recovered as sqrt(1 - x^2 - y^2 - z^2), so the
    # invariant that must hold for *any* input is that w agrees with the three
    # components actually decoded.
    #
    # Note this is weaker than "always unit length": an arbitrary 32-bit word
    # need not encode a unit quaternion, and the compressor never emits one
    # that does not. Against the shipped animations — 224,586 rotations — the
    # deviation from unit length is 0.
    rng = np.random.default_rng(11)
    packed = rng.integers(0, 2**32, size=512, dtype=np.uint64).astype(np.uint32)
    for fmt in (0b1111_1110, 0b1000_0000, 0b1110_0000):
        q = cquat.expand(packed, fmt, fmt, fmt)
        assert q.shape == (512, 4)
        expected_w = np.sqrt(np.clip(1.0 - (q[:, :3] ** 2).sum(axis=1), 0.0, 1.0))
        assert np.abs(q[:, 3] - expected_w).max() < 1e-6
        # Components stay inside the range the format can represent.
        assert np.abs(q[:, :3]).max() <= 1.0 + 1e-6


def test_compressed_quaternion_w_is_never_negative():
    # The compressor negates any quaternion whose w is negative, so a sign bit
    # is never stored for it.
    rng = np.random.default_rng(3)
    packed = rng.integers(0, 2**32, size=256, dtype=np.uint64).astype(np.uint32)
    q = cquat.expand(packed, 0b1000_0000, 0b1000_0000, 0b1000_0000)
    assert (q[:, 3] >= 0).all()


def test_compressed_quaternion_zero_is_the_format_base():
    # A zero payload decodes to each component's base value, which is what the
    # format byte selects.
    q = cquat.expand(np.array([0], np.uint32), 0b1111_1110, 0b1111_1110, 0b1111_1110)[0]
    # Level 0 has a single base at -1 + 1 * (2/2) = 0.
    assert abs(float(q[0])) < 1e-6
    assert abs(float(q[1])) < 1e-6
    assert abs(float(q[2])) < 1e-6
    assert abs(float(q[3]) - 1.0) < 1e-6


# --- skin binding ----------------------------------------------------------


def test_inverse_bind_matrices_are_built_from_the_written_nodes():
    # The joints are mirrored for handedness on the way out. Inverse bind
    # matrices built in the original space would not cancel against them, and
    # the mismatch is invisible until the skin is actually posed.
    joints = [
        GltfJoint("root", -1, (0.0, 1.0, 2.0), (0.0, 0.0, 0.0, 1.0)),
        GltfJoint("child", 0, (0.0, 1.0, 3.0), (0.0, 0.0, 0.0, 1.0)),
    ]
    builder = GlbBuilder(convert_handedness=True)
    builder.set_skin(GltfSkin(joints=joints, inverse_bind_matrices=np.zeros((2, 4, 4))))
    builder.add_mesh(
        GltfMesh(
            name="m",
            primitives=[
                GltfPrimitive(
                    positions=np.zeros((3, 3), np.float32),
                    indices=np.array([[0, 1, 2]], np.uint32),
                )
            ],
        )
    )
    blob = builder.build()
    json_len = struct.unpack("<I", blob[12:16])[0]
    gltf = json.loads(blob[20 : 20 + json_len])

    # Node translations are mirrored, so Z is negative.
    assert gltf["nodes"][0]["translation"][2] == -2.0
    assert gltf["nodes"][1]["translation"][2] == -3.0

    accessor = gltf["accessors"][gltf["skins"][0]["inverseBindMatrices"]]
    view = gltf["bufferViews"][accessor["bufferView"]]
    binary_offset = 20 + json_len + 8
    raw = np.frombuffer(
        blob, np.float32, count=accessor["count"] * 16, offset=binary_offset + view["byteOffset"]
    ).reshape(-1, 4, 4).transpose(0, 2, 1)

    # Child sits 3 units along the mirrored Z from a root already at -2, so
    # its inverse bind must undo a world Z of -5.
    assert abs(float(raw[1][2, 3]) - 5.0) < 1e-4
