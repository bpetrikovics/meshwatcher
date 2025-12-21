from datetime import datetime, timezone

from typing import Optional, Dict, Any
from pydantic.config import ConfigDict

from sqlmodel import SQLModel, Field
from sqlalchemy import Column, Integer, BigInteger, String, DateTime, Boolean, Numeric
from sqlalchemy.types import JSON 

from pydantic import ConfigDict


class MeshtasticPacket(SQLModel, table=True):
    __tablename__ = "packets"

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        from_attributes=True
    )

    db_id: int = Field(sa_column=Column("db_id", Integer, primary_key=True, autoincrement=True))
    id_: int = Field(alias="id", sa_column=Column("id", BigInteger))
    from_: int = Field(alias="from", sa_column=Column("from", BigInteger))
    to: int = Field(sa_column=Column("to", BigInteger))
    channel: int = Field(sa_column=Column("channel", Integer))
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
        default=None, sa_column=Column("priority", String(32), nullable=True)
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
    channel_name: str = Field(
        alias="channelName", sa_column=Column("channelName", String(12))
    )
    created_at: Optional[datetime] = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column("createdAt", DateTime, nullable=True),
    )

    def __repr_args__(self):
        """Custom repr excluding sensitive decoded payload and optional None fields."""
        yield 'id_', self.id_
        yield 'from_', self.from_
        yield 'to', self.to
        yield 'channel', self.channel
        yield 'channelName', self.channel_name
        yield 'rxTime', self.rx_time
        if self.hop_limit is not None:
            yield 'hopLimit', self.hop_limit
        yield 'hopStart', self.hop_start
        if self.priority:
            yield 'priority', repr(self.priority)
        yield 'relayNode', self.relay_node
        if self.next_hop is not None:
            yield 'nextHop', self.next_hop
        yield 'uplink', self.uplink
        if self.rx_snr is not None:
            yield 'rxSnr', f"{self.rx_snr:.1f}"
        if self.rx_rssi is not None:
            yield 'rxRssi', self.rx_rssi

    def __str__(self) -> str:
        """Human-readable summary focused on routing and signal quality."""
        signal_info = f" , snr={self.rx_snr:.1f}, rssi:{self.rx_rssi}" if self.rx_snr is not None and self.rx_rssi is not None else ""
        return (f"MeshtasticPacket(id={self.id_}, from={self.from_}, to={self.to}, "
                f"ch='{self.channel_name[:20]}'{signal_info}, hops={self.hop_start or '?'}/{self.hop_limit or '?'})")
