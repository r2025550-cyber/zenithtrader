"""
Upstox FastAPI routes — VPS backend.

Mirrors Supabase edge function names AND response shapes so the Lovable
frontend works unchanged. All outbound traffic is forced over IPv4
(configured in main.py).
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse as FastAPIJSONResponse

router = APIRouter()
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
}


class JSONResponse(FastAPIJSONResponse):
    def __init__(self, content: Any = None, status_code: int = 200, headers: Optional[Dict[str, str]] = None, **kwargs):
        merged_headers = {**CORS_HEADERS, **(headers or {})}
        super().__init__(content=content, status_code=status_code, headers=merged_headers, **kwargs)


@router.options("/{full_path:path}")
async def cors_preflight(full_path: str):
    return JSONResponse({"ok": True})


@router.get("/")
async def health_root():
    return JSONResponse({"ok": True, "service": "zenith-upstox-vps"})

# ---------------------------------------------------------------------------
# Persistent settings storage
# ---------------------------------------------------------------------------

SETTINGS_PATH = Path(
    os.environ.get(
        "UPSTOX_SETTINGS_PATH",
        str(Path(__file__).resolve().parent / "settings.json"),
    )
)
_settings_lock = Lock()
_market_cache: Dict[str, Any] = {"data": None, "ts": 0.0}


def load_settings() -> Dict[str, Any]:
    try:
        if not SETTINGS_PATH.exists():
            return {}
        with SETTINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_settings(data: Dict[str, Any]) -> Dict[str, Any]:
    with _settings_lock:
        current = load_settings()
        current.update(data or {})
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
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
# HTTP client
# ---------------------------------------------------------------------------

INSTRUMENT_KEY = "NSE_INDEX|Nifty 50"
NIFTY_LOT_SIZE = 65
CONTEXT_BANKNIFTY = "NSE_INDEX|Nifty Bank"
CONTEXT_VIX = "NSE_INDEX|India VIX"
CONTEXT_HEAVY = ["NSE_EQ|INE040A01034", "NSE_EQ|INE002A01018", "NSE_EQ|INE090A01021"]


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.AsyncHTTPTransport(retries=0),
        http2=False,
        timeout=30.0,
    )


def _num(*values) -> Optional[float]:
    for v in values:
        if v is None or v == "":
            continue
        try:
            n = float(v)
            if n == n:  # not NaN
                return n
        except (TypeError, ValueError):
            continue
    return None


def _fetch_token_from_supabase() -> Optional[Dict[str, Any]]:
    """Best-effort sync: pull the manual/OAuth access token from Supabase.

    Used as a fallback when the VPS settings.json doesn't have a token but
    Supabase already does (e.g. user pasted a Permanent Access Token via the
    web UI which only persisted to Supabase). Synchronous httpx call so this
    can be used from inside `_require_token` without restructuring callers.
    """
    supabase_url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY") or ""
    if not supabase_url or not service_key:
        return None
    try:
        with httpx.Client(timeout=10.0) as c:
            r = c.get(
                f"{supabase_url}/rest/v1/trading_api_settings",
                params={"select": "user_id,upstox_access_token,upstox_api_key,upstox_api_secret,token_expires_at", "upstox_access_token": "not.is.null", "limit": "1"},
                headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
            )
        if r.status_code >= 400:
            return None
        rows = r.json() if r.content else []
        if not rows:
            return None
        row = rows[0]
        token = (row.get("upstox_access_token") or "").strip()
        if not token:
            return None
        payload: Dict[str, Any] = {"upstox_access_token": token}
        if row.get("upstox_api_key"):
            payload["upstox_api_key"] = row["upstox_api_key"]
        if row.get("upstox_api_secret"):
            payload["upstox_api_secret"] = row["upstox_api_secret"]
        if row.get("user_id"):
            payload["user_id"] = row["user_id"]
        if row.get("token_expires_at"):
            payload["token_expires_at"] = row["token_expires_at"]
        save_settings(payload)
        return load_settings()
    except Exception:
        return None


def _require_token() -> Dict[str, Any]:
    s = load_settings()
    token = (s.get("upstox_access_token") or "").strip()
    if not token:
        # Fallback: try pulling the manual / OAuth token from Supabase so the
        # user doesn't have to re-paste it on the VPS after every restart.
        synced = _fetch_token_from_supabase()
        if synced and (synced.get("upstox_access_token") or "").strip():
            return synced
        raise HTTPException(
            status_code=400,
            detail="Upstox access token missing on VPS. Re-save the Permanent Access Token in API Settings.",
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


def _auth_headers() -> Dict[str, str]:
    s = _require_token()
    return {
        "Authorization": f"Bearer {s['upstox_access_token']}",
        "Accept": "application/json",
    }


def _is_invalid_token(payload: Any) -> bool:
    return "UDAPI100050" in json.dumps(payload or {})


def _clear_token():
    save_settings({
        "upstox_access_token": None,
        "upstox_refresh_token": None,
        "token_expires_at": None,
    })


# ---------------------------------------------------------------------------
# Credentials + OAuth (unchanged behaviour)
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
        "upstox_access_token": None,
        "upstox_refresh_token": None,
        "token_expires_at": None,
    }
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri
    user_id = str(body.get("userId") or body.get("user_id") or "").strip()
    if user_id:
        payload["user_id"] = user_id
    save_settings(payload)
    return JSONResponse({"success": True})


TOKEN_EXCHANGE_REDIRECT_URI = os.environ.get("UPSTOX_REDIRECT_URI", "https://virginia-cast-flood-before.trycloudflare.com/callback")


async def _sync_token_to_supabase(user_id: str, token_payload: Dict[str, Any], redirect_uri: str) -> Dict[str, Any]:
    supabase_url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY") or ""
    if not user_id or not supabase_url or not service_key:
        return {"ok": False, "message": "Supabase sync skipped: user_id or service key missing on VPS."}
    expires_in = token_payload.get("expires_in")
    row = {
        "user_id": user_id,
        "upstox_access_token": token_payload.get("access_token"),
        "upstox_refresh_token": token_payload.get("refresh_token"),
        "token_expires_at": (datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))).isoformat() if expires_in else None,
        "redirect_uri": redirect_uri,
    }
    async with _client() as c:
        resp = await c.post(
            f"{supabase_url}/rest/v1/trading_api_settings?on_conflict=user_id",
            json=row,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )
    return {"ok": resp.status_code < 400, "status": resp.status_code, "body": resp.text[:500]}


@router.post("/upstox-token")
async def upstox_token(req: Request):
    """Accept a permanent / manual access token and persist it on the VPS.

    This bypasses the OAuth flow entirely so /fetch-nifty-data and order
    placement endpoints can authorise immediately.
    """
    body = await _read_json(req)
    if body.get("clear") is True:
        _clear_token()
        return JSONResponse({"success": True, "message": "Saved Upstox token cleared on VPS."})

    token = str(
        body.get("accessToken")
        or body.get("access_token")
        or body.get("upstoxAccessToken")
        or body.get("upstox_access_token")
        or body.get("manualAccessToken")
        or body.get("token")
        or ""
    ).strip()
    if not token:
        raise HTTPException(status_code=400, detail="access token is required")
    payload: Dict[str, Any] = {
        "upstox_access_token": token,
        "upstox_refresh_token": None,
        # Treat manual tokens as long-lived; expire ~24h ahead as a hint only.
        "token_expires_at": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
    }
    api_key = str(body.get("apiKey") or body.get("upstoxApiKey") or "").strip()
    api_secret = str(body.get("apiSecret") or body.get("upstoxApiSecret") or "").strip()
    if api_key:
        payload["upstox_api_key"] = api_key
    if api_secret:
        payload["upstox_api_secret"] = api_secret
    user_id = str(body.get("userId") or body.get("user_id") or "").strip()
    if user_id:
        payload["user_id"] = user_id
    save_settings(payload)
    return JSONResponse({"success": True, "message": "Manual access token stored on VPS."})


@router.post("/upstox-oauth")
async def upstox_oauth(req: Request):
    try:
        body = await _read_json(req)
    except HTTPException as e:
        return JSONResponse({"error": "invalid_json", "detail": e.detail}, status_code=400)

    mode = (body.get("mode") or "url").strip()
    settings = load_settings()
    api_key = (settings.get("upstox_api_key") or "").strip()
    api_secret = (settings.get("upstox_api_secret") or "").strip()
    if not api_key or not api_secret:
        return JSONResponse(
            {
                "error": "credentials_missing",
                "detail": "Upstox credentials not found in settings.json on VPS.",
                "settings_path": str(SETTINGS_PATH),
                "loaded_keys": sorted(settings.keys()),
                "hint": "POST /upstox-credentials with apiKey + apiSecret first.",
            },
            status_code=400,
        )

    if mode == "url":
        redirect_uri = str(body.get("redirectUri") or settings.get("redirect_uri") or TOKEN_EXCHANGE_REDIRECT_URI).strip()
        user_id = str(body.get("userId") or settings.get("user_id") or "").strip()
        params = {
            "response_type": "code",
            "client_id": api_key,
            "redirect_uri": redirect_uri,
        }
        if user_id:
            params["state"] = user_id
        save_settings({"redirect_uri": redirect_uri, "user_id": user_id or settings.get("user_id")})
        return JSONResponse({
            "url": f"https://api.upstox.com/v2/login/authorization/dialog?{urlencode(params)}",
        })

    if mode == "token":
        code = str(body.get("code") or "").strip()
        redirect_uri = str(body.get("redirectUri") or settings.get("redirect_uri") or TOKEN_EXCHANGE_REDIRECT_URI).strip()
        user_id = str(body.get("userId") or settings.get("user_id") or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="code is required")
        form = {
            "code": code,
            "client_id": api_key,
            "client_secret": api_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
        async with _client() as c:
            resp = await c.post(
                "https://api.upstox.com/v2/login/authorization/token",
                data=form,
                headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            )
        try:
            tok = resp.json()
        except ValueError:
            tok = {}
        if resp.status_code >= 400:
            return JSONResponse({"error": "Upstox OAuth failed", "details": tok}, status_code=resp.status_code)
        expires_in = tok.get("expires_in")
        save_settings({
            "upstox_access_token": tok.get("access_token"),
            "upstox_refresh_token": tok.get("refresh_token"),
            "token_expires_at": int(time.time()) + int(expires_in) if expires_in else None,
            "redirect_uri": redirect_uri,
            "user_id": user_id or settings.get("user_id"),
        })
        sync_result = await _sync_token_to_supabase(user_id, tok, redirect_uri)
        return JSONResponse({"success": True, "supabaseSync": sync_result})

    raise HTTPException(status_code=400, detail="mode must be 'url' or 'token'")


@router.get("/callback")
async def upstox_callback(req: Request):
    code = str(req.query_params.get("code") or "").strip()
    settings = load_settings()
    user_id = str(req.query_params.get("state") or settings.get("user_id") or "").strip()
    redirect_uri = str(req.url).split("?")[0]
    if not code:
        return HTMLResponse("<h3>Upstox callback missing code.</h3>", status_code=400)
    api_key = (settings.get("upstox_api_key") or "").strip()
    api_secret = (settings.get("upstox_api_secret") or "").strip()
    if not api_key or not api_secret:
        return HTMLResponse("<h3>Upstox credentials missing on VPS. Save Upstox first.</h3>", status_code=400)
    form = {"code": code, "client_id": api_key, "client_secret": api_secret, "redirect_uri": redirect_uri, "grant_type": "authorization_code"}
    async with _client() as c:
        resp = await c.post("https://api.upstox.com/v2/login/authorization/token", data=form, headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
    tok = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if resp.status_code >= 400:
        return HTMLResponse(f"<h3>Upstox token exchange failed.</h3><pre>{json.dumps(tok)}</pre>", status_code=resp.status_code)
    expires_in = tok.get("expires_in")
    save_settings({"upstox_access_token": tok.get("access_token"), "upstox_refresh_token": tok.get("refresh_token"), "token_expires_at": int(time.time()) + int(expires_in) if expires_in else None, "redirect_uri": redirect_uri, "user_id": user_id})
    await _sync_token_to_supabase(user_id, tok, redirect_uri)
    return HTMLResponse(
        "<h3>Upstox connected. You can close this tab and return to Zenith Trader.</h3>"
        "<script>setTimeout(function(){ window.close(); }, 1200);</script>"
    )


# ---------------------------------------------------------------------------
# System status
# ---------------------------------------------------------------------------

@router.post("/system-status")
async def system_status(req: Request):
    body = await _read_json(req)
    target = body.get("target") or "all"
    s = load_settings()
    token = (s.get("upstox_access_token") or "").strip()
    checked_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    async def check_upstox():
        if not token:
            return {"ok": False, "message": "Upstox access token is missing. Complete OAuth again from API Settings."}
        try:
            async with _client() as c:
                r = await c.get(
                    "https://api.upstox.com/v2/user/profile",
                    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                )
            if r.status_code >= 400:
                payload = {}
                try:
                    payload = r.json()
                except ValueError:
                    pass
                if _is_invalid_token(payload):
                    _clear_token()
                return {"ok": False, "message": "Upstox token check failed. Reconnect OAuth.", "details": {"status": r.status_code, "payload": payload}}
            return {"ok": True, "message": "Upstox token verified by live market data fetch.", "details": {"status": r.status_code}}
        except Exception as e:
            return {"ok": False, "message": f"Upstox check error: {e}"}

    gemini_stub = {"ok": True, "message": "OpenAI check skipped on VPS."}

    if target == "upstox":
        upstox = await check_upstox()
        return JSONResponse({"upstox": upstox, "checkedAt": checked_at})
    if target in ("openai", "gemini"):
        return JSONResponse({"gemini": gemini_stub, "checkedAt": checked_at})
    upstox = await check_upstox()
    return JSONResponse({"ready": upstox["ok"], "upstox": upstox, "gemini": gemini_stub, "checkedAt": checked_at})


# ---------------------------------------------------------------------------
# Upstox helpers
# ---------------------------------------------------------------------------

async def _get_quotes(client: httpx.AsyncClient, instrument_keys: List[str], headers) -> Dict[str, Any]:
    encoded = quote(",".join(instrument_keys), safe="")
    r = await client.get(
        f"https://api.upstox.com/v2/market-quote/quotes?instrument_key={encoded}",
        headers=headers,
    )
    payload = {}
    try:
        payload = r.json()
    except ValueError:
        pass
    return {"status": r.status_code, "payload": payload}


def _quote_for(payload: Dict[str, Any], instrument_key: str) -> Dict[str, Any]:
    data = payload.get("data") or {}
    # Upstox /market-quote/quotes returns keys like "NSE_INDEX:Nifty 50"
    # while our instrument_key uses the pipe separator "NSE_INDEX|Nifty 50".
    # Normalise both so the lookup actually hits.
    candidates = {
        instrument_key,
        instrument_key.replace("|", ":"),
        instrument_key.replace(":", "|"),
    }
    node = None
    # 1) match by response dict key
    for k, v in data.items():
        if not isinstance(v, dict):
            continue
        if k in candidates:
            node = v
            break
    # 2) match by inner instrument_token / instrument_key field
    if node is None:
        for v in data.values():
            if not isinstance(v, dict):
                continue
            tok = str(v.get("instrument_token") or v.get("instrument_key") or "")
            if tok in candidates:
                node = v
                break
    # 3) last resort: first value with a usable last_price
    if node is None and data:
        for v in data.values():
            if isinstance(v, dict) and (v.get("last_price") is not None or v.get("ltp") is not None):
                node = v
                break
        if node is None:
            node = next(iter(data.values()))
    node = node or {}
    ohlc = node.get("ohlc") or {}
    depth = node.get("depth") or {}
    return {
        "ltp": _num(node.get("last_price"), node.get("ltp"), node.get("lastPrice")),
        "open": _num(ohlc.get("open"), ohlc.get("o")),
        "high": _num(ohlc.get("high"), ohlc.get("h")),
        "low": _num(ohlc.get("low"), ohlc.get("l")),
        "close": _num(ohlc.get("close"), ohlc.get("c"), node.get("close_price")),
        "volume": _num(
            node.get("volume"),
            node.get("volume_traded"),
            node.get("totalTradedVolume"),
            node.get("total_traded_volume"),
            depth.get("total_buy_quantity"),
            depth.get("total_sell_quantity"),
        ),
    }


async def _get_funds(client: httpx.AsyncClient, headers):
    try:
        r = await client.get(
            "https://api.upstox.com/v2/user/get-funds-and-margin?segment=SEC", headers=headers
        )
        payload = r.json() if r.content else {}
        if r.status_code >= 400:
            return {"availableCash": None, "usedMargin": None, "todayPnl": None, "error": f"Funds HTTP {r.status_code}"}
        equity = (payload.get("data") or {}).get("equity") or (payload.get("data") or {}).get("SEC") or payload.get("data") or {}
        return {
            "availableCash": _num(equity.get("available_margin"), equity.get("availableMargin"), equity.get("cash"), equity.get("available_cash"), equity.get("net")),
            "usedMargin": _num(equity.get("used_margin"), equity.get("usedMargin"), equity.get("utilised_margin"), equity.get("utilized_margin")),
            "todayPnl": _num(equity.get("realized_profit_and_loss"), equity.get("realised_profit_and_loss"), equity.get("realized_pnl"), equity.get("realised_pnl"), equity.get("pnl"), equity.get("mtm")),
            "error": None,
        }
    except Exception as e:
        return {"availableCash": None, "usedMargin": None, "todayPnl": None, "error": str(e)}


async def _get_option_chain_pcr(client: httpx.AsyncClient, headers):
    try:
        encoded = quote(INSTRUMENT_KEY, safe="")
        r1 = await client.get(f"https://api.upstox.com/v2/option/contract?instrument_key={encoded}", headers=headers)
        cp = r1.json() if r1.content else {}
        rows = cp.get("data") if isinstance(cp.get("data"), list) else []
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        expiries = sorted({str(r.get("expiry") or r.get("expiry_date") or "") for r in rows if (r.get("expiry") or r.get("expiry_date"))})
        expiry = next((e for e in expiries if e >= today), expiries[0] if expiries else None)
        if not expiry:
            return {"pcr": None, "totalVolume": None, "expiry": None, "error": "no expiry"}
        r2 = await client.get(
            f"https://api.upstox.com/v2/option/chain?instrument_key={encoded}&expiry_date={expiry}",
            headers=headers,
        )
        op = r2.json() if r2.content else {}
        if r2.status_code >= 400:
            return {"pcr": None, "totalVolume": None, "expiry": expiry, "error": f"chain HTTP {r2.status_code}"}
        rows = op.get("data") if isinstance(op.get("data"), list) else []
        call_oi = put_oi = call_vol = put_vol = 0.0
        for row in rows:
            ce = (row.get("call_options") or {}).get("market_data") or {}
            pe = (row.get("put_options") or {}).get("market_data") or {}
            call_oi += _num(ce.get("oi"), ce.get("open_interest")) or 0
            put_oi += _num(pe.get("oi"), pe.get("open_interest")) or 0
            call_vol += _num(ce.get("volume"), ce.get("volume_traded")) or 0
            put_vol += _num(pe.get("volume"), pe.get("volume_traded")) or 0
        pcr = round(put_oi / call_oi, 3) if call_oi > 0 else None
        return {"pcr": pcr, "totalVolume": (call_vol + put_vol) or None, "expiry": expiry, "error": None}
    except Exception as e:
        return {"pcr": None, "totalVolume": None, "expiry": None, "error": str(e)}


async def _get_yesterday(client: httpx.AsyncClient, headers):
    try:
        to = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        frm = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
        encoded = quote(INSTRUMENT_KEY, safe="")
        r = await client.get(
            f"https://api.upstox.com/v2/historical-candle/{encoded}/day/{to}/{frm}",
            headers=headers,
        )
        p = r.json() if r.content else {}
        if r.status_code >= 400:
            return {"pdh": None, "pdl": None, "pdc": None, "pdo": None, "date": None, "error": f"hist HTTP {r.status_code}"}
        candles = ((p.get("data") or {}).get("candles") or [])
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        prev = next((c for c in candles if str(c[0])[:10] < today), candles[1] if len(candles) > 1 else (candles[0] if candles else None))
        if not prev:
            return {"pdh": None, "pdl": None, "pdc": None, "pdo": None, "date": None, "error": "no candle"}
        return {
            "pdo": _num(prev[1]), "pdh": _num(prev[2]), "pdl": _num(prev[3]), "pdc": _num(prev[4]),
            "date": str(prev[0])[:10], "error": None,
        }
    except Exception as e:
        return {"pdh": None, "pdl": None, "pdc": None, "pdo": None, "date": None, "error": str(e)}


async def _resolve_atm(client: httpx.AsyncClient, headers, ltp: Optional[float]):
    if ltp is None:
        return {"atmStrike": None, "ce": None, "pe": None, "expiry": None, "error": "no ltp"}
    atm = round(ltp / 50) * 50
    encoded = quote(INSTRUMENT_KEY, safe="")
    try:
        r = await client.get(f"https://api.upstox.com/v2/option/contract?instrument_key={encoded}", headers=headers)
        p = r.json() if r.content else {}
        if r.status_code >= 400:
            return {"atmStrike": atm, "ce": None, "pe": None, "expiry": None, "error": f"contract HTTP {r.status_code}"}
        rows = p.get("data") if isinstance(p.get("data"), list) else []
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        expiries = sorted({str(r.get("expiry") or r.get("expiry_date") or "") for r in rows if (r.get("expiry") or r.get("expiry_date"))})
        expiry = next((e for e in expiries if e >= today), expiries[0] if expiries else None)
        if not expiry:
            return {"atmStrike": atm, "ce": None, "pe": None, "expiry": None, "error": "no expiry"}

        def find(t):
            for row in rows:
                rExp = str(row.get("expiry") or row.get("expiry_date") or "")
                rType = str(row.get("instrument_type") or row.get("option_type") or row.get("optionType") or "").upper()
                rStrike = _num(row.get("strike_price"), row.get("strikePrice"), row.get("strike"))
                if rExp == expiry and t in rType and rStrike == atm:
                    return row
            return None

        ce_row = find("CE")
        pe_row = find("PE")

        async def opt_ltp(token):
            if not token:
                return None
            rr = await client.get(
                f"https://api.upstox.com/v2/market-quote/ltp?instrument_key={quote(token, safe='')}",
                headers=headers,
            )
            pp = rr.json() if rr.content else {}
            print(f"[atm] CE/PE quote token={token} status={rr.status_code} payload={pp}")
            if rr.status_code >= 400:
                return None
            data = pp.get("data") or {}
            node = next(iter(data.values()), {}) if data else {}
            return _num(node.get("last_price"), node.get("ltp"), node.get("lastPrice"))

        ce_token = str((ce_row or {}).get("instrument_key") or (ce_row or {}).get("instrumentKey") or (ce_row or {}).get("instrument_token") or "") or None
        pe_token = str((pe_row or {}).get("instrument_key") or (pe_row or {}).get("instrumentKey") or (pe_row or {}).get("instrument_token") or "") or None
        ce_ltp, pe_ltp = await asyncio.gather(opt_ltp(ce_token), opt_ltp(pe_token))
        return {
            "atmStrike": atm, "expiry": expiry,
            "ce": {"instrumentToken": ce_token, "tradingSymbol": f"Nifty {atm} CE", "strike": atm, "ltp": ce_ltp} if ce_token else None,
            "pe": {"instrumentToken": pe_token, "tradingSymbol": f"Nifty {atm} PE", "strike": atm, "ltp": pe_ltp} if pe_token else None,
            "error": None,
        }
    except Exception as e:
        return {"atmStrike": atm, "ce": None, "pe": None, "expiry": None, "error": str(e)}


# ---------------------------------------------------------------------------
# fetch-nifty-data — frontend-shape compatible
# ---------------------------------------------------------------------------

@router.post("/fetch-nifty-data")
async def fetch_nifty_data(req: Request):
    body = await _read_json(req)
    trading_lot_size = body.get("tradingLotSize") if isinstance(body.get("tradingLotSize"), int) and body.get("tradingLotSize") > 0 else None
    trading_quantity = trading_lot_size * NIFTY_LOT_SIZE if trading_lot_size else (body.get("tradingQuantity") if isinstance(body.get("tradingQuantity"), int) and body.get("tradingQuantity") > 0 else None)
    execution_intent = body.get("executionIntent") is True

    headers = _auth_headers()

    async with _client() as client:
        quote_keys = [INSTRUMENT_KEY, CONTEXT_BANKNIFTY, CONTEXT_VIX, *CONTEXT_HEAVY]
        quotes_resp = await _get_quotes(client, quote_keys, headers)
        if quotes_resp["status"] >= 400:
            payload = quotes_resp["payload"]
            if _is_invalid_token(payload):
                _clear_token()
                return JSONResponse(
                    {"error": "Upstox OAuth reconnect required", "details": "Saved token is invalid. Re-run OAuth from API Settings."},
                    status_code=401,
                )
            # rate limit fallback
            details = json.dumps(payload)
            if "UDAPI10005" in details or quotes_resp["status"] == 429:
                if _market_cache.get("data"):
                    return JSONResponse({
                        "success": True, "fallback": True, "rateLimited": True, "retryAfterMs": 5000,
                        "error": "Upstox rate limit (UDAPI10005)", "details": details,
                        "data": _market_cache["data"],
                    })
            return JSONResponse({"error": "Upstox Nifty request failed", "details": details}, status_code=502)

    quote_payload = quotes_resp["payload"]
        nifty_q = _quote_for(quote_payload, INSTRUMENT_KEY)
        ltp = nifty_q["ltp"]
        print(f"[fetch-nifty-data] spot LTP={ltp}")

        option_chain, margin, yesterday, atm = await asyncio.gather(
            _get_option_chain_pcr(client, headers),
            _get_funds(client, headers),
            _get_yesterday(client, headers),
            _resolve_atm(client, headers, ltp),
        )
        print(f"[fetch-nifty-data] funds={margin}")
        print(f"[fetch-nifty-data] atm strike={atm.get('atmStrike')} expiry={atm.get('expiry')} CE={(atm.get('ce') or {}).get('tradingSymbol')} PE={(atm.get('pe') or {}).get('tradingSymbol')} CE_LTP={(atm.get('ce') or {}).get('ltp')} PE_LTP={(atm.get('pe') or {}).get('ltp')} err={atm.get('error')}")

    bank_q = _quote_for(quote_payload, CONTEXT_BANKNIFTY)
    vix_q = _quote_for(quote_payload, CONTEXT_VIX)
    heavy = [_quote_for(quote_payload, k) for k in CONTEXT_HEAVY]

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data_row = {
        "id": f"vps-{int(time.time()*1000)}",
        "user_id": "vps",
        "symbol": INSTRUMENT_KEY,
        "ltp": ltp,
        "open_price": nifty_q["open"],
        "high_price": nifty_q["high"],
        "low_price": nifty_q["low"],
        "close_price": nifty_q["close"],
        "source_timestamp": now_iso,
        "created_at": now_iso,
        "raw_payload": {
            "quote": quote_payload,
            "volume": nifty_q["volume"] or option_chain.get("totalVolume"),
            "volumeSource": "upstox_quote" if nifty_q["volume"] is not None else ("upstox_option_chain" if option_chain.get("totalVolume") else None),
            "volumeStatus": "available" if (nifty_q["volume"] or option_chain.get("totalVolume")) else "unavailable",
            "optionChain": {
                "pcr": option_chain.get("pcr"),
                "totalVolume": option_chain.get("totalVolume"),
                "expiry": option_chain.get("expiry"),
                "error": option_chain.get("error"),
            },
            "account": {
                "margin": {
                    "availableCash": margin.get("availableCash"),
                    "usedMargin": margin.get("usedMargin"),
                    "error": margin.get("error"),
                },
                "todayPnl": margin.get("todayPnl"),
            },
            "context": {
                "bankNifty": bank_q,
                "indiaVix": vix_q,
                "heavyweights": [h for h in heavy if h.get("ltp") is not None],
                "yesterday": yesterday,
                "atm": atm,
            },
            "execution": {
                "intent": execution_intent,
                "tradingLotSize": trading_lot_size,
                "niftyLotSize": NIFTY_LOT_SIZE,
                "tradingQuantity": trading_quantity,
            },
        },
    }
    _market_cache["data"] = data_row
    _market_cache["ts"] = time.time()

    ce = (atm or {}).get("ce") or {}
    pe = (atm or {}).get("pe") or {}
    summary = {
        "spot_ltp": ltp,
        "available_cash": margin.get("availableCash"),
        "today_pnl": margin.get("todayPnl"),
        "atm_strike": (atm or {}).get("atmStrike"),
        "atm_expiry": (atm or {}).get("expiry"),
        "atm_ce_ltp": ce.get("ltp"),
        "atm_pe_ltp": pe.get("ltp"),
        "ce_symbol": ce.get("tradingSymbol"),
        "pe_symbol": pe.get("tradingSymbol"),
        "ce_instrument_token": ce.get("instrumentToken"),
        "pe_instrument_token": pe.get("instrumentToken"),
    }
    print(f"[fetch-nifty-data] summary={summary}")
    return JSONResponse({"success": True, "data": data_row, **summary})


# ---------------------------------------------------------------------------
# /funds — standalone funds + margin endpoint
# ---------------------------------------------------------------------------

@router.get("/funds")
async def get_funds():
    headers = _auth_headers()
    async with _client() as client:
        funds = await _get_funds(client, headers)
    print(f"[funds] {funds}")
    return JSONResponse({
        "success": funds.get("error") is None,
        "available_cash": funds.get("availableCash"),
        "used_margin": funds.get("usedMargin"),
        "today_pnl": funds.get("todayPnl"),
        "error": funds.get("error"),
    })


# ---------------------------------------------------------------------------
# fetch-option-premium — returns { premium, instrument: { tradingSymbol } }
# ---------------------------------------------------------------------------

@router.post("/fetch-option-premium")
async def fetch_option_premium(req: Request):
    body = await _read_json(req)
    instrument_token = body.get("instrumentToken") or body.get("instrumentKey") or body.get("instrument_key")
    if not instrument_token:
        raise HTTPException(status_code=400, detail="instrumentToken is required")
    headers = _auth_headers()
    async with _client() as client:
        r = await client.get(
            f"https://api.upstox.com/v2/market-quote/ltp?instrument_key={quote(str(instrument_token), safe='')}",
            headers=headers,
        )
    payload = {}
    try:
        payload = r.json()
    except ValueError:
        pass
    if r.status_code >= 400:
        if _is_invalid_token(payload):
            _clear_token()
            return JSONResponse({"error": "Upstox OAuth reconnect required"}, status_code=401)
        return JSONResponse({"error": "premium fetch failed", "details": payload}, status_code=r.status_code)
    data = payload.get("data") or {}
    node = next(iter(data.values()), {}) if data else {}
    premium = _num(node.get("last_price"), node.get("ltp"), node.get("lastPrice")) or 0
    symbol = node.get("symbol") or node.get("trading_symbol") or str(instrument_token)
    return JSONResponse({"premium": premium, "instrument": {"tradingSymbol": symbol}})


# ---------------------------------------------------------------------------
# Trading routes — pass-through (frontend payload already validated by edge schema).
# These return Upstox raw response. For full execution layer (slippage/SL),
# keep using the Supabase edge function path; VPS pass-through is a fallback
# so that orders still hit Upstox from the static IP.
# ---------------------------------------------------------------------------

@router.post("/place-live-order")
async def place_live_order(req: Request):
    body = await _read_json(req)
    headers = {**_auth_headers(), "Content-Type": "application/json"}
    async with _client() as client:
        resp = await client.post("https://api.upstox.com/v2/order/place", json=body, headers=headers)
    try:
        payload = resp.json()
    except ValueError:
        payload = {}
    return JSONResponse(payload, status_code=resp.status_code)


@router.post("/modify-stop-loss-order")
async def modify_stop_loss_order(req: Request):
    body = await _read_json(req)
    headers = {**_auth_headers(), "Content-Type": "application/json"}
    async with _client() as client:
        resp = await client.put("https://api.upstox.com/v2/order/modify", json=body, headers=headers)
    try:
        payload = resp.json()
    except ValueError:
        payload = {}
    return JSONResponse(payload, status_code=resp.status_code)


@router.post("/emergency-exit")
async def emergency_exit(req: Request):
    headers = {**_auth_headers(), "Content-Type": "application/json"}
    async with _client() as client:
        resp = await client.post("https://api.upstox.com/v2/order/cancel-all", headers=headers)
    try:
        payload = resp.json()
    except ValueError:
        payload = {}
    return JSONResponse(payload, status_code=resp.status_code)
