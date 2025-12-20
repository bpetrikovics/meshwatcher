from .config import settings

from typing import Generator
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from .models import Base


DATABASE_URL = (
    f"mysql+pymysql://{settings.mysql_user}:{settings.mysql_password}"
    f"@{settings.mysql_host}:{settings.mysql_port}/{settings.mysql_db}"
)

SessionLocal = sessionmaker()

def get_engine():
    """Lazy engine creation per app context"""
    engine = create_engine(DATABASE_URL, echo=False, future=True)
    return engine

def init_db():
    """Create tables"""
    engine = get_engine()
    Base.metadata.create_all(bind=engine)

def get_db() -> Generator[Session, None, None]:
    """Flask dependency-like pattern"""
    engine = get_engine()
    SessionLocal.configure(bind=engine)
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
