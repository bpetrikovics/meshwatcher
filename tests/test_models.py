import unittest
import importlib.util
import sys
from pathlib import Path
from typing import Dict, Any

from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, select

# Constants for test data
TEST_NODE_ID = "!d45a9a80"
TEST_NODE_ID_2 = "!00000001"
TEST_UPLINK = "!aabbccdd"
TEST_CHANNEL_NAME = "MediumFast"
TEST_SHORT_NAME = "HN"
TEST_LONG_NAME = "Hungary Node"
TEST_HW_MODEL = "HELTEC_V3"
TEST_ROLE = "CLIENT"
TEST_TS = 105
TEST_RX_TIME = 1700000000

# Helper used by tests to normalize real-traffic (alias-style) payload dicts into the
# field-name format that the current models accept (e.g. `from` -> `from_`).
#
# This is intentionally in the tests (not in application code) so we can validate example
# real-traffic packets without changing model validation behavior.
def _normalize_keys(d: dict, key_map: dict) -> dict:
    if not isinstance(d, dict):
        return d
    out = dict(d)
    for src, dst in key_map.items():
        if src in out and dst not in out:
            out[dst] = out[src]
        out.pop(src, None)
    return out


# Key mapping for alias-style Meshtastic packets captured from MQTT JSON.
_MESHTASTIC_PACKET_KEY_MAP = {
    "id": "id_",
    "from": "from_",
    "channelName": "channel_name",
    "rxTime": "rx_time",
    "hopLimit": "hop_limit",
    "hopStart": "hop_start",
    "relayNode": "relay_node",
    "nextHop": "next_hop",
    "rxSnr": "rx_snr",
    "rxRssi": "rx_rssi",
    "transportMechanism": "transport_mechanism",
    "wantAck": "want_ack",
}


# Key mapping for alias-style NodeInfo payloads (nested inside `decoded.payload`).
_NODEINFO_KEY_MAP = {
    "id": "id_",
    "shortName": "short_name",
    "longName": "long_name",
    "hwModel": "hw_model",
    "publicKey": "public_key",
    "isUnmessagable": "is_unmessagable",
}


# Convenience wrapper for packet normalization.
def _normalize_meshtastic_packet_dict(d: dict) -> dict:
    return _normalize_keys(d, _MESHTASTIC_PACKET_KEY_MAP)


# Convenience wrapper for NodeInfo normalization.
def _normalize_nodeinfo_dict(d: dict) -> dict:
    return _normalize_keys(d, _NODEINFO_KEY_MAP)


def _load_models():
    """Load models dynamically to avoid importing full Flask app."""
    _models_path = Path(__file__).resolve().parents[1] / "app" / "models.py"
    _spec = importlib.util.spec_from_file_location("meshwatcher_models", _models_path)
    _models = importlib.util.module_from_spec(_spec)
    assert _spec is not None and _spec.loader is not None
    _spec.loader.exec_module(_models)
    return _models


# Load models
_models = _load_models()
Telemetry = _models.Telemetry
Metric = _models.Metric
NodeInfo = _models.NodeInfo
MeshtasticPacket = _models.MeshtasticPacket


