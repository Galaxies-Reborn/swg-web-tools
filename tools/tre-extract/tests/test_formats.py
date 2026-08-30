"""Format tests that need no game data — they build the bytes they parse."""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest

from tre_extract.animate import coverage
from tre_extract.convert import _rotation_to_quaternion
from tre_extract.formats.animation import Animation, TransformInfo
from tre_extract.formats.hardpoint import Hardpoint, dedupe, read_hardpoints
from tre_extract.formats.mesh import (
    SPSPT_INDEXED_TRIANGLE_LIST,
    SPSPT_LINE_LIST,
    SPSPT_TRIANGLE_FAN,
    SPSPT_TRIANGLE_STRIP,
    _to_triangles,
)
from tre_extract.formats.skeleton import Bone, Skeleton
from tre_extract.formats.vertex import F_NORMAL, F_POSITION, VertexFormat, decode_vertex_buffer
from tre_extract.gltf import GlbBuilder, GltfMesh, GltfPrimitive
from tre_extract.iff import ChunkReader, IffError, parse, tag, tag_name
from tre_extract.manifest import Manifest, ManifestEntry, display_name

# --- IFF -------------------------------------------------------------------


def chunk(name: str, payload: bytes) -> bytes:
    return name.encode("ascii").ljust(4) + len(payload).to_bytes(4, "big") + payload


def form(name: str, *children: bytes) -> bytes:
    body = name.encode("ascii").ljust(4) + b"".join(children)
    return b"FORM" + len(body).to_bytes(4, "big") + body


def test_iff_round_trip():
    data = form("MESH", form("0005", chunk("INFO", b"\x01\x00\x00\x00")))
    root = parse(data)
    assert root.name.strip() == "MESH"
    assert root.only_child().name == "0005"
    assert root.find("0005", "INFO") is not None
    assert root.find("0005", "INFO").reader().i32() == 1


def test_iff_rejects_a_length_past_eof():
    bad = b"FORM" + (999).to_bytes(4, "big") + b"MESH"
    with pytest.raises(IffError):
        parse(bad)


def test_iff_does_not_pad_odd_nodes():
    # SWG omits the classic IFF pad byte. If parse() added one, the second
    # chunk would start a byte late and its tag would come out garbled.
    data = form("TEST", chunk("AAAA", b"\x01"), chunk("BBBB", b"\x02"))
    root = parse(data)
    assert [c.name for c in root.children] == ["AAAA", "BBBB"]
    assert root.children[1].data == b"\x02"


def test_tags_round_trip():
    assert tag_name(tag("MESH")) == "MESH"
    assert tag_name(tag("SPS")) == "SPS "


def test_chunk_reader_reads_little_endian():
    reader = ChunkReader(struct.pack("<Ifb", 7, 1.5, 1) + b"hi\0")
    assert reader.u32() == 7
    assert reader.f32() == 1.5
    assert reader.bool8() is True
    assert reader.cstring() == "hi"
    assert reader.eof()


# --- vertex formats --------------------------------------------------------


def test_vertex_format_stride_accounts_for_texcoord_dimension():
    # position + normal + one 4D texcoord set.
    flags = F_POSITION | F_NORMAL | (1 << 8) | (0b11 << 12)
    fmt = VertexFormat(flags)
    assert fmt.texcoord_sets == 1
    assert fmt.texcoord_dim(0) == 4
    assert fmt.stride == 12 + 12 + 16


def test_decode_vertex_buffer_splits_attributes():
    flags = F_POSITION | F_NORMAL | (1 << 8) | (0b01 << 12)  # one 2D set
    payload = struct.pack("<8f", 1, 2, 3, 0, 1, 0, 0.25, 0.75)
    data = decode_vertex_buffer(flags, 1, payload)
    assert data.count == 1
    np.testing.assert_allclose(data.positions[0], [1, 2, 3])
    np.testing.assert_allclose(data.normals[0], [0, 1, 0])
    np.testing.assert_allclose(data.uv_set(0)[0], [0.25, 0.75])


def test_decode_vertex_buffer_rejects_short_payloads():
    with pytest.raises(IffError):
        decode_vertex_buffer(F_POSITION, 4, b"\x00" * 8)


