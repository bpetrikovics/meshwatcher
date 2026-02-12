from datetime import datetime, timezone
from decimal import Decimal

from typing import Optional, Dict, Any
from pydantic.config import ConfigDict

from sqlmodel import SQLModel, Field
from sqlmodel import select
from sqlalchemy import Column, Integer, BigInteger, String, DateTime, Boolean, Numeric, ForeignKey, Index, func, UniqueConstraint, desc
from sqlalchemy.types import JSON 

from pydantic import ConfigDict, computed_field, field_validator, model_validator


class MeshtasticPacket(SQLModel, table=True):
    """
    Represents a Meshtastic packet received via MQTT.
    """

    __tablename__ = "packets"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True
    )

    db_id: Optional[int] = Field(
        default=None,
        exclude=True,
        sa_column=Column(
            Integer,
            primary_key=True,
            autoincrement=True)
    )

    id_: int = Field(alias="id", sa_column=Column("id", BigInteger))
    from_: int = Field(alias="from", sa_column=Column("from", BigInteger))
    to: int = Field(sa_column=Column("to", BigInteger))

    channel: int = Field(sa_column=Column("channel", Integer))
    channel_name: str = Field(
        alias="channelName", sa_column=Column("channelName", String(12))
    )

    decoded: Dict[str, Any] = Field(default={}, sa_column=Column("decoded", JSON))

    uplink: str = Field(sa_column=Column("uplink", String(9)))
    rx_time: int = Field(alias="rxTime", sa_column=Column("rxTime", Integer))
    hop_limit: Optional[int] = Field(
        default=None,
        alias="hopLimit",
        sa_column=Column("hopLimit", Integer, nullable=True),
    )
    hop_start: Optional[int] = Field(
        default=None,
        alias="hopStart",
        sa_column=Column("hopStart", Integer, nullable=True),
    )
    priority: Optional[str] = Field(
        default=None,
        sa_column=Column("priority", String(32), nullable=True)
    )
    relay_node: Optional[int] = Field(
        default=None,
        alias="relayNode",
        sa_column=Column("relayNode", Integer, nullable=True),
    )
    next_hop: Optional[int] = Field(
        default=None,
        alias="nextHop",
        sa_column=Column("nextHop", Integer, nullable=True),
    )
    rx_snr: Optional[Decimal] = Field(
        default=None,
        alias="rxSnr",
        sa_column=Column("rxSnr", Numeric(precision=4, scale=2), nullable=True),
    )
    rx_rssi: Optional[int] = Field(
        default=None, alias="rxRssi", sa_column=Column("rxRssi", Integer, nullable=True)
    )
    transport_mechanism: Optional[str] = Field(
        default=None,
        alias="transportMechanism",
        sa_column=Column("transportMechanism", String(32), nullable=True),
    )
    want_ack: Optional[bool] = Field(
        default=None,
        alias="wantAck",
        sa_column=Column("wantAck", Boolean, nullable=True),
    )

    created_at: Optional[datetime] = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column("createdAt", DateTime, nullable=True)
    )

    # These computed fields are in the decoded dict, but not part of the actual app payload.
    # To avoid another level of abstraction/schema, they are presented here, as they are
    # more related to the packet/transport.

    @computed_field
    @property
    def decoded_portnum(self) -> Optional[str]:
        return self.decoded.get("portnum")

    @field_validator("rx_snr", mode="before")
    @classmethod
    def _coerce_rx_snr_decimal(cls, v):
        if v is None:
            return None
        if isinstance(v, Decimal):
            return v
        return Decimal(str(v))

    @computed_field
    @property
    def decoded_requestid(self) -> Optional[int]:
        return self.decoded.get("requestId")

    @computed_field
    @property
    def decoded_bitfield(self) -> Optional[int]:
        return self.decoded.get("bitfield")

    @computed_field
    @property
    def decoded_wantresponse(self) -> Optional[int]:
        return self.decoded.get("wantResponse")

    @computed_field
    @property
    def is_duplicate(self) -> bool:
        return getattr(self, '_is_duplicate', False)

    @computed_field
    @property
    def is_broadcast(self) -> bool:
        return (self.to == 0xffffffff)

    def __repr_args__(self):
        """Clean repr excluding None fields - yield (name, value) tuples."""
        # Always include core fields
        yield ("id_", f"0x{self.id_:08x}")
        yield ("from_", f"0x{self.from_:08x}")
        yield ("to", f"0x{self.to:08x}")
        yield ("channel", self.channel)
        yield ("decoded_portnum", self.decoded_portnum)
        yield ("channel_name", self.channel_name)
        yield ("rx_time", self.rx_time)
        yield ("uplink", repr(self.uplink))
        
        # Conditionally include non-None fields
        if self.decoded_requestid is not None:
            yield ("decoded_requestid", self.decoded_requestid)
        if self.decoded_bitfield is not None:
            yield ("decoded_bitfield", self.decoded_bitfield)
        if self.decoded_wantresponse is not None:
            yield ("decoded_wantresponse", self.decoded_wantresponse)
        if self.want_ack is not None:
            yield ("want_ack", self.want_ack)
        if self.hop_limit is not None:
            yield ("hop_limit", self.hop_limit)
        if self.hop_start is not None:
            yield ("hop_start", self.hop_start)
        if self.priority:
            yield ("priority", repr(self.priority))
        if self.relay_node is not None:
            yield ("relay_node", self.relay_node)
        if self.next_hop is not None:
            yield ("next_hop", self.next_hop)
        if self.rx_snr is not None:
            yield ("rx_snr", f"{self.rx_snr:.2f}")
        if self.rx_rssi is not None:
            yield ("rx_rssi", self.rx_rssi)
        if self.transport_mechanism:
            yield ("transport_mechanism", repr(self.transport_mechanism))

    def __str__(self) -> str:
            to_str = "broadcast" if self.is_broadcast else f"!{self.to:08x}"
            has_relay = f", relay: 0x{self.relay_node:02x}" if self.relay_node else ""
            has_nexthop = f", next_hop: 0x{self.next_hop:02x}" if self.next_hop else ""
            is_response = f", re: {hex(self.decoded_requestid)}" if self.decoded_requestid else ""
            has_uplink = f", uplink: {self.uplink}" if self.uplink else ""
            want_ack = f", want_ack" if self.want_ack else ""
            want_response = f", want_resp" if self.decoded_wantresponse else ""

            return (f"Packet {hex(self.id_)}: {self.decoded_portnum} !{self.from_:08x} -> {to_str}"
                    f"{has_relay}{has_nexthop}{is_response}{want_ack}{want_response}{has_uplink} on {self.channel_name}/{self.channel}")


