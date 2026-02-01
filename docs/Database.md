# Database Documentation

This document describes the database schema, tables, relationships, and cleanup behavior for the MeshWatcher application.

*DISCLAIMER*: This documentation was written with AI assistance.

## Overview

MeshWatcher uses a MySQL database to store Meshtastic packet data, node information, telemetry, positions, and text messages. The database is designed to handle high-volume packet ingestion while maintaining data integrity through proper foreign key relationships.

## Tables

### Core Tables

#### `packets`
Stores raw Meshtastic packet data received via MQTT.

**Columns:**
- `id` (BigInteger, Primary Key) - Packet ID from Meshtastic
- `from` (BigInteger) - Sender node ID
- `to` (BigInteger) - Recipient node ID (0xffffffff for broadcast)
- `channel` (Integer) - Channel number
- `channelName` (String(12)) - Channel name
- `decoded` (JSON) - Decoded packet contents
- `uplink` (String(9)) - Uplink node ID
- `rxTime` (Integer) - Receive timestamp
- `hopLimit` (Integer) - Hop limit
- `hopStart` (Integer) - Starting hop count
- `priority` (String(32)) - Packet priority
- `relayNode` (Integer) - Relay node ID
- `nextHop` (Integer) - Next hop node ID
- `rxSnr` (Numeric) - Signal-to-noise ratio
- `rxRssi` (Integer) - Received signal strength
- `transportMechanism` (String(32)) - Transport mechanism
- `wantAck` (Boolean) - Acknowledgment required
- `createdAt` (DateTime) - Record creation timestamp

**Indexes:**
- Primary key on `id`

**Retention:** 7 days (configurable via `packet_retention_days`)

---

#### `nodes`
Stores node information and metadata.

**Columns:**
- `id` (String(9), Primary Key) - Node ID in format `!xxxxxxxx`
- `shortName` (String(4)) - Short node name
- `longName` (String(40)) - Long node name
- `macaddr` (String(8)) - MAC address
- `hwModel` (String(32)) - Hardware model
- `publicKey` (String(64)) - Public key
- `role` (String(16)) - Node role
- `isUnmessagable` (Boolean) - Whether node can receive messages
- `updated` (DateTime) - Last update timestamp

**Indexes:**
- Primary key on `id`

**Retention:** 30 days (configurable via `node_retention_days`)

---

### Data Tables

#### `messages`
Stores text messages sent between nodes.

**Columns:**
- `db_id` (Integer, Primary Key, Auto-increment) - Internal record ID
- `nodeId` (String(9), Foreign Key → nodes.id) - Sender node ID
- `packetId` (BigInteger, NOT NULL) - Meshtastic packet ID that carried this message
- `text` (String(1024)) - Message content
- `channelName` (String(12)) - Channel name where message was received
- `replyId` (BigInteger, Nullable) - Packet ID of the message being replied to
- `emoji` (Integer, Nullable) - Emoji flag
- `bitfield` (Integer, Nullable) - Message bitfield
- `timestamp` (Integer) - Message timestamp
- `createdAt` (DateTime) - Record creation timestamp

**Foreign Keys:**
- `nodeId` → `nodes.id` (No CASCADE)

**Indexes:**
- `ix_messages_node_timestamp` on (`nodeId`, `timestamp`)
- `ix_messages_packet_id` on `packetId`
- `ix_messages_reply_id` on `replyId`

**Notes:**
- `packetId` is required and stores the Meshtastic packet ID that carried this message.
- `replyId`, when present, references the `packetId` of the original message being replied to (not the internal `db_id`).

**Retention:** 30 days (configurable via `message_retention_days`)

---

#### `positions`
Stores GPS position data from nodes.

**Columns:**
- `db_id` (Integer, Primary Key, Auto-increment) - Internal record ID
- `nodeId` (String(9), Foreign Key → nodes.id) - Node ID
- `latitudeI` (Integer) - Latitude in integer format (1e7 scale)
- `longitudeI` (Integer) - Longitude in integer format (1e7 scale)
- `altitude` (Integer, Nullable) - Altitude in meters
- `time` (Integer, Nullable) - Position timestamp
- `locationSource` (String(32)) - Source of location data
- `groundSpeed` (Integer, Nullable) - Ground speed
- `groundTrack` (Integer, Nullable) - Ground track/heading
- `precisionBits` (Integer) - Position precision
- `createdAt` (DateTime) - Record creation timestamp

**Foreign Keys:**
- `nodeId` → `nodes.id` (**CASCADE DELETE**)

**Indexes:**
- `ix_positions_node_time` on (`nodeId`, `time`)
- `ix_positions_time` on `time`

**Retention:** 30 days (follows node retention via CASCADE DELETE)

---

#### `telemetry`
Stores telemetry data from nodes.

**Columns:**
- `db_id` (Integer, Primary Key, Auto-increment) - Internal record ID
- `nodeId` (String(9), Foreign Key → nodes.id) - Node ID
- `metricType` (String(32)) - Type of metric (e.g., "deviceMetrics", "environmentMetrics")
- `ts` (Integer) - Telemetry timestamp
- `payload` (JSON) - Telemetry data payload
- `createdAt` (DateTime) - Record creation timestamp

**Foreign Keys:**
- `nodeId` → `nodes.id` (No CASCADE)

