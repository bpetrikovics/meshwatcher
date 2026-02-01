from decimal import Decimal

import pytest
from sqlalchemy.dialects import mysql

from app.models import MeshtasticPacket, NodeInfo, Telemetry, TextMessage, Position


def test_meshtastic_packet_computed_fields_and_decimal_coercion():
    pkt = MeshtasticPacket.model_validate(
        {
            "id_": 123,
            "from_": 0xAA,
            "to": 0xFFFFFFFF,
            "channel": 7,
            "channel_name": "MediumFast",
            "decoded": {"portnum": "TRACEROUTE_APP", "requestId": 456, "bitfield": 3, "wantResponse": True},
            "uplink": "!000000aa",
            "rx_time": 1700000000,
            "rx_snr": -13.5,
        }
    )

    assert pkt.decoded_portnum == "TRACEROUTE_APP"
    assert pkt.decoded_requestid == 456
    assert pkt.decoded_bitfield == 3
    assert pkt.decoded_wantresponse is True

    assert pkt.is_broadcast is True

    assert isinstance(pkt.rx_snr, Decimal)
    assert f"{pkt.rx_snr:.2f}" == "-13.50"

    # Default is_duplicate should be false unless _is_duplicate is set by packet handler
    assert pkt.is_duplicate is False
    pkt._is_duplicate = True
    assert pkt.is_duplicate is True


def test_nodeinfo_string_representation_minimal_and_full():
    n_min = NodeInfo.model_validate({"id_": "!abcdef01"})
    assert str(n_min).startswith("NodeInfo !abcdef01")

    n_full = NodeInfo.model_validate(
        {
            "id_": "!abcdef01",
            "short_name": "ABCD",
            "long_name": "My Node",
            "hw_model": "HELTEC_V3",
            "role": "CLIENT",
        }
    )
    s = str(n_full)
    assert "[ABCD]" in s
    assert "'My Node'" in s
    assert "HELTEC_V3" in s
    assert "CLIENT" in s


def test_textmessage_validation_rejects_replyid_alias_key_in_this_environment():
    # In this repo's SQLModel validation behavior, alias keys are rejected as extra inputs.
    # Ensure we use model field names.
    ok = TextMessage.model_validate(
        {
            "packet_id": 111,
            "text": "hello",
            "channel_name": "MediumFast",
            "timestamp": 1700000000,
            "reply_id": 123,
        }
    )
    assert ok.reply_id == 123

    with pytest.raises(Exception):
        TextMessage.model_validate(
            {
                "packet_id": 111,
                "text": "hello",
                "channel_name": "MediumFast",
                "timestamp": 1700000000,
                "replyId": 123,
            }
        )


def test_telemetry_normalization_and_already_normalized_passthrough():
    t = Telemetry.model_validate({"time": 105, "powerMetrics": {"ch3Voltage": 2.92, "ch3Current": 10.8}})
    assert t.ts == 105
    assert t.metric_type == "powerMetrics"
    assert t.payload == {"ch3Voltage": 2.92, "ch3Current": 10.8}

    already = Telemetry.model_validate({"ts": 1, "metric_type": "deviceMetrics", "payload": {"batteryLevel": 90}})
    assert already.ts == 1
    assert already.metric_type == "deviceMetrics"
    assert already.payload == {"batteryLevel": 90}


def test_telemetry_statement_builders_compile():
    # We don't need a real database connection; compile ensures SQLAlchemy can build the query.
    stmt = Telemetry.stmt_latest_per_type(node_id="!abcdef01")
    sql = str(stmt.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "FROM telemetry" in sql

    stmt2 = Telemetry.stmt_records_for_type(node_id="!abcdef01", metric_type="deviceMetrics", since_ts=10)
    sql2 = str(stmt2.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "metricType" in sql2
    assert "ts" in sql2


def test_position_computed_fields_heading_none():
    pos = Position.model_validate(
        {
            "latitude_i": 470000000,
            "longitude_i": 190000000,
            "altitude": None,
            "time": None,
            "location_source": "LOC_INTERNAL",
            "ground_speed": None,
            "precision_bits": 12,
            "ground_track": None,
        }
    )

    assert pos.latitude == 47.0
    assert pos.longitude == 19.0
    assert pos.heading == 0.0