class NodeInfo(SQLModel, table=True):
    __tablename__ = "nodes"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True,
    )

    # Except ID, all other fields are optional so we can create placeholder node entries when
    # we receive position or telemetry for a node that has not sent a nodeinfo yet.
    # TODO: Do we want to store which channel the given nodeinfo was received on?
    id_: str = Field(alias="id", sa_column=Column("id", String(9), primary_key=True))
    short_name: str = Field(
        alias="shortName",
        default=None,
        sa_column=Column("shortName", String(4)),
        )
    long_name: str = Field(
        alias="longName",
        default=None,
        sa_column=Column("longName", String(40)),
        )
    macaddr: str = Field(
        default=None,
        sa_column=Column("macaddr", String(8)),
        )
    hw_model: str = Field(
        alias="hwModel",
        default=None,
        sa_column=Column("hwModel", String(32)),
        )
    public_key: str = Field(
        alias="publicKey",
        default=None,
        sa_column=Column("publicKey", String(64)),
        )
    role: str = Field(
        default=None,
        sa_column=Column("role", String(16)),
        )
    is_unmessagable: bool = Field(
        alias="isUnmessagable",
        default=None,
        sa_column=Column("isUnmessagable", Boolean),
        )
    updated: Optional[datetime] = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column("updated", DateTime, nullable=True),
        exclude=True
    )

    def __str__(self) -> str:

        short_name = f" [{self.short_name}]" if self.short_name else ""
        long_name = f" '{self.long_name}'" if self.long_name else ""
        model = f", {self.hw_model}" if self.hw_model else ""
        role = f", {self.role}" if self.role else ""

        return f"NodeInfo {self.id_}{short_name}{long_name}{model}{role}"