class TestDataFactory:
    """Factory for creating test data objects."""
    
    @staticmethod
    def create_node_info(**overrides) -> Dict[str, Any]:
        """Create a NodeInfo test data dictionary."""
        defaults = {
            "id_": TEST_NODE_ID,
            "long_name": TEST_LONG_NAME,
            "short_name": TEST_SHORT_NAME,
            "hw_model": TEST_HW_MODEL,
            "role": TEST_ROLE,
        }
        return {**defaults, **overrides}
    
    @staticmethod
    def create_node_info_alias(**overrides) -> Dict[str, Any]:
        """Create a NodeInfo test data dictionary with alias field names."""
        defaults = {
            "id": TEST_NODE_ID,
            "longName": TEST_LONG_NAME,
            "shortName": TEST_SHORT_NAME,
            "hwModel": TEST_HW_MODEL,
            "role": TEST_ROLE,
        }
        return {**defaults, **overrides}
    
    @staticmethod
    def create_meshtastic_packet(**overrides) -> Dict[str, Any]:
        """Create a MeshtasticPacket test data dictionary."""
        defaults = {
            "id_": 123,
            "from_": 0x01020304,
            "to": 0x05060708,
            "channel": 1,
            "channel_name": TEST_CHANNEL_NAME,
            "decoded": {"portnum": "TEXT_MESSAGE_APP"},
            "uplink": TEST_UPLINK,
            "rx_time": TEST_RX_TIME,
        }
        return {**defaults, **overrides}
    
    @staticmethod
    def create_meshtastic_packet_alias(**overrides) -> Dict[str, Any]:
        """Create a MeshtasticPacket test data dictionary with alias field names."""
        defaults = {
            "id": 123,
            "from": 0x01020304,
            "to": 0x05060708,
            "channel": 1,
            "channelName": TEST_CHANNEL_NAME,
            "decoded": {"portnum": "TEXT_MESSAGE_APP"},
            "uplink": TEST_UPLINK,
            "rxTime": TEST_RX_TIME,
        }
        return {**defaults, **overrides}
    
    @staticmethod
    def create_telemetry(**overrides) -> Dict[str, Any]:
        """Create a Telemetry test data dictionary."""
        defaults = {
            "ts": TEST_TS,
            "metric_type": "powerMetrics",
            "payload": {"ch3Voltage": 2.92, "ch3Current": 10.8},
        }
        return {**defaults, **overrides}
    
    @staticmethod
    def create_telemetry_decoded(**overrides) -> Dict[str, Any]:
        """Create a Telemetry test data dictionary in decoded format."""
        defaults = {
            "time": TEST_TS,
            "powerMetrics": {"ch3Voltage": 2.92, "ch3Current": 10.8},
        }
        return {**defaults, **overrides}


class DatabaseTestMixin:
    """Mixin providing database setup for tests."""
    
    def setUp(self):
        """Set up in-memory SQLite database for testing."""
        self.engine = _sqlite_engine()
        super().setUp() if hasattr(super(), 'setUp') else None


def _sqlite_engine():
    engine = create_engine("sqlite://", echo=False)

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    SQLModel.metadata.create_all(engine)
    return engine


class TestTelemetryModel(unittest.TestCase):
    """Test cases for the Telemetry model validation and behavior."""
    
    def test_normalize_decoded_payload_power_metrics(self):
        """Test that decoded payload with powerMetrics is normalized correctly."""
        decoded = TestDataFactory.create_telemetry_decoded()
        t = Telemetry.model_validate(decoded)
        
        self.assertEqual(t.ts, TEST_TS)
        self.assertEqual(t.metric_type, "powerMetrics")
        self.assertEqual(t.payload, {"ch3Voltage": 2.92, "ch3Current": 10.8})

    def test_normalize_decoded_payload_already_normalized(self):
        """Test that already normalized payload is handled correctly."""
        normalized = TestDataFactory.create_telemetry()
        t = Telemetry.model_validate(normalized)
        
        self.assertEqual(t.ts, TEST_TS)
        self.assertEqual(t.metric_type, "powerMetrics")
        self.assertEqual(t.payload, {"ch3Voltage": 2.92, "ch3Current": 10.8})


class TestNodeInfoModel(unittest.TestCase):
    """Test cases for the NodeInfo model validation and behavior."""
    
    def test_nodeinfo_field_names_are_accepted(self):
        """Test that NodeInfo accepts normalized field names."""
        raw = TestDataFactory.create_node_info()
        node = NodeInfo.model_validate(raw)
        
        self.assertEqual(node.id_, TEST_NODE_ID)
        self.assertEqual(node.long_name, TEST_LONG_NAME)
        self.assertEqual(node.short_name, TEST_SHORT_NAME)
        self.assertEqual(node.hw_model, TEST_HW_MODEL)
        self.assertEqual(node.role, TEST_ROLE)

    def test_nodeinfo_alias_payload_can_be_normalized(self):
        """Test that NodeInfo can normalize alias field names."""
        raw = TestDataFactory.create_node_info_alias()
        node = NodeInfo.model_validate(_normalize_nodeinfo_dict(raw))
        
        self.assertEqual(node.id_, TEST_NODE_ID)
        self.assertEqual(node.long_name, TEST_LONG_NAME)
        self.assertEqual(node.short_name, TEST_SHORT_NAME)
        self.assertEqual(node.hw_model, TEST_HW_MODEL)
        self.assertEqual(node.role, TEST_ROLE)

    def test_nodeinfo_str_contains_id_and_names(self):
        """Test that NodeInfo string representation contains key information."""
        node = NodeInfo(
            id_=TEST_NODE_ID,
            short_name=TEST_SHORT_NAME,
            long_name=TEST_LONG_NAME,
            hw_model=TEST_HW_MODEL,
            role=TEST_ROLE,
        )
        s = str(node)
        
        self.assertIn("NodeInfo", s)
        self.assertIn(TEST_NODE_ID, s)
        self.assertIn(f"[{TEST_SHORT_NAME}]", s)
        self.assertIn(f"'{TEST_LONG_NAME}'", s)
        self.assertIn(TEST_HW_MODEL, s)
        self.assertIn(TEST_ROLE, s)


