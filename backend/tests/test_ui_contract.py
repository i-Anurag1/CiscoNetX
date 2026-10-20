"""Regression tests for the contract used by the Packet Tracer-style frontend."""
import os

os.environ.setdefault("APP_ENV", "development")
os.environ.setdefault("SECRET_KEY", "test-secret-key-012345678901234567890123")
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_ui_contract.db")

from fastapi.testclient import TestClient
from app.main import app
from app.db.session import Base, engine
from app.models import models  # noqa: F401

Base.metadata.create_all(bind=engine)


def test_topology_nodes_accept_canvas_positions():
    topo = {
        "nodes": [
            {"id": "r1", "name": "R1", "type": "router", "ip": "10.0.0.1", "x": 120.5, "y": 80},
            {"id": "h1", "name": "H1", "type": "host", "ip": "10.0.0.2", "x": 300, "y": 80},
        ],
        "links": [{"id": "l1", "source": "r1", "target": "h1"}],
    }
    with TestClient(app) as client:
        r = client.post("/api/v1/topology/validate", json=topo)
        assert r.status_code == 200, r.text


def test_topology_still_rejects_unknown_fields():
    topo = {"nodes": [{"id": "r1", "name": "R1", "type": "router", "bogus": 1}], "links": []}
    with TestClient(app) as client:
        assert client.post("/api/v1/topology/validate", json=topo).status_code == 422


def test_arq_v2_does_not_crash():
    with TestClient(app) as client:
        r = client.post("/api/v1/lab/arq-v2", params={"protocol": "go_back_n", "frames": 10, "window": 4, "losses": [3, 6], "seed": 42})
        assert r.status_code == 200, r.text
        assert r.json()["complete"] is True


def test_legacy_arq_route_still_works():
    with TestClient(app) as client:
        r = client.post("/api/v1/lab/arq", params={"protocol": "selective_repeat", "frames": 8, "loss_index": 2, "window": 4})
        assert r.status_code == 200, r.text
        assert r.json()["protocol"] == "selective_repeat"