class Telemetry(SQLModel, table=True):
    """
    Represents telemetry data received from a Meshtastic node.
    """

    __tablename__ = "telemetry"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True,
    )

    db_id: Optional[int] = Field(
        default=None,
        exclude=True,
        sa_column=Column(Integer, primary_key=True, autoincrement=True),
    )

    node_id: Optional[str] = Field(
        default=None,
        sa_column=Column("nodeId", String(9), ForeignKey("nodes.id"), nullable=False),
    )
    metric_type: str = Field(sa_column=Column("metricType", String(32), nullable=False))
    ts: int = Field(alias="time", sa_column=Column("ts", Integer, nullable=False))
    payload: Dict[str, Any] = Field(default_factory=dict, sa_column=Column("payload", JSON, nullable=False))

    created_at: Optional[datetime] = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column("createdAt", DateTime, nullable=True),
        exclude=True,
    )

    __table_args__ = (
        Index("ix_telemetry_node_type_ts", "nodeId", "metricType", "ts"),
        Index("ix_telemetry_node_ts", "nodeId", "ts"),
        UniqueConstraint("nodeId", "metricType", "ts", name="uq_telemetry_node_type_ts"),
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_decoded_payload(cls, v):
        """Allow validation from TELEMETRY_APP decoded payloads.

        Supports input like:
        {"time": 105, "powerMetrics": {"ch3Voltage": 2.92, "ch3Current": 10.8}}

        and converts it into the db-ready shape:
        {"ts": 105, "metric_type": "powerMetrics", "payload": {...}}

        Note: `node_id` is not present in the decoded payload; it should be set by the
        caller (e.g. from `packet.from_`) before persisting.
        """
        if not isinstance(v, dict):
            return v

        # If already normalized, do nothing
        if "metric_type" in v and "payload" in v and ("ts" in v or "time" in v):
            return v

        ts = v.get("time")
        if ts is None:
            return v

        metric_key = None
        metric_payload = None
        for k, val in v.items():
            if k == "time":
                continue
            if isinstance(val, dict):
                metric_key = k
                metric_payload = val
                break

        if metric_key is None:
            return v

        return {
            "ts": int(ts),
            "metric_type": metric_key,
            "payload": metric_payload,
        }

    @classmethod
    def stmt_latest_per_type(cls, *, node_id: str):
        """Build a statement returning the most recent row per metric_type for a node."""
        ranked = (
            select(
                cls.db_id.label("db_id"),
                func.row_number()
                .over(partition_by=cls.metric_type, order_by=cls.ts.desc())
                .label("rn"),
            )
            .where(cls.node_id == node_id)
            .subquery()
        )

        return select(cls).join(ranked, ranked.c.db_id == cls.db_id).where(ranked.c.rn == 1)

    @classmethod
    def stmt_records_for_type(cls, *, node_id: str, metric_type: str, since_ts: Optional[int] = None):
        """Build a statement returning rows for a node/type, optionally filtered by ts >= since_ts."""
        stmt = select(cls).where(cls.node_id == node_id, cls.metric_type == metric_type)
        if since_ts is not None:
            stmt = stmt.where(cls.ts >= since_ts)
        return stmt.order_by(cls.ts.asc())

    def __str__(self) -> str:
        node = self.node_id if self.node_id is not None else "<unset>"
        return f"Telemetry {node} {self.metric_type} @ {self.ts}: {self.payload}"


class Metric(SQLModel, table=True):
    """
    Represents a metric extracted from telemetry data.
    """

    __tablename__ = "metrics"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True,
    )

    db_id: Optional[int] = Field(
        default=None,
        exclude=True,
        sa_column=Column(Integer, primary_key=True, autoincrement=True),
    )

    telemetry_id: int = Field(
        sa_column=Column(
            "telemetryId",
            Integer,
            ForeignKey("telemetry.db_id", ondelete="CASCADE"),
            nullable=False,
        )
    )

    node_id: str = Field(sa_column=Column("nodeId", String(9), nullable=False))
    metric_type: str = Field(sa_column=Column("metricType", String(32), nullable=False))
    metric: str = Field(sa_column=Column("metric", String(64), nullable=False))
    ts: int = Field(sa_column=Column("ts", Integer, nullable=False))

    value: float = Field(sa_column=Column("value", Numeric(precision=18, scale=6), nullable=False))

    created_at: Optional[datetime] = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column("createdAt", DateTime, nullable=True),
        exclude=True,
    )

    __table_args__ = (
        Index("ix_metrics_chart", "nodeId", "metricType", "metric", "ts"),
        Index("ix_metrics_latest", "nodeId", "metricType", "metric", desc("ts")),
        Index("ix_metrics_telemetry_id", "telemetryId"),
    )