class TestMeshtasticPacketModel(unittest.TestCase):
    """Test cases for the MeshtasticPacket model validation and behavior."""
    
    def test_packet_field_names_are_accepted(self):
        """Test that MeshtasticPacket accepts normalized field names."""
        raw = TestDataFactory.create_meshtastic_packet()
        p = MeshtasticPacket.model_validate(raw)
        
        self.assertEqual(p.id_, 123)
        self.assertEqual(p.from_, 0x01020304)
        self.assertEqual(p.to, 0x05060708)
        self.assertEqual(p.channel, 1)
        self.assertEqual(p.channel_name, TEST_CHANNEL_NAME)
        self.assertEqual(p.decoded_portnum, "TEXT_MESSAGE_APP")

    def test_packet_alias_payload_can_be_normalized(self):
        """Test that MeshtasticPacket can normalize alias field names."""
        raw = TestDataFactory.create_meshtastic_packet_alias()
        p = MeshtasticPacket.model_validate(_normalize_meshtastic_packet_dict(raw))
        
        self.assertEqual(p.id_, 123)
        self.assertEqual(p.from_, 0x01020304)
        self.assertEqual(p.channel_name, TEST_CHANNEL_NAME)

    def test_rx_snr_is_coerced_to_decimal(self):
        """Test that rx_snr string values are coerced to decimal."""
        raw = TestDataFactory.create_meshtastic_packet(rx_snr="-3.25")
        p = MeshtasticPacket.model_validate(raw)
        
        self.assertIsNotNone(p.rx_snr)
        self.assertEqual(str(p.rx_snr), "-3.25")

    def test_is_broadcast(self):
        """Test that broadcast detection works correctly."""
        raw = TestDataFactory.create_meshtastic_packet(to=0xFFFFFFFF)
        p = MeshtasticPacket.model_validate(raw)
        
        self.assertTrue(p.is_broadcast)

    def test_str_contains_port_and_addresses(self):
        """Test that packet string representation contains key information."""
        raw = TestDataFactory.create_meshtastic_packet(
            id_=0x1,
            from_=0x01020304,
            to=0xFFFFFFFF,
            channel=31,
            channel_name=TEST_CHANNEL_NAME
        )
        p = MeshtasticPacket.model_validate(raw)
        s = str(p)
        
        self.assertIn("TEXT_MESSAGE_APP", s)
        self.assertIn("broadcast", s)
        self.assertIn(TEST_CHANNEL_NAME, s)


class TestTelemetryDatabaseConstraints(unittest.TestCase, DatabaseTestMixin):
    """Test cases for Telemetry database constraints and deduplication."""
    
    def test_telemetry_dedup_unique_constraint(self):
        """Test that telemetry records have unique constraints enforced."""
        with Session(self.engine) as s:
            s.add(NodeInfo(id_=TEST_NODE_ID_2))
            t1 = Telemetry(
                node_id=TEST_NODE_ID_2, 
                metric_type="powerMetrics", 
                ts=TEST_TS, 
                payload={"ch3Voltage": 2.92}
            )
            s.add(t1)
            s.commit()

        with self.assertRaises(IntegrityError):
            with Session(self.engine) as s:
                t2 = Telemetry(
                    node_id=TEST_NODE_ID_2, 
                    metric_type="powerMetrics", 
                    ts=TEST_TS, 
                    payload={"ch3Voltage": 2.92}
                )
                s.add(t2)
                s.commit()


