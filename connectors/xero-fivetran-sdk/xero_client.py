"""
Xero HTTP client for the Fivetran SDK connector: token supply, per-tenant
rate limiting, and the retry/backoff discipline Xero needs.

Tokens never live in Fivetran configuration. Albert keeps the OAuth grant in
its vault; the connector asks Albert's sync worker for a short-lived access
token through a per-connection bearer secret (the "token broker"). A static
`xero_access_token` is accepted only for local debugging.

Xero limits: 60 calls/min and 5,000 calls/day per tenant for certified apps —
but only 1,000/day for an uncertified app such as Albert's (observed: the
X-DayLimit-Remaining header). Minute limits are absorbed by pacing + honouring
Retry-After; hitting the daily limit raises DailyLimitReached so the sync can
checkpoint and end cleanly (Fivetran resumes on the next schedule). The client
also tracks the remaining daily allowance from every response so the sync can
stop BEFORE the budget is gone: the same allowance serves Albert's live Xero
report calls (balance sheet, bank balances), which must keep headroom.
"""
from __future__ import annotations

import http.client
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

XERO_ORIGIN = "https://api.xero.com"
CONNECTIONS_PATH = "/connections"  # cheap identity probe; not tenant-scoped
MIN_INTERVAL_SECONDS = 1.05  # ~57 calls/min, under Xero's 60/min per tenant
MAX_ATTEMPTS = 6
# A 5xx/timeout endpoint is retried this many times, not MAX_ATTEMPTS: the
# Payroll AU endpoints answered 5xx on every hourly sync and the 6-attempt
# loop alone burned ~70 of the 1,000 daily calls every hour.
SERVER_ERROR_ATTEMPTS = 3
DAY_LIMIT_HEADERS = ("X-DayLimit-Remaining", "X-DailyLimit-Remaining")


class XeroError(Exception):
    pass


class NotAvailable(XeroError):
    """403/404 — or a 401 that survives a token refresh while /connections still
    accepts the token: the endpoint is not reachable for this org/grant (scope tier,
    region, or a scope Xero will not issue to the app)."""


class DailyLimitReached(XeroError):
    """Xero's per-tenant daily limit is exhausted; try again on the next sync."""


class BudgetReserveReached(DailyLimitReached):
    """The remaining daily allowance fell to the reserve kept for live use.
    Stops a walk exactly like the hard daily limit (checkpoint, end cleanly)."""


class RateLimitStalled(DailyLimitReached):
    """Xero kept answering 429 after every honoured Retry-After: something else
    (live statement calls, business-context probes) is sharing this org's
    minute budget right now. Subclasses DailyLimitReached so the sync stops
    cleanly and resumes next schedule — a stall must never be recorded as a
    per-group error, which would put healthy endpoints into hours of cooldown
    (observed 2026-08-20: a first backfill's whole Payroll AU family)."""


class TokenBrokerError(XeroError):
    pass


def _log(message: str, level: str = "INFO") -> None:
    try:
        from fivetran_connector_sdk import Logging as log  # type: ignore

        getattr(log, {"INFO": "info", "WARNING": "warning", "SEVERE": "severe"}.get(level, "info"))(message)
    except Exception:  # pragma: no cover - outside Fivetran runtime
        print(f"[{level}] {message}")