class TextMessage(SQLModel, table=True):
    """
    Represents a text message received from a Meshtastic node.
    """

    __tablename__ = "messages"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True,
    )

    db_id: Optional[int] = Field(
        default=None,
        exclude=True,
        sa_column=Column(Integer, primary_key=True, autoincrement=True),
    )

    node_id: Optional[str] = Field(
        default=None,
        sa_column=Column("nodeId", String(9), ForeignKey("nodes.id"), nullable=False),
    )
    packet_id: int = Field(
        alias="packetId",
        sa_column=Column("packetId", BigInteger, nullable=False),
    )
    text: str = Field(sa_column=Column("text", String(1024), nullable=False))
    channel_name: str = Field(
        alias="channelName",
        sa_column=Column("channelName", String(12), nullable=False),
    )
    reply_id: Optional[int] = Field(
        default=None,
        alias="replyId",
        sa_column=Column("replyId", BigInteger, nullable=True),
    )
    emoji: Optional[int] = Field(
        default=None,
        sa_column=Column("emoji", Integer, nullable=True),
    )
    bitfield: Optional[int] = Field(
        default=None,
        sa_column=Column("bitfield", Integer, nullable=True),
    )
    timestamp: int = Field(
        alias="rxTime",
        sa_column=Column("timestamp", Integer, nullable=False),
    )

    created_at: Optional[datetime] = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column("createdAt", DateTime, nullable=True),
        exclude=True,
    )

    __table_args__ = (
        Index("ix_messages_node_timestamp", "nodeId", "timestamp"),
        Index("ix_messages_packet_id", "packetId"),
        Index("ix_messages_reply_id", "replyId"),
    )

    def __str__(self) -> str:
        node = self.node_id if self.node_id is not None else "<unset>"
        reply_info = f" (reply to {self.reply_id})" if self.reply_id else ""
        emoji_info = f" [emoji]" if self.emoji else ""
        channel_info = f" on {self.channel_name}" if self.channel_name else ""
        return f"TextMessage {node}{reply_info}{emoji_info}{channel_info}: {self.text}"


class Position(SQLModel, table=True):
    """
    Represents position data received from a Meshtastic node.
    """

    __tablename__ = "positions"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True,
    )

    db_id: Optional[int] = Field(
        default=None,
        exclude=True,
        sa_column=Column(Integer, primary_key=True, autoincrement=True),
    )

    node_id: Optional[str] = Field(
        default=None,
        sa_column=Column("nodeId", String(9), ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False),
    )
    latitude_i: int = Field(
        alias="latitudeI",
        sa_column=Column("latitudeI", Integer, nullable=False),
    )
    longitude_i: int = Field(
        alias="longitudeI",
        sa_column=Column("longitudeI", Integer, nullable=False),
    )
    altitude: Optional[int] = Field(sa_column=Column("altitude", Integer, nullable=True))
    time: Optional[int] = Field(sa_column=Column("time", Integer, nullable=True))
    location_source: Optional[str] = Field(
        alias="locationSource",
        default=None,
        sa_column=Column("locationSource", String(32), nullable=True),
    )
    ground_speed: Optional[int] = Field(
        alias="groundSpeed",
        sa_column=Column("groundSpeed", Integer, nullable=True),
    )
    ground_track: Optional[int] = Field(
        alias="groundTrack",
        sa_column=Column("groundTrack", Integer, nullable=True),
    )
    precision_bits: int = Field(
        alias="precisionBits",
        sa_column=Column("precisionBits", Integer, nullable=False),
    )

    created_at: Optional[datetime] = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column("createdAt", DateTime, nullable=True),
        exclude=True,
    )

    __table_args__ = (
        Index("ix_positions_node_time", "nodeId", "time"),
        Index("ix_positions_time", "time"),
    )

    @computed_field
    @property
    def latitude(self) -> float:
        """Convert latitude from integer (1e7 scale) to decimal degrees."""
        return self.latitude_i / 1e7

    @computed_field
    @property
    def longitude(self) -> float:
        """Convert longitude from integer (1e7 scale) to decimal degrees."""
        return self.longitude_i / 1e7

    @computed_field
    @property
    def heading(self) -> float:
        """Convert heading from integer (1e5 scale) to decimal degrees."""
        if self.ground_track is None:
            return 0.0
        return self.ground_track / 1e5

    @computed_field
    @property
    def radius(self) -> float:
        """Calculate precision radius from precision bits."""
        return 23905787.925008 * (0.5 ** self.precision_bits)

    def __str__(self) -> str:
        node = self.node_id if self.node_id is not None else "<unset>"
        return f"Position {node} @ {self.time}: lat={self.latitude}, lon={self.longitude}, heading={self.heading}, ground speed={self.ground_speed}, alt={self.altitude}, radius={self.radius:.2f}"
