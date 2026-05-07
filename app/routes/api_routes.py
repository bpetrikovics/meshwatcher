from flask import Blueprint, request, jsonify
from sqlalchemy import desc, and_, or_, func
from datetime import datetime, timezone, timedelta
import math
from typing import Optional, List, Dict, Any

from app.database import db_session
from app.models import NodeInfo, Position, Telemetry, Metric, MeshtasticPacket
from app.config import settings

bp = Blueprint("api", __name__, url_prefix="/api")


def parse_include_params(include_str: Optional[str]) -> List[str]:
    """Parse comma-separated include parameter into list."""
    if not include_str:
        return []
    return [item.strip() for item in include_str.split(",") if item.strip()]


def calculate_position_age(position_created_at: Optional[datetime]) -> Optional[float]:
    """Calculate position age in hours ago from created_at timestamp."""
    if not position_created_at:
        return None
    
    try:
        # Proper timezone-aware calculation
        now = datetime.now(timezone.utc)
        pos_created = position_created_at
        if pos_created.tzinfo is None:
            # Assume UTC if no timezone info
            pos_created = pos_created.replace(tzinfo=timezone.utc)
        else:
            # Convert to UTC for consistent comparison
            pos_created = pos_created.astimezone(timezone.utc)
        
        time_diff = now - pos_created
        age_hours_ago = time_diff.total_seconds() / 3600
        if age_hours_ago < 0:
            age_hours_ago = 0.0
        age_hours_ago = round(age_hours_ago, 4)
        
        return age_hours_ago
    except (OverflowError, TypeError, ValueError):
        # If datetime calculation fails, return None
        return None


def build_nodes_query(include_params: List[str], filters: Dict[str, Any], session):
    """Build highly optimized query for nodes with conditional joins."""
    # Start with base query - select only needed columns
    query = session.query(NodeInfo.id_, NodeInfo.short_name, NodeInfo.long_name, 
                         NodeInfo.macaddr, NodeInfo.hw_model, NodeInfo.role, 
                         NodeInfo.is_unmessagable, NodeInfo.updated,
                         NodeInfo.last_channel, NodeInfo.last_channel_name)
    
    # Pre-filter nodes if possible to reduce window function scope
    base_filter = None
    if filters.get("node_id"):
        base_filter = NodeInfo.id_ == filters["node_id"]
        query = query.filter(base_filter)
    
    # Add position data if requested (optimized with pre-filtering)
    if "positions" in include_params:
        # Apply base filter to position subquery to reduce scope
        pos_subquery = session.query(Position.node_id, Position.latitude_i, Position.longitude_i,
                                   Position.altitude, Position.time, Position.created_at, Position.ground_speed, 
                                   Position.ground_track, Position.precision_bits)
        if base_filter:
            pos_subquery = pos_subquery.filter(Position.node_id == filters["node_id"])
        
        latest_pos = (
            pos_subquery.add_columns(
                func.row_number().over(
                    partition_by=Position.node_id,
                    order_by=desc(Position.created_at)
                ).label('rn')
            ).subquery().alias('latest_pos')
        )
        
        # Only select position columns we need
        query = query.outerjoin(
            latest_pos, 
            and_(NodeInfo.id_ == latest_pos.c.node_id, latest_pos.c.rn == 1)
        ).add_columns(
            latest_pos.c.latitude_i, latest_pos.c.longitude_i, latest_pos.c.altitude,
            latest_pos.c.time, latest_pos.c.created_at, latest_pos.c.ground_speed, latest_pos.c.ground_track,
            latest_pos.c.precision_bits
        )
    
    # Add telemetry data if requested (optimized with pre-filtering)
    if "telemetry" in include_params:
        # Apply base filter to telemetry subquery to reduce scope
        telem_subquery = session.query(Telemetry.node_id, Telemetry.metric_type, Telemetry.ts, Telemetry.payload)
        if base_filter:
            telem_subquery = telem_subquery.filter(Telemetry.node_id == filters["node_id"])
        
        latest_telem = (
            telem_subquery.add_columns(
                func.row_number().over(
                    partition_by=[Telemetry.node_id, Telemetry.metric_type],
                    order_by=desc(Telemetry.ts)
                ).label('rn')
            ).subquery().alias('latest_telem')
        )
        
        # Join with telemetry data
        query = query.outerjoin(
            latest_telem,
            and_(NodeInfo.id_ == latest_telem.c.node_id, latest_telem.c.rn == 1)
        ).add_columns(
            latest_telem.c.metric_type, latest_telem.c.ts, latest_telem.c.payload
        )
    
    # Apply remaining filters
    if filters.get("has_position"):
        if "positions" in include_params:
            query = query.filter(latest_pos.c.node_id.isnot(None))
        else:
            # Use EXISTS for better performance than JOIN+DISTINCT
            query = query.filter(
                session.query(Position).filter(
                    Position.node_id == NodeInfo.id_
                ).exists()
            )
    
    if filters.get("active"):
        # Use timestamp arithmetic for better performance
        recent_time = datetime.now(timezone.utc) - timedelta(hours=24)
        query = query.filter(NodeInfo.updated >= recent_time)
    
    return query