class TokenSupply:
    """Access-token supply: static token for tests, Albert's broker in production."""

    def __init__(self, configuration: dict):
        self.static_token = (configuration.get("xero_access_token") or "").strip() or None
        self.broker_url = (configuration.get("albert_token_url") or "").strip() or None
        self.broker_secret = (configuration.get("albert_token_secret") or "").strip() or None
        self.tenant_id = (configuration.get("albert_tenant_id") or "").strip()
        self.connection_id = (configuration.get("albert_connection_id") or "").strip()
        self.xero_tenant_id = (configuration.get("xero_tenant_id") or "").strip() or None
        self._token: str | None = None
        self._expires_at: datetime | None = None
        if not self.static_token and not (self.broker_url and self.broker_secret):
            raise TokenBrokerError("configuration needs albert_token_url + albert_token_secret (or xero_access_token for debugging)")

    def token(self, force: bool = False) -> str:
        if self.static_token:
            return self.static_token
        now = datetime.now(timezone.utc)
        if not force and self._token and self._expires_at and self._expires_at - now > timedelta(minutes=3):
            return self._token
        payload = json.dumps({"tenantId": self.tenant_id, "connectionId": self.connection_id}).encode("utf-8")
        request = urllib.request.Request(
            self.broker_url.rstrip("/") + "/v1/fivetran/token",
            data=payload,
            method="POST",
            headers={
                "content-type": "application/json",
                "accept": "application/json",
                "authorization": f"Bearer {self.broker_secret}",
                "user-agent": "albert-fivetran-xero/1",
            },
        )
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = json.loads(response.read().decode("utf-8"))
                result = body.get("result", body)
                token = result.get("accessToken")
                expires_at = result.get("expiresAt")
                if not isinstance(token, str) or not token:
                    raise TokenBrokerError("token broker returned no access token")
                self._token = token
                self._expires_at = _parse_iso(expires_at) or (now + timedelta(minutes=25))
                if isinstance(result.get("xeroTenantId"), str) and result["xeroTenantId"]:
                    self.xero_tenant_id = result["xeroTenantId"]
                return token
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")[:200]
                if error.code in (401, 403, 404, 409):
                    raise TokenBrokerError(f"token broker refused ({error.code}): {detail}")
                last_error = TokenBrokerError(f"token broker error {error.code}: {detail}")
            # urllib wraps only request-send failures in URLError; errors while
            # reading the response (RemoteDisconnected, IncompleteRead, SSL EOF)
            # surface raw as OSError/http.client.HTTPException subclasses.
            except (OSError, http.client.HTTPException, json.JSONDecodeError) as error:
                last_error = TokenBrokerError(f"token broker unreachable: {error}")
            time.sleep(2 * (attempt + 1))
        raise last_error or TokenBrokerError("token broker unavailable")


