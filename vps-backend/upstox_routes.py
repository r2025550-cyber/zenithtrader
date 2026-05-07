"""
Upstox FastAPI routes — VPS backend.

Mirrors Supabase edge function names so the Lovable frontend works unchanged.
All outbound traffic is forced over IPv4 (configured in main.py).

This file adds persistent JSON-file storage for Upstox credentials and tokens
so /upstox-oauth can read what /upstox-credentials wrote, even after a
uvicorn restart.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from threading import Lock
from typing import Any, Dict

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

router = APIRouter()

# ---------------------------------------------------------------------------
# Persistent settings storage
# ---------------------------------------------------------------------------

# Allow override via env var; default lives next to this file.
SETTINGS_PATH = Path(
    os.environ.get(
        "UPSTOX_SETTINGS_PATH",
        str(Path(__file__).resolve().parent / "settings.json"),
    )
)

_settings_lock = Lock()


def load_settings() -> Dict[str, Any]:
    """Read settings.json. Returns {} if missing or unreadable."""
    try:
        if not SETTINGS_PATH.exists():
            return {}
        with SETTINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        # Corrupt or unreadable — treat as empty so we never crash on boot.
        return {}


def save_settings(data: Dict[str, Any]) -> Dict[str, Any]:
    """Atomically merge + persist settings to settings.json."""
    with _settings_lock:
        current = load_settings()
        current.update(data or {})
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: write to temp file in same dir, then rename.
        fd, tmp_path = tempfile.mkstemp(
            prefix=".settings.", suffix=".json", dir=str(SETTINGS_PATH.parent)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(current, f, indent=2, sort_keys=True)
            os.replace(tmp_path, SETTINGS_PATH)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        return current


# ---------------------------------------------------------------------------
# HTTP client (IPv4 enforced globally in main.py via socket monkey-patch)
# ---------------------------------------------------------------------------

def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.AsyncHTTPTransport(retries=0),
        http2=False,
        timeout=30.0,
    )


def _require_credentials() -> Dict[str, Any]:
    s = load_settings()
    api_key = (s.get("upstox_api_key") or "").strip()
    api_secret = (s.get("upstox_api_secret") or "").strip()
    if not api_key or not api_secret:
        raise HTTPException(
            status_code=400,
            detail="Upstox credentials not configured on VPS. POST /upstox-credentials with apiKey + apiSecret.",
        )
    return s


def _require_token() -> Dict[str, Any]:
    s = load_settings()
    token = (s.get("upstox_access_token") or "").strip()
    if not token:
        raise HTTPException(
            status_code=400,
            detail="Connect Upstox OAuth before fetching market data.",
        )
    return s


async def _read_json(req: Request) -> Dict[str, Any]:
    try:
        body = await req.body()
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid JSON body")


# ---------------------------------------------------------------------------
# Credentials route
# ---------------------------------------------------------------------------

@router.post("/upstox-credentials")
async def upstox_credentials(req: Request):
    body = await _read_json(req)
    api_key = str(body.get("apiKey") or body.get("upstoxApiKey") or "").strip()
    api_secret = str(body.get("apiSecret") or body.get("upstoxApiSecret") or "").strip()
    redirect_uri = str(body.get("redirectUri") or "").strip() or None

    if not api_key or not api_secret:
        raise HTTPException(status_code=400, detail="apiKey and apiSecret are required")

    payload: Dict[str, Any] = {
        "upstox_api_key": api_key,
        "upstox_api_secret": api_secret,
        # Reset any stale tokens when keys change.
        "upstox_access_token": None,
        "upstox_refresh_token": None,
        "token_expires_at": None,
    }
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri

    save_settings(payload)
    return JSONResponse({"success": True})


# ---------------------------------------------------------------------------
# OAuth route — mirrors supabase/functions/upstox-oauth/index.ts
# ---------------------------------------------------------------------------

TOKEN_EXCHANGE_REDIRECT_URI = "http://localhost:3000"


@router.post("/upstox-oauth")
async def upstox_oauth(req: Request):
    body = await _read_json(req)
    mode = body.get("mode")
    settings = _require_credentials()

    if mode == "url":
        params = {
            "response_type": "code",
            "client_id": settings["upstox_api_key"],
            "redirect_uri": TOKEN_EXCHANGE_REDIRECT_URI,
        }
        save_settings({"redirect_uri": TOKEN_EXCHANGE_REDIRECT_URI})
        from urllib.parse import urlencode
        return JSONResponse(
            {"url": f"https://api.upstox.com/v2/login/authorization/dialog?{urlencode(params)}"}
        )

    if mode == "token":
        code = str(body.get("code") or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="code is required")

        form = {
            "code": code,
            "client_id": settings["upstox_api_key"],
            "client_secret": settings["upstox_api_secret"],
            "redirect_uri": TOKEN_EXCHANGE_REDIRECT_URI,
            "grant_type": "authorization_code",
        }
        async with _client() as client:
            resp = await client.post(
                "https://api.upstox.com/v2/login/authorization/token",
                data=form,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
            )
        try:
            token_data = resp.json()
        except ValueError:
            token_data = {}

        if resp.status_code >= 400:
            return JSONResponse(
                {"error": "Upstox OAuth failed", "details": token_data},
                status_code=resp.status_code,
            )

        expires_in = token_data.get("expires_in")
        save_settings({
            "upstox_access_token": token_data.get("access_token"),
            "upstox_refresh_token": token_data.get("refresh_token"),
            "token_expires_at": (
                int(time.time()) + int(expires_in) if expires_in else None
            ),
            "redirect_uri": TOKEN_EXCHANGE_REDIRECT_URI,
        })
        return JSONResponse({"success": True})

    raise HTTPException(status_code=400, detail="mode must be 'url' or 'token'")


# ---------------------------------------------------------------------------
# Helpers used by trading routes
# ---------------------------------------------------------------------------

def _auth_headers() -> Dict[str, str]:
    s = _require_token()
    return {
        "Authorization": f"Bearer {s['upstox_access_token']}",
        "Accept": "application/json",
    }


# ---------------------------------------------------------------------------
# Market data + trading routes (unchanged behaviour, just use load_settings)
# ---------------------------------------------------------------------------

@router.post("/fetch-nifty-data")
async def fetch_nifty_data(req: Request):
    headers = _auth_headers()
    async with _client() as client:
        resp = await client.get(
            "https://api.upstox.com/v2/market-quote/ltp",
            params={"instrument_key": "NSE_INDEX|Nifty 50"},
            headers=headers,
        )
    return JSONResponse(resp.json(), status_code=resp.status_code)


@router.post("/fetch-option-premium")
async def fetch_option_premium(req: Request):
    body = await _read_json(req)
    instrument_key = body.get("instrumentKey") or body.get("instrument_key")
    if not instrument_key:
        raise HTTPException(status_code=400, detail="instrumentKey is required")
    headers = _auth_headers()
    async with _client() as client:
        resp = await client.get(
            "https://api.upstox.com/v2/market-quote/ltp",
            params={"instrument_key": instrument_key},
            headers=headers,
        )
    return JSONResponse(resp.json(), status_code=resp.status_code)


@router.post("/place-live-order")
async def place_live_order(req: Request):
    body = await _read_json(req)
    headers = {**_auth_headers(), "Content-Type": "application/json"}
    async with _client() as client:
        resp = await client.post(
            "https://api.upstox.com/v2/order/place",
            json=body,
            headers=headers,
        )
    return JSONResponse(resp.json(), status_code=resp.status_code)


@router.post("/modify-stop-loss-order")
async def modify_stop_loss_order(req: Request):
    body = await _read_json(req)
    headers = {**_auth_headers(), "Content-Type": "application/json"}
    async with _client() as client:
        resp = await client.put(
            "https://api.upstox.com/v2/order/modify",
            json=body,
            headers=headers,
        )
    return JSONResponse(resp.json(), status_code=resp.status_code)


@router.post("/emergency-exit")
async def emergency_exit(req: Request):
    headers = {**_auth_headers(), "Content-Type": "application/json"}
    async with _client() as client:
        resp = await client.post(
            "https://api.upstox.com/v2/order/cancel-all",
            headers=headers,
        )
    return JSONResponse(resp.json(), status_code=resp.status_code)
