from pydantic import BaseModel, Field
from typing import Literal

class Node(BaseModel):
    id: str
    name: str
    type: Literal['router','switch','host','server','firewall','wireless']
    ip: str | None = None
    mac: str | None = None
    vlan: int | None = None

class Link(BaseModel):
    id: str
    source: str
    target: str
    bandwidth_mbps: float = Field(default=100, gt=0)
    latency_ms: float = Field(default=2, ge=0)
    jitter_ms: float = Field(default=0, ge=0)
    loss_rate: float = Field(default=0, ge=0, le=1)
    up: bool = True

class Topology(BaseModel):
    nodes: list[Node] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)

class ProjectCreate(BaseModel):
    name: str
    description: str = ''
    topology: Topology = Field(default_factory=Topology)

class SimulationRequest(BaseModel):
    scenario: str = 'enterprise_failover'
    seed: int = 42
    source: str = 'pc1'
    destination: str = 'server1'
    packets: int = Field(default=100, ge=1, le=100000)

class FirewallRule(BaseModel):
    source_ip: str = '*'
    destination_ip: str = '*'
    protocol: str = '*'
    source_port: int | None = None
    destination_port: int | None = None
    action: Literal['ALLOW','DENY','LOG','RATE_LIMIT']
    priority: int = 100