# --- topology --------------------------------------------------------------


def test_triangle_list_passes_through():
    indices = np.array([0, 1, 2, 2, 3, 4], np.uint32)
    tris = _to_triangles(SPSPT_INDEXED_TRIANGLE_LIST, indices)
    assert tris.tolist() == [[0, 1, 2], [2, 3, 4]]


def test_strip_alternates_winding_and_drops_degenerates():
    tris = _to_triangles(SPSPT_TRIANGLE_STRIP, np.array([0, 1, 2, 3], np.uint32))
    assert tris.tolist() == [[0, 1, 2], [1, 3, 2]]
    # A repeated index is how strips stitch; it must not survive.
    stitched = _to_triangles(SPSPT_TRIANGLE_STRIP, np.array([0, 1, 1, 1, 2, 3], np.uint32))
    assert all(len(set(t)) == 3 for t in stitched.tolist())


def test_fan_shares_the_hub_vertex():
    tris = _to_triangles(SPSPT_TRIANGLE_FAN, np.array([0, 1, 2, 3], np.uint32))
    assert tris.tolist() == [[0, 1, 2], [0, 2, 3]]


def test_non_triangle_topologies_are_dropped():
    assert _to_triangles(SPSPT_LINE_LIST, np.array([0, 1], np.uint32)) is None


# --- glTF ------------------------------------------------------------------


def _single_triangle_glb(**kwargs) -> tuple[dict, bytes]:
    builder = GlbBuilder(**kwargs)
    builder.add_mesh(
        GltfMesh(
            name="tri",
            primitives=[
                GltfPrimitive(
                    positions=np.array([[0, 0, 0], [1, 0, 0], [0, 1, 2]], np.float32),
                    indices=np.array([[0, 1, 2]], np.uint32),
                )
            ],
        )
    )
    blob = builder.build()
    json_len = struct.unpack("<I", blob[12:16])[0]
    return json.loads(blob[20 : 20 + json_len]), blob


def test_glb_header_declares_its_own_length():
    _, blob = _single_triangle_glb()
    magic, version, total = struct.unpack("<III", blob[:12])
    assert magic == 0x46546C67
    assert version == 2
    assert total == len(blob)


def test_handedness_conversion_negates_z_and_flips_winding():
    gltf, _ = _single_triangle_glb(convert_handedness=True)
    position = gltf["accessors"][0]
    # The z=2 vertex must land at -2 after conversion.
    assert position["min"][2] == -2.0
    assert position["max"][2] == 0.0

    flat, _ = _single_triangle_glb(convert_handedness=False)
    assert flat["accessors"][0]["max"][2] == 2.0


def test_accessors_stay_inside_their_buffer_views():
    gltf, _ = _single_triangle_glb()
    sizes = {5126: 4, 5125: 4, 5123: 2}
    counts = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    buffer_length = gltf["buffers"][0]["byteLength"]
    for accessor in gltf["accessors"]:
        view = gltf["bufferViews"][accessor["bufferView"]]
        needed = accessor["count"] * sizes[accessor["componentType"]] * counts[accessor["type"]]
        assert needed <= view["byteLength"]
        assert view["byteOffset"] + view["byteLength"] <= buffer_length


# --- manifest --------------------------------------------------------------


def test_display_name_strips_lod_suffixes():
    assert display_name("mesh/frn_tato_vase_s02_l0") == "Frn Tato Vase S02"
    assert display_name("mesh/ins_all_mobile_ore_refinery_l1") == "Ins All Mobile Ore Refinery"


# --- manifest merging ------------------------------------------------------


def _entry(key: str) -> ManifestEntry:
    return ManifestEntry(
        key=key,
        name=key,
        kind="static",
        model=f"models/{key}.glb",
        bounds={"min": [0, 0, 0], "max": [1, 1, 1]},
        triangles=1,
        vertices=3,
        lodCount=1,
        materials=0,
        textures=0,
        sizeBytes=100,
    )


