import pytest

from app.link_resolver import NodeSuffixIndex


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_index(*node_ids: str) -> NodeSuffixIndex:
    idx = NodeSuffixIndex()
    for nid in node_ids:
        idx.register(nid)
    return idx


# ---------------------------------------------------------------------------
# register / unregister
# ---------------------------------------------------------------------------

def test_register_single_node():
    idx = _make_index("!ab1234cd")
    assert len(idx) == 1


def test_register_duplicate_is_idempotent():
    idx = NodeSuffixIndex()
    idx.register("!ab1234cd")
    idx.register("!ab1234cd")
    assert len(idx) == 1


def test_register_all():
    idx = NodeSuffixIndex()
    idx.register_all(["!ab1234cd", "!ff0000ab"])
    assert len(idx) == 2


def test_unregister_removes_node():
    idx = _make_index("!ab1234cd")
    idx.unregister("!ab1234cd")
    assert len(idx) == 0


def test_unregister_nonexistent_is_safe():
    idx = _make_index("!ab1234cd")
    idx.unregister("!ffffffff")  # should not raise
    assert len(idx) == 1


def test_unregister_cleans_up_empty_suffix_bucket():
    idx = _make_index("!ab1234cd")
    idx.unregister("!ab1234cd")
    assert "cd" not in idx._index


# ---------------------------------------------------------------------------
# resolve — definitive
# ---------------------------------------------------------------------------

def test_resolve_definitive_single_match():
    idx = _make_index("!ab1234cd")
    full_id, definitive = idx.resolve(0xcd)
    assert full_id == "!ab1234cd"
    assert definitive is True


def test_resolve_is_case_insensitive_on_suffix():
    # Node ID stored with uppercase hex should still match lower byte value
    idx = NodeSuffixIndex()
    idx.register("!AB1234CD")
    full_id, definitive = idx.resolve(0xCD)
    assert full_id == "!AB1234CD"
    assert definitive is True


def test_resolve_byte_masking():
    # Values > 0xFF should be masked to the last byte
    idx = _make_index("!ab1234cd")
    full_id, definitive = idx.resolve(0x01cd)  # 0x01cd & 0xFF == 0xcd
    assert full_id == "!ab1234cd"
    assert definitive is True


# ---------------------------------------------------------------------------
# resolve — unresolved (no match)
# ---------------------------------------------------------------------------

def test_resolve_no_match_returns_none_false():
    idx = _make_index("!ab1234cd")
    full_id, definitive = idx.resolve(0xab)
    assert full_id is None
    assert definitive is False


def test_resolve_empty_index_returns_none_false():
    idx = NodeSuffixIndex()
    full_id, definitive = idx.resolve(0xcd)
    assert full_id is None
    assert definitive is False


# ---------------------------------------------------------------------------
# resolve — ambiguous (multiple matches)
# ---------------------------------------------------------------------------

def test_resolve_ambiguous_returns_none_false():
    idx = _make_index("!ab1234cd", "!ef5678cd")
    full_id, definitive = idx.resolve(0xcd)
    assert full_id is None
    assert definitive is False


def test_candidates_returns_all_on_ambiguous():
    idx = _make_index("!ab1234cd", "!ef5678cd")
    candidates = idx.candidates(0xcd)
    assert sorted(candidates) == ["!ab1234cd", "!ef5678cd"]


def test_candidates_returns_single_on_definitive():
    idx = _make_index("!ab1234cd")
    assert idx.candidates(0xcd) == ["!ab1234cd"]


def test_candidates_returns_empty_on_no_match():
    idx = NodeSuffixIndex()
    assert idx.candidates(0xcd) == []


# ---------------------------------------------------------------------------
# becomes definitive after ambiguity is resolved by unregister
# ---------------------------------------------------------------------------

def test_becomes_definitive_after_unregister():
    idx = _make_index("!ab1234cd", "!ef5678cd")
    _, definitive = idx.resolve(0xcd)
    assert not definitive

    idx.unregister("!ef5678cd")
    full_id, definitive = idx.resolve(0xcd)
    assert full_id == "!ab1234cd"
    assert definitive is True


# ---------------------------------------------------------------------------
# Multiple distinct suffixes coexist
# ---------------------------------------------------------------------------

def test_multiple_suffixes_are_independent():
    idx = _make_index("!ab1234cd", "!ff0000ab")
    id_cd, def_cd = idx.resolve(0xcd)
    id_ab, def_ab = idx.resolve(0xab)
    assert id_cd == "!ab1234cd" and def_cd is True
    assert id_ab == "!ff0000ab" and def_ab is True
    assert len(idx) == 2


# ---------------------------------------------------------------------------
# __repr__
# ---------------------------------------------------------------------------

def test_repr_contains_counts():
    idx = _make_index("!ab1234cd", "!ef5678cd", "!ff0000ab")
    r = repr(idx)
    assert "3 nodes" in r
    assert "2 suffixes" in r
