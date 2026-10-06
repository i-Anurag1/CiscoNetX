from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time


PBKDF2_ITERATIONS = 310_000
TOKEN_TTL_SECONDS = 3600


def hash_password(password: str, salt: bytes | None = None) -> str:
    if not isinstance(password, str) or len(password) < 10:
        raise ValueError("Password must contain at least 10 characters")
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"{salt.hex()}:{digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        salt_hex, digest_hex = encoded.split(":", 1)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError):
        return False


def issue_token(user_id: int, role: str, secret: str, ttl_seconds: int = TOKEN_TTL_SECONDS) -> str:
    if not secret or len(secret) < 32:
        raise ValueError("SECRET_KEY must contain at least 32 characters")
    exp = int(time.time()) + ttl_seconds
    payload = {
        "sub": int(user_id),
        "role": str(role),
        "iat": int(time.time()),
        "exp": exp,
    }
    body = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).decode("ascii").rstrip("=")
    signature = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def verify_token(token: str, secret: str) -> dict | None:
    try:
        if not secret or len(secret) < 32:
            return None
        payload, signature = token.split(".", 1)
        expected = hmac.new(secret.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        raw = base64.urlsafe_b64decode(payload + "=" * ((4 - len(payload) % 4) % 4))
        data = json.loads(raw)
        if int(data["exp"]) < int(time.time()):
            return None
        if "sub" not in data or "role" not in data:
            return None
        return data
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None
