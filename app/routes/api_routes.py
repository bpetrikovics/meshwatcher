from flask import Blueprint, request, jsonify
from sqlalchemy import desc, and_, or_, func
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any

from app.database import db_session
from app.models import NodeInfo, Position, Telemetry, Metric
from app.config import settings

bp = Blueprint("api", __name__, url_prefix="/api")


def parse_include_params(include_str: Optional[str]) -> List[str]:
    """Parse comma-separated include parameter into list."""
    if not include_str:
        return []
    return [item.strip() for item in include_str.split(",") if item.strip()]


def build_nodes_query(include_params: List[str], filters: Dict[str, Any], session):
    """Build highly optimized query for nodes with conditional joins."""
    # Start with base query - select only needed columns
    query = session.query(NodeInfo.id_, NodeInfo.short_name, NodeInfo.long_name, 
                         NodeInfo.macaddr, NodeInfo.hw_model, NodeInfo.role, 
                         NodeInfo.is_unmessagable, NodeInfo.updated)
    
    # Pre-filter nodes if possible to reduce window function scope
    base_filter = None
    if filters.get("node_id"):
        base_filter = NodeInfo.id_ == filters["node_id"]
        query = query.filter(base_filter)
    
    # Add position data if requested (optimized with pre-filtering)
    if "positions" in include_params:
        # Apply base filter to position subquery to reduce scope
        pos_subquery = session.query(Position.node_id, Position.latitude_i, Position.longitude_i,
                                   Position.altitude, Position.time, Position.ground_speed, 
                                   Position.ground_track, Position.precision_bits).filter(Position.time.isnot(None))
        if base_filter:
            pos_subquery = pos_subquery.filter(Position.node_id == filters["node_id"])
        
        latest_pos = (
            pos_subquery.add_columns(
                func.row_number().over(
                    partition_by=Position.node_id,
                    order_by=desc(Position.time)
                ).label('rn')
            ).subquery().alias('latest_pos')
        )
        
        # Only select position columns we need
        query = query.outerjoin(
            latest_pos, 
            and_(NodeInfo.id_ == latest_pos.c.node_id, latest_pos.c.rn == 1)
        ).add_columns(
            latest_pos.c.latitude_i, latest_pos.c.longitude_i, latest_pos.c.altitude,
            latest_pos.c.time, latest_pos.c.ground_speed, latest_pos.c.ground_track,
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
                    and_(Position.node_id == NodeInfo.id_, Position.time.isnot(None))
                ).exists()
            )
    
    if filters.get("active"):
        # Use timestamp arithmetic for better performance
        recent_time = datetime.now(timezone.utc) - timedelta(hours=24)
        query = query.filter(NodeInfo.updated >= recent_time)
    
    return query


def serialize_node(node, include_params: List[str]) -> Dict[str, Any]:
    """Serialize node data based on include parameters."""
    result = {
        "id": node.id_,
        "short_name": node.short_name,
        "long_name": node.long_name,
        "macaddr": node.macaddr,
        "hw_model": node.hw_model,
        "role": node.role,
        "is_unmessagable": node.is_unmessagable,
        "updated": node.updated.isoformat() if node.updated else None,
    }
    
    # Add position data if requested and available (from joined query)
    if "positions" in include_params and hasattr(node, 'latitude_i'):
        # Create a Position object to use its computed properties
        position = Position(
            latitude_i=node.latitude_i,
            longitude_i=node.longitude_i,
            altitude=node.altitude,
            time=node.time,
            ground_speed=node.ground_speed,
            ground_track=node.ground_track,
            precision_bits=node.precision_bits
        )
        
        result["position"] = {
            "latitude": position.latitude,
            "longitude": position.longitude,
            "altitude": position.altitude,
            "time": position.time,
            "ground_speed": position.ground_speed,
            "ground_track": position.ground_track,
            "precision_bits": position.precision_bits,
            "heading": position.heading,
            "radius": position.radius,
        }
    
    # Add telemetry data if requested and available (from joined query)
    if "telemetry" in include_params and hasattr(node, 'metric_type'):
        result["telemetry"] = {
            "metric_type": node.metric_type,
            "timestamp": node.ts,
            "payload": node.payload,
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
