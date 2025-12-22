from datetime import datetime, timezone

from typing import Optional, Dict, Any
from pydantic.config import ConfigDict

from sqlmodel import SQLModel, Field
from sqlalchemy import Column, Integer, BigInteger, String, DateTime, Boolean, Numeric
from sqlalchemy.types import JSON 

from pydantic import ConfigDict, computed_field


class MeshtasticPacket(SQLModel, table=True):
    __tablename__ = "packets"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True
    )

    db_id: Optional[int] = Field(
        default=None, 
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
    rx_snr: Optional[float] = Field(
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
        sa_column=Column("createdAt", DateTime, nullable=True),
    )

    # These computed fields are in the decoded dict, but not part of the actual app payload.
    # To avoid another level of abstraction/schema, they are presented here, as they are
    # more related to the packet/transport.

    @computed_field
    @property
    def decoded_portnum(self) -> Optional[str]:
        return self.decoded.get("portnum")

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
            has_relay = f", relay: {hex(self.relay_node)}" if self.relay_node else ""
            has_nexthop = f", next_hop: 0x{self.next_hop:08x}" if self.next_hop else ""
            is_response = f", re: {self.decoded_requestid}" if self.decoded_requestid else ""
            has_uplink = f", uplink: {self.uplink}" if self.uplink else ""
            want_ack = f", want_ack" if self.want_ack else ""

            return (f"Packet {hex(self.id_)}: {self.decoded_portnum} !{self.from_:08x} -> {to_str}"
                    f"{has_relay}{has_nexthop}{is_response}{want_ack}{has_uplink}")


class NodeInfo(SQLModel, table=True):
    __tablename__ = "nodes"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True,
    )

    # Except ID, all other fields are optional so we can create placeholder node entries when
    # we receive position or telemetry for a node that has not sent a nodeinfo yet.
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

    def __str__(self) -> str:
        """Human-readable string representation excluding None fields."""
        parts = [f"id={self.id_!r}"]

        optional_fields = [
            (self.short_name, "short_name"),
            (self.long_name, "long_name"), 
            (self.macaddr, "macaddr"),
            (self.hw_model, "hw_model"),
            (self.public_key, "public_key"),
            (self.role, "role"),
        ]
        
        for value, name in optional_fields:
            if value is not None:
                fmt_value = f"{value[:8]}..." if name == "public_key" and value else f"{value!r}"
                parts.append(f"{name}={fmt_value}")
        
        if self.is_unmessagable is not None:
            parts.append(f"is_unmessagable={self.is_unmessagable}")
        
        return f"Node {', '.join(parts)}"