def serialize_node(node, include_params: List[str], session=None) -> Dict[str, Any]:
    """Serialize node data based on include parameters."""
    result = {
        "id": node.id_,
        "short_name": node.short_name,
        "long_name": node.long_name,
        "macaddr": node.macaddr,
        "hw_model": node.hw_model,
        "role": node.role or "CLIENT",
        "is_unmessagable": node.is_unmessagable,
        "updated": (
            (node.updated.replace(tzinfo=timezone.utc) if node.updated.tzinfo is None else node.updated)
        ).isoformat()
        if node.updated
        else None,
        "last_channel": node.last_channel,
        "last_channel_name": node.last_channel_name,
    }
    
    # Add position data if requested and available (from joined query)
    if (
        "positions" in include_params
        and hasattr(node, 'latitude_i')
        and node.latitude_i is not None
        and node.longitude_i is not None
    ):
        # Create a Position object to use its computed properties
        position = Position(
            latitude_i=node.latitude_i,
            longitude_i=node.longitude_i,
            altitude=node.altitude,
            time=node.time,
            created_at=node.created_at,
            ground_speed=node.ground_speed,
            ground_track=node.ground_track,
            precision_bits=node.precision_bits
        )
        
        result["position"] = {
            "latitude": position.latitude,
            "longitude": position.longitude,
            "altitude": position.altitude,
            "time": position.time,
            "created_at": (
                (
                    position.created_at.replace(tzinfo=timezone.utc)
                    if position.created_at.tzinfo is None
                    else position.created_at
                ).isoformat()
                if position.created_at
                else None
            ),
            "ground_speed_kmph": position.ground_speed,
            "ground_track": position.ground_track,
            "precision_bits": position.precision_bits,
            "heading": position.heading,
            "radius": position.radius,
            "position_age_hours_ago": calculate_position_age(position.created_at),
        }
    
    # Add telemetry data if requested and available (from joined query)
    if "telemetry" in include_params and hasattr(node, 'metric_type'):
        result["telemetry"] = {
            "metric_type": node.metric_type,
            "timestamp": node.ts,
            "payload": node.payload,
        }
    
    # Add additional info if requested
    if "info" in include_params:
        # Calculate status based on last update
        status = "inactive"  # Default status
        last_seen_hours_ago = None
        
        if node.updated:
            try:
                # Proper timezone-aware calculation
                now = datetime.now(timezone.utc)
                node_updated = node.updated
                if node_updated.tzinfo is None:
                    # Assume UTC if no timezone info
                    node_updated = node_updated.replace(tzinfo=timezone.utc)
                else:
                    # Convert to UTC for consistent comparison
                    node_updated = node_updated.astimezone(timezone.utc)
                
                time_diff = now - node_updated
                last_seen_hours_ago = time_diff.total_seconds() / 3600
                if last_seen_hours_ago < 0:
                    last_seen_hours_ago = 0.0
                last_seen_hours_ago = round(last_seen_hours_ago, 4)
                
                # Use configurable thresholds
                if last_seen_hours_ago < settings.status_currently_active_hours:
                    status = "currently_active"
                elif last_seen_hours_ago < settings.status_recently_active_hours:
                    status = "recently_active"
                # Else remains "inactive"
            except (OverflowError, TypeError, ValueError):
                # If datetime calculation fails, set default status
                status = "inactive"
                last_seen_hours_ago = None
        
        result["info"] = {
            "has_position": bool(hasattr(node, 'latitude_i') and node.latitude_i is not None and node.longitude_i is not None),
            "last_seen": (
                (node.updated.replace(tzinfo=timezone.utc) if node.updated.tzinfo is None else node.updated)
            ).isoformat()
            if node.updated
            else None,
            "status": status,
            "last_seen_hours_ago": last_seen_hours_ago,
            # Enhanced node metadata
            "role": node.role or "CLIENT",
            "hw_model": node.hw_model,
            "is_unmessagable": node.is_unmessagable,
        }
    
    return result