**Indexes:**
- `ix_telemetry_node_type_ts` on (`nodeId`, `metricType`, `ts`)
- `ix_telemetry_node_ts` on (`nodeId`, `ts`)
- Unique constraint on (`nodeId`, `metricType`, `ts`)

**Retention:** 90 days (configurable via `telemetry_retention_days`)

---

#### `metrics`
Stores individual metrics extracted from telemetry data.

**Columns:**
- `db_id` (Integer, Primary Key, Auto-increment) - Internal record ID
- `telemetryId` (Integer, Foreign Key → telemetry.db_id) - Parent telemetry record
- `nodeId` (String(9)) - Node ID
- `metricType` (String(32)) - Metric type
- `metric` (String(64)) - Metric name
- `ts` (Integer) - Metric timestamp
- `value` (Numeric) - Metric value
- `createdAt` (DateTime) - Record creation timestamp

**Foreign Keys:**
- `telemetryId` → `telemetry.db_id` (**CASCADE DELETE**)

**Indexes:**
- `ix_metrics_chart` on (`nodeId`, `metricType`, `metric`, `ts`)
- `ix_metrics_latest` on (`nodeId`, `metricType`, `metric`, `ts` DESC)
- `ix_metrics_telemetry_id` on `telemetryId`

**Retention:** 90 days (configurable via `metrics_retention_days` - automatically cleaned via CASCADE)

---

## Foreign Key Relationships

### Dependency Graph

```
nodes (parent)
├── messages (no CASCADE)
├── positions (CASCADE)
├── telemetry (no CASCADE)
└── metrics (CASCADE via telemetry)

packets (independent)
```

### ON DELETE Behavior

| Child Table | Parent Table | ON DELETE Behavior |
|-------------|-------------|-------------------|
| `messages.nodeId` | `nodes.id` | **NO ACTION** (must be deleted first) |
| `positions.nodeId` | `nodes.id` | **CASCADE** (auto-deleted) |
| `telemetry.nodeId` | `nodes.id` | **NO ACTION** (must be deleted first) |
| `metrics.telemetryId` | `telemetry.db_id` | **CASCADE** (auto-deleted) |

## Data Cleanup

### Cleanup Manager

The `DbCleanupManager` handles automatic data retention based on configurable time periods. It runs in a background thread and executes cleanup cycles at regular intervals.

### Cleanup Order

To maintain foreign key integrity, tables are cleaned in the following order:

1. **messages** - Must be deleted before nodes (no CASCADE)
2. **telemetry** - Must be deleted before nodes (no CASCADE)
3. **nodes** - Can only be deleted after dependent records are removed (cascades to positions)
4. **packets** - Independent, can be cleaned anytime

### Automatic Cleanup

- **metrics** are automatically deleted when their parent **telemetry** records are deleted due to the `ondelete="CASCADE"` constraint
- **positions** are automatically deleted when their parent **nodes** records are deleted due to the `ondelete="CASCADE"` constraint

### Retention Periods

| Table | Default Retention | Config Setting | Rationale |
|-------|------------------|----------------|-----------|
| `packets` | 7 days | `packet_retention_days` | High volume, short-term analytical value |
| `nodes` | 30 days | `node_retention_days` | Moderate retention for node metadata |
| `messages` | 30 days | `message_retention_days` | Similar to nodes, conversation history |
| `positions` | 30 days | **follows nodes** | Location tracking, cleaned with nodes |
| `telemetry` | 90 days | `telemetry_retention_days` | Valuable historical data |
| `metrics` | 90 days | `metrics_retention_days` | Same as telemetry (via CASCADE) |

### Configuration

All retention periods are configurable via environment variables or the `.env` file:

```bash
# Retention periods (in days)
PACKET_RETENTION_DAYS=7
NODE_RETENTION_DAYS=30
MESSAGE_RETENTION_DAYS=30
TELEMETRY_RETENTION_DAYS=90
METRICS_RETENTION_DAYS=90

# Cleanup interval (in minutes)
DB_CLEANUP_PERIOD_MINUTES=30
```

## Data Flow

1. **Packet Ingestion**: Raw packets are stored in the `packets` table
2. **Node Processing**: Node information is extracted and stored in `nodes`
3. **Data Extraction**: Depending on packet type:
   - Text messages → `messages` (stores `packetId` from the original packet)
   - Position data → `positions`
   - Telemetry data → `telemetry` → `metrics`
4. **Automatic Cleanup**: Background process removes old data based on retention policies

### Reply Threading
- Each `messages` row stores the `packetId` of the Meshtastic packet that carried it.
- When a message includes `replyId`, it references the `packetId` of the original message, enabling reply threading.

## Performance Considerations

- **Indexes**: All tables have appropriate indexes for common query patterns
- **Batch Processing**: Cleanup operations use batch processing to avoid long-running transactions
- **Cascade Optimization**: The CASCADE relationship on metrics table avoids manual cleanup
- **Timestamp Columns**: All tables use appropriate timestamp columns for efficient cleanup queries

## Backup Recommendations

Given the different retention periods, consider:

1. **Frequent backups** for `packets` table (high churn)
2. **Standard backups** for `nodes`, `messages`, `positions`
3. **Extended retention** for `telemetry` and `metrics` (valuable historical data)

## Monitoring

Monitor the following metrics:
- Table sizes and growth rates
- Cleanup cycle execution times
- Number of records deleted per cleanup cycle
- Foreign key constraint violations (should be none)