def test_manifest_merge_carries_forward_earlier_runs(tmp_path):
    # A narrow --pattern run must not unpublish everything a previous run
    # produced, which is what a plain overwrite would do while leaving the
    # .glb files on disk.
    existing = Manifest(generatedAt="t0", generator="test", sourceLabel="x")
    existing.entries.append(_entry("mesh/old_asset"))
    path = tmp_path / "manifest.json"
    existing.write(path)

    fresh = Manifest(generatedAt="t1", generator="test", sourceLabel="x")
    fresh.entries.append(_entry("mesh/new_asset"))
    carried = fresh.merge_existing(path)

    assert carried == 1
    assert {e.key for e in fresh.entries} == {"mesh/old_asset", "mesh/new_asset"}


def test_manifest_merge_prefers_the_current_run(tmp_path):
    old = Manifest(generatedAt="t0", generator="test", sourceLabel="x")
    stale = _entry("mesh/asset")
    stale.triangles = 999
    old.entries.append(stale)
    path = tmp_path / "manifest.json"
    old.write(path)

    fresh = Manifest(generatedAt="t1", generator="test", sourceLabel="x")
    fresh.entries.append(_entry("mesh/asset"))
    assert fresh.merge_existing(path) == 0
    assert len(fresh.entries) == 1
    assert fresh.entries[0].triangles == 1


def test_manifest_merge_tolerates_a_missing_file(tmp_path):
    fresh = Manifest(generatedAt="t", generator="test", sourceLabel="x")
    assert fresh.merge_existing(tmp_path / "not-there.json") == 0


# --- animation binding -----------------------------------------------------


def _skeleton(*names: str) -> Skeleton:
    identity = (0.0, 0.0, 0.0, 1.0)
    return Skeleton(
        name="test",
        bones=[
            Bone(
                name=name,
                parent=index - 1,
                translation=(0.0, 0.0, 0.0),
                bind_rotation=identity,
                pre_rotation=identity,
                post_rotation=identity,
            )
            for index, name in enumerate(names)
        ],
    )


def _clip(*names: str) -> Animation:
    return Animation(
        name="clip",
        version=3,
        compressed=False,
        frames_per_second=30.0,
        frame_count=1,
        transforms=[
            TransformInfo(
                name=name,
                has_animated_rotation=False,
                rotation_channel=0,
                translation_mask=0,
                translation_channels=(0, 0, 0),
            )
            for name in names
        ],
    )


def test_coverage_rejects_a_small_clip_that_fits_any_skeleton():
    """The failure that motivated measuring both directions.

    `orb_loc_walk` animates two bones. Both exist on the rancor, so asking only
    "are the clip's bones present?" scores it a perfect 1.0 and binds it —
    giving a rancor that twitches a single joint. It has to be rejected for
    driving almost none of the skeleton.
    """
    skeleton = _skeleton(*(f"bone{i}" for i in range(20)))
    assert coverage(_clip("bone0", "bone1"), skeleton) == pytest.approx(2 / 20)


def test_coverage_accepts_a_clip_authored_for_the_skeleton():
    skeleton = _skeleton(*(f"bone{i}" for i in range(20)))
    assert coverage(_clip(*(f"bone{i}" for i in range(20))), skeleton) == pytest.approx(1.0)


def test_coverage_rejects_a_clip_from_a_different_skeleton():
    # Half the names line up, which is exactly the near-miss case: tauntaun
    # clips scored this way against the rancor.
    skeleton = _skeleton(*(f"bone{i}" for i in range(20)))
    other = _clip(*(f"bone{i}" for i in range(10)), *(f"alien{i}" for i in range(10)))
    assert coverage(other, skeleton) == pytest.approx(0.5)


def test_coverage_of_an_empty_clip_or_skeleton_is_zero():
    assert coverage(_clip(), _skeleton("bone0")) == 0.0
    assert coverage(_clip("bone0"), _skeleton()) == 0.0


def test_coverage_ignores_case():
    """An animation writes `lclav` where its skeleton writes `lClav`."""
    assert coverage(_clip("lClav", "rClav"), _skeleton("lclav", "rclav")) == pytest.approx(1.0)


# --- hardpoints ------------------------------------------------------------