@bp.route("/nodes")
def get_nodes():
    """Get nodes with configurable data inclusion and pagination."""
    
    # Parse query parameters
    include_params = parse_include_params(request.args.get("include"))
    limit = min(int(request.args.get("limit", 1000)), 5000)  # Max 5000
    offset = int(request.args.get("offset", 0))
    node_id = request.args.get("node_id")
    has_position = request.args.get("has_position", "").lower() == "true"
    active = request.args.get("active", "").lower() == "true"
    
    # Build filters
    filters = {
        "node_id": node_id,
        "has_position": has_position,
        "active": active,
    }
    
    # Use database session
    with db_session() as session:
        # Build query
        query = build_nodes_query(include_params, filters, session)
        
        # Get total count for pagination
        total_count = query.count()
        
        # Apply pagination
        nodes = query.offset(offset).limit(limit).all()
        
        # Serialize results (no N+1 queries - data already joined)
        results = [serialize_node(node, include_params) for node in nodes]
        
        # Build response
        response = {
            "nodes": results,
            "pagination": {
                "total_count": total_count,
                "limit": limit,
                "offset": offset,
                "has_more": offset + limit < total_count,
                "next_offset": offset + limit if offset + limit < total_count else None,
            }
        }
        
        return jsonify(response)


@bp.route("/nodes/<string:node_id>/positions")
def get_node_positions(node_id):
    """Get all position history for a specific node."""
    
    limit = request.args.get("limit")
    max_points = request.args.get("max_points")
    since_hours = request.args.get("since_hours", "24")

    try:
        since_hours_val = float(since_hours)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid since_hours parameter"}), 400

    since_hours_val = min(max(since_hours_val, 0), 168)

    max_points_raw = max_points if max_points is not None else limit
    if max_points_raw is None:
        max_points_val = 2000
    else:
        try:
            max_points_val = int(max_points_raw)
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid max_points parameter"}), 400

    max_points_val = min(max(max_points_val, 1), 5000)
    
    # Use database session
    with db_session() as session:
        # Build base query
        query = session.query(Position).filter(Position.node_id == node_id)

        since_time = datetime.now(timezone.utc) - timedelta(hours=since_hours_val)
        query = query.filter(Position.created_at >= since_time)

        query = query.order_by(Position.created_at.desc()).limit(max_points_val)

        positions = list(reversed(query.all()))
        
        # Serialize positions
        results = []
        for pos in positions:
            created_at = pos.created_at
            if created_at is not None and created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)

            # Use Position model's computed properties
            result = {
                "latitude": pos.latitude,
                "longitude": pos.longitude,
                "created_at": created_at.isoformat() if created_at else None,
                "altitude": pos.altitude,
                "precision_bits": pos.precision_bits,
                "radius": pos.radius,
                "ground_speed_kmph": pos.ground_speed,
                "heading": pos.heading,
            }
            results.append(result)
        
        return jsonify({"positions": results})


