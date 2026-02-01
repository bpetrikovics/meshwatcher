import pytest

from app.event_manager import EventManager
from app.models import MeshtasticPacket, TextMessage, Position


def _packet_base(decoded: dict):
    return MeshtasticPacket.model_validate(
        {
            "id": 111,
            "from": 222,
            "to": 0xFFFFFFFF,
            "channel": 0,
            "channelName": "MediumFast",
            "decoded": decoded,
            "uplink": "!000000de",
            "rxTime": 1700000000,
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
