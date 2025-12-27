from datetime import datetime, timezone

from typing import Optional, Dict, Any
from pydantic.config import ConfigDict

from sqlmodel import SQLModel, Field
from sqlalchemy import Column, Integer, BigInteger, String, DateTime, Boolean, Numeric
from sqlalchemy.types import JSON 

from pydantic import ConfigDict, computed_field

"""
{'from': 2224738468, 'to': 321385616, 'channel': 31,
'decoded': {
    'portnum': 'NODEINFO_APP',
    'payload': {
        'id': '!849ad0a4', 'longName': '🇭🇺 HA1ADM HT Mobil', 'shortName': 'ADM4',
        'macaddr': 'sIGEmtCk', 'hwModel': 'HELTEC_V3', 'role': 'CLIENT_MUTE',
        'publicKey': '04icuoGGUEY+IsF3BT89Ya2SIKSd8EUMirA/Nc9vHBM='
        },
    'wantResponse': True, 'bitfield': 3
    },
'id': 1330856275, 'rxTime': 1766442612, 'rxSnr': -3.25, 'hopLimit': 4,
'rxRssi': -105, 'hopStart': 7, 'nextHop': 112, 'relayNode': 252,
'uplink': '!a2e19ff0', 'channelName': 'MediumFast'}

{'from': 2956776068, 'to': 382706456, 'channel': 31,
'decoded': {
    'portnum': 'NODEINFO_APP',
    'payload': {
        'id': '!b03cd284', 'longName': '🇭🇺 Kaszásdűlő 🏢 868', 'shortName': 'KA8B',
        'hwModel': 'HELTEC_V3', 'role': 'CLIENT_BASE',
        'publicKey': 'lbIajoQsPuG05U3oAAsmuUO1VEansCoTeNPK0lzMV2g='
        },
    'wantResponse': True, 'dest': 382706456, 'requestId': 2384491189, 'bitfield': 3
    },
'id': 2468926477, 'rxTime': 1766442726, 'hopLimit': 3, 'wantAck': True,
'priority': 'RESPONSE', 'hopStart': 3, 'relayNode': 132, 'uplink': '!b03cd284',
'channelName': 'MediumFast'
}

{'from': 2956776068, 'to': 3935232448, 'channel': 31,
'decoded': {
    'portnum': 'NODEINFO_APP',
    'payload': {
        'id': '!b03cd284', 'longName': '🇭🇺 Kaszásdűlő 🏢 868', 'shortName': 'KA8B',
        'macaddr': 'NM2wPNKE', 'hwModel': 'HELTEC_V3', 'role': 'CLIENT_BASE',
        'publicKey': 'lbIajoQsPuG05U3oAAsmuUO1VEansCoTeNPK0lzMV2g=',
        'isUnmessagable': False
        },
    'wantResponse': True, 'bitfield': 3
    },
'id': 3477936900, 'rxTime': 1766442925, 'hopLimit': 7, 'priority': 'RELIABLE',
'hopStart': 7, 'relayNode': 132, 'uplink': '!b03cd284', 'channelName': 'MediumFast'
}

"""

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

        short_name = f" [{self.short_name}]" if self.short_name else ""
        long_name = f" '{self.long_name}'" if self.long_name else ""
        model = f", {self.hw_model}" if self.hw_model else ""
        role = f", {self.role}" if self.role else ""

        return f"NodeInfo {self.id_}{short_name}{long_name}{model}{role}"
