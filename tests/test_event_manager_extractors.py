import pytest

from app.event_manager import EventManager
from app.models import MeshtasticPacket, TextMessage, Position, Routing


def _packet_base(decoded: dict):
    return MeshtasticPacket.model_validate(
        {
            "id_": 111,
            "from_": 222,
            "to": 0xFFFFFFFF,
            "channel": 0,
            "channel_name": "MediumFast",
            "decoded": decoded,
            "uplink": "!000000de",
            "rx_time": 1700000000,
        }
    )


def test_extract_payload_requires_portnum():
    packet = _packet_base({"payload": "hi"})

    with pytest.raises(ValueError):
        EventManager.extract_payload(packet, TextMessage)


def test_text_message_extraction_includes_optional_fields():
    packet = _packet_base(
        {
            "portnum": "TEXT_MESSAGE_APP",
            "payload": "hello",
            "replyId": 123,
            "emoji": 1,
            "bitfield": 9,
        }
    )

    msg = EventManager.extract_payload(packet, TextMessage)

    assert msg.text == "hello"
    assert msg.channel_name == "MediumFast"
    assert msg.packet_id == 111
    assert msg.timestamp == 1700000000
    assert msg.reply_id == 123
    assert msg.emoji == 1
    assert msg.bitfield == 9


def test_default_extractor_parses_json_string_payload():
    packet = _packet_base(
        {
            "portnum": "POSITION_APP",
            "payload": "{\"latitudeI\": 470000000, \"longitudeI\": 190000000, \"locationSource\": \"LOC_INTERNAL\", \"precisionBits\": 12}",
        }
    )

    pos = EventManager.extract_payload(packet, Position)

    assert pos.latitude == 47.0
    assert pos.longitude == 19.0


def test_routing_extraction_with_error_reason():
    packet = _packet_base(
        {
            "portnum": "ROUTING_APP",
            "payload": {
                "errorReason": "NO_RESPONSE"
            },
            "requestId": 43532287,
        }
    )

    routing = EventManager.extract_payload(packet, Routing)

    assert routing.node_id == "!000000de"
    assert routing.packet_id == 111
    assert routing.timestamp == 1700000000
    assert routing.error_reason == "NO_RESPONSE"
    assert routing.request_id == 43532287


def test_routing_extraction_without_error_reason():
    packet = _packet_base(
        {
            "portnum": "ROUTING_APP",
            "payload": {},
            "requestId": 12345,
        }
    )

    routing = EventManager.extract_payload(packet, Routing)

    assert routing.node_id == "!000000de"
    assert routing.packet_id == 111
    assert routing.timestamp == 1700000000
    assert routing.error_reason is None
    assert routing.request_id == 12345


def test_routing_extraction_without_request_id():
    packet = _packet_base(
        {
            "portnum": "ROUTING_APP",
            "payload": {
                "errorReason": "TIMEOUT"
            },
        }
    )

    routing = EventManager.extract_payload(packet, Routing)

    assert routing.node_id == "!000000de"
    assert routing.packet_id == 111
    assert routing.timestamp == 1700000000
    assert routing.error_reason == "TIMEOUT"
    assert routing.request_id is None


def test_routing_extraction_all_error_types():
    """Test that all official routing error reasons are handled correctly"""
    error_reasons = [
        "NONE", "NoRoute", "GotNak", "Timeout", "NoInterface", "MaxRetransmit",
        "NoChannel", "TooLarge", "NoResponse", "DutyCycleLimit", "BadRequest",
        "NotAuthorized", "PkiFailed", "PkiUnknownPubkey", "AdminBadSessionKey",
        "AdminPublicKeyUnauthorized", "RateLimitExceeded"
    ]
    
    for error_reason in error_reasons:
        packet = _packet_base(
            {
                "portnum": "ROUTING_APP",
                "payload": {"errorReason": error_reason},
                "requestId": 999,
            }
        )

        routing = EventManager.extract_payload(packet, Routing)
        assert routing.error_reason == error_reason
        assert routing.request_id == 999


def test_routing_extraction_minimal_packet():
    """Test routing packet with minimal required fields"""
    packet = _packet_base(
        {
            "portnum": "ROUTING_APP",
            "payload": {},
        }
    )

    routing = EventManager.extract_payload(packet, Routing)

    assert routing.node_id == "!000000de"
    assert routing.packet_id == 111
    assert routing.timestamp == 1700000000
    assert routing.error_reason is None
    assert routing.request_id is None
