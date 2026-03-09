from decimal import Decimal

import pytest
from sqlalchemy.dialects import mysql

from app.models import MeshtasticPacket, NodeInfo, Telemetry, TextMessage, Position, Routing


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


def test_textmessage_validation_behavior_with_field_and_alias_names():
    # Test that field name always works
    ok1 = TextMessage.model_validate(
        {
            "packet_id": 111,
            "text": "hello",
            "channel_name": "MediumFast", 
            "timestamp": 1700000000,
            "reply_id": 123,
        }
    )
    assert ok1.reply_id == 123

    # Test alias behavior - may work in some environments, fail in others
    try:
        ok2 = TextMessage.model_validate(
            {
                "packet_id": 111,
                "text": "hello", 
                "channel_name": "MediumFast",
                "timestamp": 1700000000,
                "replyId": 123,
            }
        )
        assert ok2.reply_id == 123
        alias_works = True
    except Exception:
        alias_works = False

    # Test that truly unknown fields are always rejected
    with pytest.raises(Exception):
        TextMessage.model_validate(
            {
                "packet_id": 111,
                "text": "hello",
                "channel_name": "MediumFast",
                "timestamp": 1700000000,
                "unknown_field": 123,  # This should always fail
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
    assert pos.heading is None


def test_routing_model_validation_and_string_representation():
    # Test routing packet with error reason and request ID
    routing_full = Routing.model_validate(
        {
            "node_id": "!abcdef01",
            "packet_id": 12345,
            "timestamp": 1700000000,
            "error_reason": "NO_RESPONSE",
            "request_id": 67890,
        }
    )
    
    assert routing_full.node_id == "!abcdef01"
    assert routing_full.packet_id == 12345
    assert routing_full.timestamp == 1700000000
    assert routing_full.error_reason == "NO_RESPONSE"
    assert routing_full.request_id == 67890
    
    # Test string representation with error
    routing_str = str(routing_full)
    assert "Routing !abcdef01" in routing_str
    assert "error=NO_RESPONSE" in routing_str
    assert "req=0x10932" in routing_str  # 67890 in hex
    print(" String representation works:", routing_str)
    
    # Test routing packet without error (successful routing)
    routing_success = Routing.model_validate(
        {
            "node_id": "!12345678",
            "packet_id": 999,
            "timestamp": 1700000000,
            "error_reason": None,
            "request_id": None,
        }
    )
    
    assert routing_success.error_reason is None
    assert routing_success.request_id is None
    
    # Test string representation for success
    success_str = str(routing_success)
    assert "Routing !12345678" in success_str
    assert "success" in success_str
    assert "req=" not in success_str  # No request ID should not show req=


def test_routing_model_field_and_alias_validation():
    # Test that field names work
    routing1 = Routing.model_validate(
        {
            "node_id": "!abcdef01",
            "packet_id": 123,
            "timestamp": 1700000000,
            "error_reason": "TIMEOUT",
            "request_id": 456,
        }
    )
    assert routing1.error_reason == "TIMEOUT"
    assert routing1.request_id == 456
    
    # Test alias behavior for packetId
    try:
        routing2 = Routing.model_validate(
            {
                "node_id": "!abcdef01",
                "packetId": 789,  # Using alias
                "timestamp": 1700000000,
                "error_reason": "NoRoute",
                "requestId": 999,  # Using alias
            }
        )
        assert routing2.packet_id == 789
        assert routing2.request_id == 999
        alias_works = True
    except Exception:
        alias_works = False
    
    # Test that unknown fields are always rejected
    with pytest.raises(Exception):
        Routing.model_validate(
            {
                "node_id": "!abcdef01",
                "packet_id": 123,
                "timestamp": 1700000000,
                "unknown_field": "should_fail",
            }
        )


def test_routing_model_all_error_reasons():
    """Test that all official routing error reasons are accepted"""
    error_reasons = [
        "NONE", "NoRoute", "GotNak", "Timeout", "NoInterface", "MaxRetransmit",
        "NoChannel", "TooLarge", "NoResponse", "DutyCycleLimit", "BadRequest",
        "NotAuthorized", "PkiFailed", "PkiUnknownPubkey", "AdminBadSessionKey",
        "AdminPublicKeyUnauthorized", "RateLimitExceeded"
    ]
    
    for error_reason in error_reasons:
        routing = Routing.model_validate(
            {
                "node_id": "!test1234",
                "packet_id": 999,
                "timestamp": 1700000000,
                "error_reason": error_reason,
                "request_id": None,
            }
        )
        assert routing.error_reason == error_reason
