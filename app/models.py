from sqlalchemy.orm import declarative_base
from sqlalchemy import (
    Column,
    Float,
    Integer,
    String,
    DateTime,
    ForeignKey,
    Index
)

Base = declarative_base()