class TestMetricCascadeDelete(unittest.TestCase, DatabaseTestMixin):
    """Test cases for Metric cascade delete behavior."""
    
    def test_metrics_deleted_when_telemetry_deleted(self):
        """Test that metrics are cascade deleted when telemetry is deleted."""
        telemetry_id = None
        with Session(self.engine) as s:
            s.add(NodeInfo(id_=TEST_NODE_ID_2))
            t = Telemetry(
                node_id=TEST_NODE_ID_2, 
                metric_type="powerMetrics", 
                ts=TEST_TS, 
                payload={"ch3Voltage": 2.92}
            )
            s.add(t)
            s.flush()
            telemetry_id = t.db_id

            m = Metric(
                telemetry_id=t.db_id,
                node_id=t.node_id,
                metric_type=t.metric_type,
                metric="ch3Voltage",
                ts=t.ts,
                value=2.92,
            )
            s.add(m)
            s.commit()

        with Session(self.engine) as s:
            telemetry = s.get(Telemetry, telemetry_id)
            self.assertIsNotNone(telemetry)
            metrics = s.exec(select(Metric)).all()
            self.assertEqual(len(metrics), 1)

        with Session(self.engine) as s:
            telemetry = s.get(Telemetry, telemetry_id)
            s.delete(telemetry)
            s.commit()

        with Session(self.engine) as s:
            metrics = s.exec(select(Metric)).all()
            self.assertEqual(len(metrics), 0)


class TestRealTrafficExamples(unittest.TestCase):
    """Test cases using real-world traffic examples to validate model behavior."""
    
    def test_models_py_nodeinfo_packet_example_validates(self):
        """Test that real NodeInfo packet from models.py validates correctly."""
        pkt = {
            "from": 2224738468,
            "to": 321385616,
            "channel": 31,
            "decoded": {
                "portnum": "NODEINFO_APP",
                "payload": {
                    "id": "!849ad0a4",
                    "longName": "🇭🇺 HA1ADM HT Mobil",
                    "shortName": "ADM4",
                    "macaddr": "sIGEmtCk",
                    "hwModel": "HELTEC_V3",
                    "role": "CLIENT_MUTE",
                    "publicKey": "04icuoGGUEY+IsF3BT89Ya2SIKSd8EUMirA/Nc9vHBM=",
                },
                "wantResponse": True,
                "bitfield": 3,
            },
            "id": 1330856275,
            "rxTime": 1766442612,
            "rxSnr": -3.25,
            "hopLimit": 4,
            "rxRssi": -105,
            "hopStart": 7,
            "nextHop": 112,
            "relayNode": 252,
            "uplink": "!a2e19ff0",
            "channelName": "MediumFast",
        }

        packet = MeshtasticPacket.model_validate(_normalize_meshtastic_packet_dict(pkt))
        self.assertEqual(packet.decoded_portnum, "NODEINFO_APP")

        node = NodeInfo.model_validate(_normalize_nodeinfo_dict(packet.decoded.get("payload")))
        self.assertEqual(node.id_, "!849ad0a4")

    def test_models_py_telemetry_packet_example_validates(self):
        """Test that real Telemetry packet from models.py validates correctly."""
        pkt = {
            "from": 2922542922,
            "to": 4294967295,
            "channel": 8,
            "decoded": {
                "portnum": "TELEMETRY_APP",
                "payload": {
                    "time": 1747876154,
                    "deviceMetrics": {
                        "batteryLevel": 91,
                        "voltage": 4.07,
                        "channelUtilization": 12.825001,
                        "airUtilTx": 6.1378055,
                        "uptimeSeconds": 1063460,
                    },
                },
                "bitfield": 1,
            },
            "id": 923524629,
            "rxTime": 1747876154,
            "priority": "BACKGROUND",
            "hopStart": 3,
            "relayNode": 74,
            "uplink": "!a2e19ff0",
            "channelName": "MediumFast",
        }

        packet = MeshtasticPacket.model_validate(_normalize_meshtastic_packet_dict(pkt))
        self.assertEqual(packet.decoded_portnum, "TELEMETRY_APP")

        telemetry = Telemetry.model_validate(packet.decoded.get("payload"))
        self.assertEqual(telemetry.ts, 1747876154)
        self.assertEqual(telemetry.metric_type, "deviceMetrics")

    def test_event_manager_traceroute_examples_validate(self):
        """Test that real traceroute packets validate correctly."""
        req = {
            "from": 2956776068,
            "to": 2552625594,
            "channel": 8,
            "decoded": {
                "portnum": "TRACEROUTE_APP",
                "wantResponse": True,
                "bitfield": 3,
                "payload": {},
            },
            "id": 2363252984,
            "rxTime": 1759165167,
            "hopLimit": 7,
            "wantAck": True,
            "priority": "RELIABLE",
            "hopStart": 7,
            "nextHop": 227,
            "relayNode": 132,
            "uplink": "!b03cd284",
            "channelName": "MediumFast",
        }
        resp = {
            "from": 2552625594,
            "to": 2956776068,
            "channel": 8,
            "decoded": {
                "portnum": "TRACEROUTE_APP",
                "payload": {
                    "route": [2574456035, 146503212],
                    "snrTowards": [11, -54, -4],
                    "routeBack": [146509480],
                    "snrBack": [36],
                },
                "requestId": 2363252984,
                "bitfield": 1,
            },
            "id": 3427050615,
            "rxTime": 1759165174,
            "rxSnr": -13.0,
            "hopLimit": 2,
            "wantAck": True,
            "rxRssi": -123,
            "hopStart": 3,
            "relayNode": 168,
            "uplink": "!b03cd284",
            "channelName": "MediumFast",
        }

        p_req = MeshtasticPacket.model_validate(_normalize_meshtastic_packet_dict(req))
        p_resp = MeshtasticPacket.model_validate(_normalize_meshtastic_packet_dict(resp))
        self.assertEqual(p_req.decoded_portnum, "TRACEROUTE_APP")
        self.assertEqual(p_resp.decoded_requestid, 2363252984)


