import os
import tempfile

import pytest
from pydantic import ValidationError

os.environ.setdefault("APP_ENV", "development")
os.environ.setdefault("SECRET_KEY", "test-secret-key-012345678901234567890123")

from app.networking import validate_topology
from app.schemas.network import AuthRequest, Topology
from app.security.auth import hash_password, issue_token, verify_password, verify_token


def test_password_hash_round_trip():
    encoded = hash_password("strong-password-123")
    assert verify_password("strong-password-123", encoded)
    assert not verify_password("wrong-password-123", encoded)


def test_token_round_trip_and_tamper_detection():
    secret = "test-secret-key-012345678901234567890123"
    token = issue_token(7, "engineer", secret)
    assert verify_token(token, secret)["sub"] == 7
    assert verify_token(token[:-1] + ("0" if token[-1] != "0" else "1"), secret) is None


def test_production_secret_requirement_is_enforced_by_token_issuer():
    with pytest.raises(ValueError):
        issue_token(1, "engineer", "short")


def test_topology_validation_catches_duplicates_invalid_ip_and_self_link():
    topology = {
        "nodes": [
            {"id": "r1", "name": "R1", "type": "router", "ip": "10.0.0.1"},
            {"id": "r1", "name": "R1-copy", "type": "router", "ip": "999.1.1.1"},
        ],
        "links": [
            {"id": "l1", "source": "r1", "target": "r1", "bandwidth_mbps": 10},
        ],
    }
    result = validate_topology(topology)
    assert not result["valid"]
    assert "Duplicate node id" in result["errors"]
    assert "Invalid IP address on node r1" in result["errors"]
    assert "Self-link not allowed on l1" in result["errors"]


def test_schema_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        Topology.model_validate({"nodes": [], "links": [], "unexpected": True})


def test_auth_email_validation():
    with pytest.raises(ValidationError):
        AuthRequest.model_validate({"email": "not-an-email", "password": "long-password-123"})


def test_auth_password_length_validation():
    with pytest.raises(ValidationError):
        AuthRequest.model_validate({"email": "user@example.com", "password": "short"})
