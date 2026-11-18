#!/usr/bin/env python3
"""Redacted magpie auth probe. Never prints the key."""
import os
import urllib.error
import urllib.request

url = (os.environ.get("ANTHROPIC_BASE_URL") or "").rstrip("/") + "/v1/models"
key = os.environ.get("ANTHROPIC_AUTH_TOKEN") or ""
req = urllib.request.Request(
    url, headers={"Authorization": "Bearer " + key, "x-api-key": key}
)
try:
    with urllib.request.urlopen(req, timeout=8) as r:
        print("auth_http", r.status)
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", "replace")[:300]
    if key:
        body = body.replace(key, "***")
    print("auth_http", e.code)
    print("auth_body", body)
except Exception as e:
    print("auth_error", type(e).__name__, str(e)[:200])