def _parse_iso(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        text = value.replace("Z", "+00:00")
        if "." in text:
            head, tail = text.split(".", 1)
            zone = ""
            for marker in ("+", "-"):
                if marker in tail:
                    frac, zone = tail.split(marker, 1)
                    zone = marker + zone
                    tail = frac
                    break
            text = f"{head}.{tail[:6].ljust(6, '0')}{zone}"
        parsed = datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class XeroClient:
    def __init__(self, configuration: dict, tokens: TokenSupply | None = None, origin: str | None = None,
                 daily_reserve: int | None = None):
        # `xero_origin` exists for local debugging against a mock only.
        self.origin = (origin or (configuration.get("xero_origin") or "").strip() or XERO_ORIGIN).rstrip("/")
        self.tokens = tokens or TokenSupply(configuration)
        self._last_call = 0.0
        self.calls = 0
        # Remaining daily allowance as last reported by Xero (None until a
        # response carried the header). daily_reserve is how much of it the
        # sync must leave untouched for Albert's live report calls.
        self.day_remaining: int | None = None
        self.daily_reserve = int(daily_reserve or 0)

    @property
    def xero_tenant_id(self) -> str | None:
        return self.tokens.xero_tenant_id

    def _token_works(self) -> bool:
        """Probe /connections with the current token (no refresh, no retries)."""
        request = urllib.request.Request(
            f"{self.origin}{CONNECTIONS_PATH}",
            headers={
                "accept": "application/json",
                "authorization": f"Bearer {self.tokens.token()}",
                "user-agent": "albert-fivetran-xero/1",
            },
            method="GET",
        )
        self._pace()
        self.calls += 1
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return 200 <= response.status < 300
        except urllib.error.HTTPError as error:
            return error.code != 401
        except (OSError, http.client.HTTPException):
            return False

    def _pace(self) -> None:
        elapsed = time.monotonic() - self._last_call
        if elapsed < MIN_INTERVAL_SECONDS:
            time.sleep(MIN_INTERVAL_SECONDS - elapsed)
        self._last_call = time.monotonic()

    def get_json(self, path: str, params: dict | None = None, headers: dict | None = None,
                 tenant_scoped: bool = True):
        """
        GET a JSON document. Returns (status, body); status is 304 with body None
        when If-Modified-Since produced Not Modified. Raises NotAvailable on
        403/404 and DailyLimitReached when Xero's daily budget is exhausted.
        """
        self.check_reserve(path)
        query = urllib.parse.urlencode(params or {}, quote_via=urllib.parse.quote)
        url = f"{self.origin}{path}" + (f"?{query}" if query else "")
        force_refresh = False
        last_throttle = ""
        for attempt in range(MAX_ATTEMPTS):
            token = self.tokens.token(force=force_refresh)
            force_refresh = False
            request_headers = {
                "accept": "application/json",
                "authorization": f"Bearer {token}",
                "user-agent": "albert-fivetran-xero/1",
            }
            if tenant_scoped and self.tokens.xero_tenant_id:
                request_headers["xero-tenant-id"] = self.tokens.xero_tenant_id
            if headers:
                request_headers.update(headers)
            self._pace()
            self.calls += 1
            request = urllib.request.Request(url, headers=request_headers, method="GET")
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    self._observe_day_limit(response.headers)
                    raw = response.read()
                    if not raw:
                        return response.status, {}
                    return response.status, json.loads(raw.decode("utf-8"))
            except urllib.error.HTTPError as error:
                status = error.code
                body = error.read().decode("utf-8", "replace")
                self._observe_day_limit(error.headers)
                if status == 304:
                    return 304, None
                if status == 401:
                    # Xero answers 401 (not 403) for endpoints whose scope the app
                    # cannot hold — Journals, ExpenseClaims, Receipts,
                    # PaymentServices. Refresh once; if a fresh token is still
                    # refused here but accepted by /connections, the token is fine
                    # and the endpoint is simply out of scope for this grant.
                    if attempt >= 1:
                        if path != CONNECTIONS_PATH and self._token_works():
                            raise NotAvailable(f"401 for {path}: not in scope for this grant: {body[:160]}")
                        raise XeroError(f"Xero rejected the access token twice for {path}")
                    force_refresh = True
                    continue
                if status in (403, 404):
                    raise NotAvailable(f"{status} for {path}: {body[:160]}")
                if status == 429:
                    retry_after = _retry_after(error.headers.get("Retry-After"))
                    daily_remaining = _first_header(error.headers, DAY_LIMIT_HEADERS)
                    problem = (error.headers.get("X-Rate-Limit-Problem") or "").strip().lower()
                    if problem == "day" or (daily_remaining is not None and daily_remaining.strip() == "0") or retry_after > 900:
                        self.day_remaining = 0
                        raise DailyLimitReached(
                            f"Xero daily limit reached on {path} (problem={problem or '?'}, remaining={daily_remaining}, retry after {retry_after}s)"
                        )
                    minute_remaining = error.headers.get("X-MinLimit-Remaining")
                    last_throttle = (
                        f"problem={problem or '?'} retry_after={error.headers.get('Retry-After') or '?'}"
                        f" min_remaining={minute_remaining or '?'} day_remaining={daily_remaining or '?'}"
                        f" body={body[:120]}"
                    )
                    _log(f"Xero 429 on {path}; {last_throttle}; sleeping {retry_after}s", "WARNING")
                    time.sleep(retry_after)
                    continue
                if status >= 500 or status == 408:
                    if attempt + 1 >= SERVER_ERROR_ATTEMPTS:
                        raise XeroError(f"Xero {status} for {path} after {attempt + 1} attempts: {body[:160]}")
                    time.sleep(min(60, 2 ** attempt))
                    continue
                raise XeroError(f"Xero {status} for {path}: {body[:200]}")
            # urllib wraps only request-send failures in URLError; errors while
            # reading the response (RemoteDisconnected, IncompleteRead, SSL EOF)
            # surface raw as OSError/http.client.HTTPException subclasses.
            except (OSError, http.client.HTTPException) as error:
                if attempt + 1 >= SERVER_ERROR_ATTEMPTS:
                    raise XeroError(f"Xero unreachable for {path}: {error}")
                time.sleep(min(60, 2 ** attempt))
        # The loop can only run out of attempts on repeated 429s (401 refreshes
        # once then raises; 5xx and timeouts raise after SERVER_ERROR_ATTEMPTS).
        raise RateLimitStalled(
            f"Xero still throttling {path} after {MAX_ATTEMPTS} attempts with Retry-After honoured ({last_throttle})"
        )

    def _observe_day_limit(self, headers) -> None:
        value = _first_header(headers, DAY_LIMIT_HEADERS)
        if value is None:
            return
        try:
            self.day_remaining = max(0, int(str(value).strip()))
        except (TypeError, ValueError):
            return

    def reserve_exhausted(self) -> bool:
        """True once Xero reports less daily allowance than the live-use reserve."""
        return self.day_remaining is not None and self.daily_reserve > 0 and self.day_remaining <= self.daily_reserve

    def check_reserve(self, path: str) -> None:
        if self.reserve_exhausted():
            raise BudgetReserveReached(
                f"Xero daily allowance down to {self.day_remaining} (reserve {self.daily_reserve}) before {path}; leaving the rest for live Xero reports"
            )


def _first_header(headers, names) -> str | None:
    if headers is None:
        return None
    for name in names:
        try:
            value = headers.get(name)
        except AttributeError:
            value = None
        if value is not None:
            return value
    return None


def _retry_after(value) -> int:
    try:
        seconds = int(float(value))
        return max(1, min(seconds, 24 * 3600))
    except (TypeError, ValueError):
        return 60