def _hpnt(name: str, matrix: list[float]) -> bytes:
    """One HPNT chunk: 12 floats then a NUL-terminated name."""
    return struct.pack("<12f", *matrix) + name.encode("latin-1") + b"\0"


def _appearance_with_hardpoints(*chunks: bytes) -> bytes:
    """A minimal IFF file carrying an HPTS form, as an appearance would."""

    def chunk(tag_name: str, payload: bytes) -> bytes:
        return tag_name.encode("latin-1") + struct.pack(">I", len(payload)) + payload

    def form(type_name: str, payload: bytes) -> bytes:
        body = type_name.encode("latin-1") + payload
        return b"FORM" + struct.pack(">I", len(body)) + body

    hpts = form("HPTS", b"".join(chunk("HPNT", c) for c in chunks))
    return form("APPR", form("0003", hpts))


IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]


def test_hardpoints_decode_transform_and_name():
    data = _appearance_with_hardpoints(
        _hpnt("muzzle1", [*IDENTITY[:3], 1.5, *IDENTITY[4:7], 2.5, *IDENTITY[8:11], 3.5])
    )
    points = read_hardpoints(data)
    assert len(points) == 1
    assert points[0].name == "muzzle1"
    # Translation is the last column of each row, not a trailing vector.
    assert points[0].translation == pytest.approx((1.5, 2.5, 3.5))


def test_hardpoints_absent_is_not_an_error():
    """Most appearances have none, and the exporter wrote no form at all."""
    assert read_hardpoints(b"FORM\x00\x00\x00\x04TEST") == []
    assert read_hardpoints(b"") == []


def test_hardpoint_mirror_matches_the_geometry_conversion():
    """Mirroring a transform is S*M*S, not just a negated translation.

    Negating only the translation leaves the rotation describing the unmirrored
    space, which points an attachment backwards even when its position looks
    right.
    """
    # A 90-degree yaw: x axis maps to -z, z axis maps to x.
    yaw = ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (-1.0, 0.0, 0.0))
    point = Hardpoint(name="wing1", rotation=yaw, translation=(1.0, 2.0, 3.0))
    mirrored = point.mirrored_z()

    assert mirrored.translation == pytest.approx((1.0, 2.0, -3.0))
    # The terms coupling Z to X and Y flip; m[2][2] does not.
    assert mirrored.rotation[0][2] == pytest.approx(-1.0)
    assert mirrored.rotation[2][0] == pytest.approx(1.0)
    assert mirrored.rotation[2][2] == pytest.approx(0.0)
    # Mirroring twice is the identity.
    for actual_row, expected_row in zip(mirrored.mirrored_z().rotation, yaw, strict=True):
        assert actual_row == pytest.approx(expected_row)


def test_hardpoints_dedupe_keeps_the_first_definition():
    """A .lod repeats its hardpoints per detail level; only l0 is exported."""
    a = Hardpoint("muzzle1", ((1.0, 0, 0), (0, 1.0, 0), (0, 0, 1.0)), (1.0, 0.0, 0.0))
    b = Hardpoint("MUZZLE1", ((1.0, 0, 0), (0, 1.0, 0), (0, 0, 1.0)), (9.0, 0.0, 0.0))
    kept = dedupe([a, b])
    assert len(kept) == 1
    assert kept[0].translation[0] == pytest.approx(1.0)


@pytest.mark.parametrize(
    "rows",
    [
        ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
        # 180 degrees about Y: trace is -1, so the naive trace formula divides
        # by zero. Mirrored hardpoints are routinely this.
        ((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, -1.0)),
        ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (-1.0, 0.0, 0.0)),
        ((1.0, 0.0, 0.0), (0.0, -1.0, 0.0), (0.0, 0.0, -1.0)),
    ],
)
def test_rotation_to_quaternion_round_trips(rows):
    q = _rotation_to_quaternion(rows)
    assert sum(c * c for c in q) == pytest.approx(1.0)

    # Rebuild the basis from the quaternion and compare.
    x, y, z, w = q
    rebuilt = (
        (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
        (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
        (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
    )
    for actual_row, expected_row in zip(rebuilt, rows, strict=True):
        assert actual_row == pytest.approx(expected_row, abs=1e-6)
