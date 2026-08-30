"""What survives the reduction from world snapshot to obstacles."""

from __future__ import annotations

from tre_extract.blockers import MIN_FOOTPRINT_METRES, Blocker, _unshared, footprint_radius


def test_shared_prefix_is_stripped_only_from_the_basename() -> None:
    """The snapshot names the client template; the index keys the server one.

    Only the file name carries the prefix. Stripping it anywhere else would
    mangle a directory that happens to contain the word.
    """
    assert (
        _unshared("object/building/naboo/shared_cantina_naboo.iff")
        == "object/building/naboo/cantina_naboo.iff"
    )
    # Already unshared, or no prefix at all: left alone.
    assert _unshared("object/static/rock.iff") == "object/static/rock.iff"
    # No directory: the prefix still goes, and no stray slash appears.
    assert _unshared("shared_thing.iff") == "thing.iff"


def test_footprint_radius_is_the_diagonal_not_a_side() -> None:
    """A box's corner reaches further than its edge.

    Using a side would let a plan sit on the corner of a building it was told
    it had cleared.
    """
    blocker = Blocker(
        template="t", model="m", x=0, z=0, yaw=0, half_x=3.0, half_z=4.0, height=2.0
    )
    assert footprint_radius(blocker) == 5.0


def test_the_size_floor_is_where_scenery_stops_being_an_obstacle() -> None:
    """A metre is the line, and it is there to exclude litter.

    The snapshot has more sub-metre objects -- dropped weapons, tools, trash --
    than it has buildings, and none of them stop a city being built.
    """
    assert MIN_FOOTPRINT_METRES == 1.0
