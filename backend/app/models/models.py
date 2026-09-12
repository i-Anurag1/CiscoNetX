from datetime import datetime, timezone
from sqlalchemy import String, Integer, Float, Boolean, DateTime, Text, JSON, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from app.db.session import Base

def now(): return datetime.now(timezone.utc)

class Project(Base):
    __tablename__='projects'
    id: Mapped[int]=mapped_column(primary_key=True)
    name: Mapped[str]=mapped_column(String(120), unique=True, index=True)
    description: Mapped[str]=mapped_column(Text, default='')
    topology: Mapped[dict]=mapped_column(JSON, default=dict)
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now, onupdate=now)

class SimulationRun(Base):
    __tablename__='simulation_runs'
    id: Mapped[int]=mapped_column(primary_key=True)
    project_id: Mapped[int]=mapped_column(ForeignKey('projects.id'), index=True)
    scenario: Mapped[str]=mapped_column(String(100))
    seed: Mapped[int]=mapped_column(Integer)
    status: Mapped[str]=mapped_column(String(30), default='completed')
    metrics: Mapped[dict]=mapped_column(JSON, default=dict)
    events: Mapped[list]=mapped_column(JSON, default=list)
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)

class SecurityIncident(Base):
    __tablename__='security_incidents'
    id: Mapped[int]=mapped_column(primary_key=True)
    project_id: Mapped[int]=mapped_column(ForeignKey('projects.id'), index=True)
    kind: Mapped[str]=mapped_column(String(80))
    severity: Mapped[str]=mapped_column(String(20))
    source: Mapped[str]=mapped_column(String(64))
    destination: Mapped[str]=mapped_column(String(64))
    evidence: Mapped[str]=mapped_column(Text)
    action: Mapped[str]=mapped_column(String(30))
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)

class AuditEvent(Base):
    __tablename__='audit_events'
    id: Mapped[int]=mapped_column(primary_key=True)
    project_id: Mapped[int]=mapped_column(ForeignKey('projects.id'), index=True)
    action: Mapped[str]=mapped_column(String(100))
    details: Mapped[dict]=mapped_column(JSON, default=dict)
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)

class User(Base):
    __tablename__='users'
    id: Mapped[int]=mapped_column(primary_key=True)
    email: Mapped[str]=mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str]=mapped_column(String(256))
    role: Mapped[str]=mapped_column(String(30), default='engineer')
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)


class Experiment(Base):
    __tablename__='experiments'
    id: Mapped[int]=mapped_column(primary_key=True)
    project_id: Mapped[int]=mapped_column(ForeignKey('projects.id'), index=True)
    name: Mapped[str]=mapped_column(String(160))
    seed: Mapped[int]=mapped_column(Integer)
    configuration: Mapped[dict]=mapped_column(JSON, default=dict)
    results: Mapped[dict]=mapped_column(JSON, default=dict)
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)

class NetworkPolicy(Base):
    __tablename__='network_policies'
    id: Mapped[int]=mapped_column(primary_key=True)
    project_id: Mapped[int]=mapped_column(ForeignKey('projects.id'), index=True)
    name: Mapped[str]=mapped_column(String(160))
    policy: Mapped[dict]=mapped_column(JSON, default=dict)
    enabled: Mapped[bool]=mapped_column(Boolean, default=True)
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)

class MLModelVersion(Base):
    __tablename__='ml_model_versions'
    id: Mapped[int]=mapped_column(primary_key=True)
    project_id: Mapped[int]=mapped_column(ForeignKey('projects.id'), index=True)
    name: Mapped[str]=mapped_column(String(160))
    version: Mapped[str]=mapped_column(String(40))
    metrics: Mapped[dict]=mapped_column(JSON, default=dict)
    artifact: Mapped[dict]=mapped_column(JSON, default=dict)
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)