@bp.route("/nodes/<string:node_id>/telemetry/summary")
def get_node_telemetry_summary(node_id):
    """Get telemetry summary for a specific node (available metrics and recency)."""
    
    since_hours = request.args.get("since_hours", "24")
    try:
        since_hours_val = float(since_hours)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid since_hours parameter"}), 400

    since_hours_val = min(max(since_hours_val, 0), 168)  # clamp to 0-7 days

    with db_session() as session:
        # Filter by telemetry timestamp (ts) instead of row insertion time.
        # This keeps summary behavior aligned with chart queries and existing data.
        since_time = datetime.now(timezone.utc) - timedelta(hours=since_hours_val)
        since_ts = int(since_time.timestamp())
        
        # Query distinct metric types and metrics with their latest timestamps
        from sqlalchemy import func, desc
        
        # Get the latest timestamp for each metric_type + metric combination
        subquery = session.query(
            Metric.metric_type,
            Metric.metric,
            func.max(Metric.ts).label('latest_ts')
        ).filter(
            Metric.node_id == node_id,
            Metric.ts >= since_ts
        ).group_by(
            Metric.metric_type,
            Metric.metric
        ).subquery()
        
        # Join back to get the full results ordered consistently
        results = session.query(
            subquery.c.metric_type,
            subquery.c.metric,
            subquery.c.latest_ts
        ).order_by(
            subquery.c.metric_type,
            subquery.c.metric
        ).all()
        
        # Build response
        metrics = []
        for metric_type, metric, latest_ts in results:
            metrics.append({
                "metric_type": metric_type,
                "metric": metric,
                "latest_ts": latest_ts
            })
        
        summary = {
            "node_id": node_id,
            "since_hours": since_hours_val,
            "metrics": metrics[:20],  # Limit to 20 as per plan
            "total_metrics": len(metrics)
        }
        
        return jsonify(summary)


@bp.route("/nodes/<string:node_id>/metrics/series")
def get_node_metrics_series(node_id):
    """Get time series data for a specific metric."""
    
    # Get query parameters
    metric_type = request.args.get("metric_type")
    metric = request.args.get("metric")
    since_hours = request.args.get("since_hours", "24")
    max_points = request.args.get("max_points", "1000")
    
    if not metric_type or not metric:
        return jsonify({"error": "metric_type and metric parameters are required"}), 400
    
    try:
        since_hours_val = float(since_hours)
        max_points_val = int(max_points)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid since_hours or max_points parameter"}), 400
    
    # Enforce limits
    since_hours_val = min(since_hours_val, 168)  # Max 7 days
    max_points_val = min(max_points_val, 5000)   # Max 5000 points
    
    with db_session() as session:
        # Calculate since time
        since_time = datetime.now(timezone.utc) - timedelta(hours=since_hours_val)
        since_ts = int(since_time.timestamp())
        
        # Query metrics
        query = session.query(Metric.ts, Metric.value).filter(
            Metric.node_id == node_id,
            Metric.metric_type == metric_type,
            Metric.metric == metric,
            Metric.ts >= since_ts
        ).order_by(Metric.ts.asc())
        
        results = query.all()
        
        # Simple downsampling if too many points
        if len(results) > max_points_val:
            # Take every nth point
            step = max(1, math.ceil(len(results) / max_points_val))
            results = results[::step]
            if len(results) > max_points_val:
                results = results[:max_points_val]
        
        # Build response
        series = []
        for ts, value in results:
            series.append({
                "ts": ts,
                "value": float(value)
            })
        
        response = {
            "node_id": node_id,
            "metric_type": metric_type,
            "metric": metric,
            "since_hours": since_hours_val,
            "points": len(series),
            "series": series
        }
        
        return jsonify(response)
