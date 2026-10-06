from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class Node(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    name: str = Field(min_length=1, max_length=120)
    type: Literal["router", "switch", "host", "server", "firewall", "wireless"]
    ip: str | None = Field(default=None, max_length=64)
    mac: str | None = Field(default=None, max_length=32)
    vlan: int | None = Field(default=None, ge=1, le=4094)


class Link(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    source: str = Field(min_length=1, max_length=64)
    target: str = Field(min_length=1, max_length=64)
    bandwidth_mbps: float = Field(default=100, gt=0, le=1_000_000)
    latency_ms: float = Field(default=2, ge=0, le=60_000)
    jitter_ms: float = Field(default=0, ge=0, le=60_000)
    loss_rate: float = Field(default=0, ge=0, le=1)
    up: bool = True


class Topology(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nodes: list[Node] = Field(default_factory=list, max_length=1000)
    links: list[Link] = Field(default_factory=list, max_length=5000)

    @field_validator("links")
    @classmethod
    def max_link_volume(cls, links: list[Link]) -> list[Link]:
        if len(links) > 5000:
            raise ValueError("At most 5000 links are supported")
        return links


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    topology: Topology = Field(default_factory=Topology)


class SimulationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario: str = Field(default="enterprise_failover", min_length=1, max_length=100)
    seed: int = Field(default=42, ge=-2**31, le=2**31 - 1)
    source: str = Field(default="pc1", min_length=1, max_length=64)
    destination: str = Field(default="server1", min_length=1, max_length=64)
    packets: int = Field(default=100, ge=1, le=100000)


class FirewallRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_ip: str = Field(default="*", max_length=64)
    destination_ip: str = Field(default="*", max_length=64)
    protocol: str = Field(default="*", max_length=32)
    source_port: int | None = Field(default=None, ge=0, le=65535)
    destination_port: int | None = Field(default=None, ge=0, le=65535)
    action: Literal["ALLOW", "DENY", "LOG", "RATE_LIMIT"]
    priority: int = Field(default=100, ge=0, le=100000)


class AuthRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str = Field(min_length=10, max_length=256)
