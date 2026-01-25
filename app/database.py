import threading
import logging

from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from typing import Optional, Dict, Any
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel, create_engine, Session

from .config import settings


DATABASE_URL = (
    f"mysql+pymysql://{settings.mysql_user}:{settings.mysql_password}"
    f"@{settings.mysql_host}:{settings.mysql_port}/{settings.mysql_db}"
)

engine = create_engine(DATABASE_URL, echo=False, future=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def init_db():
    """Create tables once at startup time"""
    SQLModel.metadata.create_all(engine)

def get_db() -> Session:
    """
    FastAPI auto-converts to generator when used with Depends()
    """
    return SessionLocal()

@contextmanager
def db_session():
    db = get_db()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


class DbCleanupManager:
    """
    Cleanup manager for database tables.
    Starts and peridically executes a background thread to clean up old records. No explicit
    start is expected or necessary. Stop function is invoked via atexit, which is not optimal
    and should be improved (using gunicorn worker hook, worker_exit/worker_int in
    gunicorn_config.py)
    Expected to be initialized from main program at startup time, once. No multiple
    instances should exists.
    """
    def __init__(
        self,
        packet_retention_days: int = settings.packet_retention_days,
        node_retention_days: int = settings.node_retention_days,
        cleanup_interval_minutes: int = settings.db_cleanup_period_minutes,
        batch_size: int = 5000,
        dry_run: bool = False,
    ):
        self.logger = logging.getLogger(__name__)
        self.packet_retention_days =  packet_retention_days
        self.node_retention_days = node_retention_days
        self.cleanup_interval_minutes = cleanup_interval_minutes
        self.batch_size = batch_size
        self.dry_run = dry_run
        self._running = False
        self._thread = None
        
        self.packet_timestamp_col = 'createdAt'
        self.node_timestamp_col = 'updated'
        
        self.start()
    
    def _cleanup_table(self, session: Session, table: str, days: int, timestamp_col: str) -> Dict[str, Any]:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        self.logger.info("Starting cleanup for %s with cutoff %s", table, cutoff.strftime('%Y-%m-%d %H:%M %Z'))
        
        try:
            count_query = text(f"SELECT COUNT(*) FROM `{table}` WHERE `{timestamp_col}` < :cutoff")
            count_result = session.execute(count_query, {'cutoff': cutoff})
            count_before = count_result.scalar() or 0
            
            if count_before == 0:
                return {'table': table, 'count_before': 0, 'deleted': 0}

            # Section only executed if there are records to delete

            if self.dry_run:
                self.logger.info("dry_run is true, returning")
                return {'table': table, 'count_before': count_before, 'deleted': 0}
            
            self.logger.info(f"{table}: cleanup commencing, there are records to delete")
            delete_query = text(f"DELETE FROM `{table}` WHERE `{timestamp_col}` < :cutoff LIMIT :batch_size")
            delete_result = session.execute(delete_query, {'cutoff': cutoff, 'batch_size': self.batch_size})
            deleted = delete_result.rowcount or 0
            
            # No explicit commit, will be handled by context manager in _cleanup_cycle()
            return {'table': table, 'count_before': count_before, 'deleted': deleted}
            
        except Exception as e:
            self.logger.exception(e)
            session.rollback()
            return {'table': table, 'error': str(e)}
    
    def _cleanup_cycle(self):
        self.logger.info(f"Executing DB purge cycle")
        with db_session() as session:
            packet_stats = self._cleanup_table(session, 'packets', self.packet_retention_days, self.packet_timestamp_col)
            node_stats = self._cleanup_table(session, 'nodes', self.node_retention_days, self.node_timestamp_col)
            
            mode = "DRY-RUN" if self.dry_run else "LIVE"
            self.logger.info(f"Cleanup cycle: {packet_stats.get('deleted', 0)} packets, {node_stats.get('deleted', 0)} nodes deleted in {mode} mode, {self.cleanup_interval_minutes=}min")
    
    def start(self):
        if self._running:
            return
        import threading
        import time
        
        def loop():
            self._running = True
            self.logger.info(f"DB retention thread started. Retention: packets={self.packet_retention_days}d, nodes={self.node_retention_days}d")
            
            while self._running:
                try:
                    self._cleanup_cycle()
                    time.sleep(self.cleanup_interval_minutes * 60)
                except KeyboardInterrupt:
                    break
                except Exception as e:
                    self.logger.exception(e)
                    time.sleep(60)
        
        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()
    
    def stop(self):
        self.logger.info("Stopping DB retention thread")
        self._running = False
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=0)
    
    def status(self) -> Dict[str, Any]:
        return {
            'running': self._running,
            'packet_col': self.packet_timestamp_col,
            'node_col': self.node_timestamp_col,
            'dry_run': self.dry_run,
            'retention': (self.packet_retention_days, self.node_retention_days)
        }


# Singleton instance
cleanup_manager: Optional[DbCleanupManager] = None
_cleanup_lock = threading.Lock()

def get_cleanup_manager() -> DbCleanupManager:
    global cleanup_manager
    with _cleanup_lock:
        if cleanup_manager is None:
            cleanup_manager = DbCleanupManager()
        return cleanup_manager
