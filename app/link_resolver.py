import logging

from typing import Optional


class NodeSuffixIndex:
    """
    Resolves single-byte relay_node and next_hop fields to full node IDs.

    Meshtastic encodes relay_node and next_hop as the last byte of the node's
    4-byte ID (e.g. relay_node=0xcd could be node !ab1234cd).  This class
    maintains an index keyed on that last byte so that, when only one known
    node shares a given suffix, resolution is definitive.

    Thread safety: not synchronised — callers must coordinate if used from
    multiple threads.
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        # Maps two-hex-char suffix → list of full node IDs, e.g. "cd" → ["!ab1234cd"]
        self._index: dict[str, list[str]] = {}

    # ------------------------------------------------------------------
    # Index management
    # ------------------------------------------------------------------

    def register(self, node_id: str) -> None:
        """
        Add a node to the index.

        Args:
            node_id: Full node ID in ``!XXXXXXXX`` format.
        """
        suffix = _suffix(node_id)
        bucket = self._index.setdefault(suffix, [])
        if node_id not in bucket:
            bucket.append(node_id)
            self.logger.debug("Registered node %s with suffix %s", node_id, suffix)

    def unregister(self, node_id: str) -> None:
        """
        Remove a node from the index (e.g. on expiry).

        Args:
            node_id: Full node ID in ``!XXXXXXXX`` format.
        """
        suffix = _suffix(node_id)
        bucket = self._index.get(suffix, [])
        if node_id in bucket:
            bucket.remove(node_id)
            self.logger.debug("Unregistered node %s with suffix %s", node_id, suffix)
            if not bucket:
                del self._index[suffix]

    def register_all(self, node_ids: list[str]) -> None:
        """Bulk register a list of node IDs, e.g. loaded from the database at startup."""
        for node_id in node_ids:
            self.register(node_id)
        self.logger.info("NodeSuffixIndex: registered %d node(s)", len(node_ids))

    # ------------------------------------------------------------------
    # Resolution
    # ------------------------------------------------------------------

    def resolve(self, byte_val: int) -> tuple[Optional[str], bool]:
        """
        Resolve a 1-byte relay_node or next_hop value to a full node ID.

        Returns:
            ``(full_id, is_definitive)``

            - ``(full_id, True)``  — exactly one known node matches; definitive.
            - ``(None, False)``    — zero or more than one candidate; unresolved/ambiguous.
        """
        suffix = f"{byte_val & 0xFF:02x}"
        candidates = self._index.get(suffix, [])

        if len(candidates) == 1:
            return candidates[0], True

        if len(candidates) == 0:
            self.logger.debug("No node found for suffix %s", suffix)
        else:
            self.logger.debug(
                "Ambiguous suffix %s — %d candidates: %s",
                suffix,
                len(candidates),
                candidates,
            )
        return None, False

    def candidates(self, byte_val: int) -> list[str]:
        """Return all candidate node IDs for a given byte value (including ambiguous cases)."""
        suffix = f"{byte_val & 0xFF:02x}"
        return list(self._index.get(suffix, []))

    def __len__(self) -> int:
        return sum(len(v) for v in self._index.values())

    def __repr__(self) -> str:
        return f"NodeSuffixIndex({len(self)} nodes, {len(self._index)} suffixes)"


# ------------------------------------------------------------------
# Module-level helpers
# ------------------------------------------------------------------

def _suffix(node_id: str) -> str:
    """Return the 2-char hex suffix (last byte) of a node ID like ``!ab1234cd``."""
    return node_id.lstrip("!")[-2:].lower()