class TestRawPacketHandlerValidatePacket(unittest.TestCase):
    """Test cases for RawPacketHandler validation with real traffic data."""
    
    def setUp(self):
        """Set up packet handler with dynamic module loading."""
        self.handler, self.packet_module = self._load_packet_handler()
        
        # Disable logging and DB writes for this test
        self.packet_module.settings.packet_json_log = False
        self.packet_module.settings.packet_sql_log = False
    
    def _load_packet_handler(self):
        """Dynamically load packet handling modules to avoid dependency conflicts."""
        # Pre-load config to satisfy relative imports
        app_dir = Path(__file__).resolve().parents[1] / "app"
        config_path = app_dir / "config.py"
        config_spec = importlib.util.spec_from_file_location("app.config", config_path)
        config_module = importlib.util.module_from_spec(config_spec)
        assert config_spec is not None and config_spec.loader is not None
        config_spec.loader.exec_module(config_module)
        sys.modules["app.config"] = config_module

        # Make app.models point to our already-loaded models to avoid table redefinition
        sys.modules["app.models"] = _models

        # Now load packet_handling
        _packet_handling_path = app_dir / "packet_handling.py"
        _packet_spec = importlib.util.spec_from_file_location("app.packet_handling", _packet_handling_path)
        _packet_module = importlib.util.module_from_spec(_packet_spec)
        assert _packet_spec is not None and _packet_spec.loader is not None
        _packet_spec.loader.exec_module(_packet_module)

        return _packet_module.RawPacketHandler, _packet_module

    def test_real_traffic_payload_converts_to_meshtasticpacket(self):
        """Test that real NodeInfo traffic payload converts to MeshtasticPacket correctly."""
        # Use a real-traffic NodeInfo packet (already in this file)
        payload = {
            "from": 2224738468,
            "to": 321385616,
            "channel": 31,
            "decoded": {
                "portnum": "NODEINFO_APP",
                "payload": {
                    "id": "!849ad0a4",
                    "longName": "🇭🇺 HA1ADM HT Mobil",
                    "shortName": "ADM4",
                    "macaddr": "sIGEmtCk",
                    "hwModel": "HELTEC_V3",
                    "role": "CLIENT_MUTE",
                    "publicKey": "04icuoGGUEY+IsF3BT89Ya2SIKSd8EUMirA/Nc9vHBM=",
                },
                "wantResponse": True,
                "bitfield": 3,
            },
            "id": 1330856275,
            "rxTime": 1766442612,
            "rxSnr": -3.25,
            "hopLimit": 4,
            "rxRssi": -105,
            "hopStart": 7,
            "nextHop": 112,
            "relayNode": 252,
            "uplink": "!a2e19ff0",
            "channelName": "MediumFast",
        }

        captured_packet = None

        def dummy_handler(target_self, packet: MeshtasticPacket):
            nonlocal captured_packet
            captured_packet = packet

        # Apply the decorator with dedup disabled
        wrapped = self.handler().validate_packet(dummy_handler, dedup=False)

        # Call the wrapper with the raw payload
        wrapped(target_self=None, json_data=payload)

        # Assert conversion succeeded
        self.assertIsNotNone(captured_packet)
        self.assertIsInstance(captured_packet, MeshtasticPacket)
        self.assertEqual(captured_packet.id_, 1330856275)
        self.assertEqual(captured_packet.from_, 2224738468)
        self.assertEqual(captured_packet.channel_name, "MediumFast")
        self.assertEqual(captured_packet.decoded_portnum, "NODEINFO_APP")


if __name__ == "__main__":
    unittest.main()
