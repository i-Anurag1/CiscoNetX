import os

os.environ.setdefault("APP_ENV", "development")
os.environ.setdefault("SECRET_KEY", "test-secret-key-012345678901234567890123")
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_smoke.db")

from fastapi.testclient import TestClient
from app.main import app
from app.db.session import Base, engine
from app.models import models
Base.metadata.create_all(bind=engine)


def test_health_and_default_topology():
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        topo = client.get("/api/v1/topology/default")
        assert topo.status_code == 200
        assert topo.json()["nodes"]
        assert topo.json()["links"]


def test_invalid_topology_is_rejected():
    payload = {
        "nodes": [
            {"id": "r1", "name": "R1", "type": "router", "ip": "not-an-ip"}
        ],
        "links": []
    }
    with TestClient(app) as client:
        response = client.post("/api/v1/topology/validate", json=payload)
        assert response.status_code == 200
        assert response.json()["valid"] is False


def test_auth_register_login_verify():
    email = "smoke-user@example.com"
    password = "strong-password-123"
    with TestClient(app) as client:
        register = client.post("/api/v1/auth/register", json={"email": email, "password": password})
        assert register.status_code == 200, register.text
        token = register.json()["token"]

        verify = client.get("/api/v1/auth/verify", headers={"Authorization": f"Bearer {token}"})
        assert verify.status_code == 200
        assert verify.json()["valid"] is True

        login = client.post("/api/v1/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        assert login.json()["token"]


def test_projects_require_authentication():
    with TestClient(app) as client:
        response = client.get("/api/v1/projects")
        assert response.status_code == 401
