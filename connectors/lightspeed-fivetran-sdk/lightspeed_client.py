"""
Lightspeed R-Series HTTP client for the Fivetran SDK connector: token supply,
the vendor's leaky-bucket rate governor, and the retry discipline R-Series needs.

Tokens never live in Fivetran configuration. Albert keeps the OAuth grant in its
vault; the connector asks Albert's sync worker for a short-lived access token
through a per-connection bearer secret (the "token broker"), which also returns
the R-Series account id the grant covers. A static `lightspeed_access_token` +
`lightspeed_account_id` pair is accepted only for local debugging.

R-Series limits (connectors/lightspeed-r/rate-governor.ts): a leaky bucket
reported live on every response (`X-LS-API-Bucket-Level: level/capacity`,
`X-LS-API-Drip-Rate` units/second; a GET costs 1) plus an undocumented
one-second burst limiter. The header is truth: the local model exists only to
pace between responses and snaps back to the server's numbers on every call.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API_ORIGIN = "https://api.lightspeedapp.com"
MAX_ATTEMPTS = 6
USER_AGENT = "albert-fivetran-lightspeed-r/1"


class LightspeedError(Exception):
    pass


class NotAvailable(LightspeedError):
    """403/404 — the endpoint is not reachable for this account (plan-gated,
    absent, or outside the grant). Recorded, never fatal."""


class TokenBrokerError(LightspeedError):
    pass


def _log(message: str, level: str = "INFO") -> None:
    try:
        from fivetran_connector_sdk import Logging as log  # type: ignore

        getattr(log, {"INFO": "info", "WARNING": "warning", "SEVERE": "severe"}.get(level, "info"))(message)
    except Exception:  # pragma: no cover - outside Fivetran runtime
        print(f"[{level}] {message}")


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


class TokenSupply:
    """Access-token supply: static token for tests, Albert's broker in production."""

    def __init__(self, configuration: dict):
        self.static_token = (configuration.get("lightspeed_access_token") or "").strip() or None
        self.broker_url = (configuration.get("albert_token_url") or "").strip() or None
        self.broker_secret = (configuration.get("albert_token_secret") or "").strip() or None
        self.tenant_id = (configuration.get("albert_tenant_id") or "").strip()
        self.connection_id = (configuration.get("albert_connection_id") or "").strip()
        self.account_id = (configuration.get("lightspeed_account_id") or "").strip() or None
        self._token: str | None = None
        self._expires_at: datetime | None = None
        if not self.static_token and not (self.broker_url and self.broker_secret):
            raise TokenBrokerError(
                "configuration needs albert_token_url + albert_token_secret "
                "(or lightspeed_access_token + lightspeed_account_id for debugging)"
            )

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
                "user-agent": USER_AGENT,
            },
        )
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = json.loads(response.read().decode("utf-8"))
                result = body.get("result", body)
                token = result.get("accessToken")
                if not isinstance(token, str) or not token:
                    raise TokenBrokerError("token broker returned no access token")
                self._token = token
                self._expires_at = _parse_iso(result.get("expiresAt")) or (now + timedelta(minutes=25))
                account = result.get("externalAccountId") or result.get("lightspeedAccountId")
                if isinstance(account, str) and account:
                    self.account_id = account
                return token
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")[:200]
                if error.code in (401, 403, 404, 409):
                    raise TokenBrokerError(f"token broker refused ({error.code}): {detail}")
                last_error = TokenBrokerError(f"token broker error {error.code}: {detail}")
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                last_error = TokenBrokerError(f"token broker unreachable: {error}")
            time.sleep(2 * (attempt + 1))
        raise last_error or TokenBrokerError("token broker unavailable")


class RateGovernor:
    """
    Port of LightspeedRateGovernor: a modelled leaky bucket snapped to the
    vendor's headers, plus a learned one-second burst window. Never sleeps a
    fixed interval — a fixed second wastes a third of the rate off-peak.
    """

    MAX_WAIT_S = 60.0
    BURST_RECOVERY_WINDOWS = 12

    def __init__(self, capacity: float = 60.0, drip_rate: float = 1.0, headroom: float = 2.0,
                 burst_cap: int = 6, min_burst_cap: int = 1, now=None):
        self.capacity = capacity
        self.drip_rate = drip_rate
        self.headroom = headroom
        self.level = 0.0
        self.burst_cap = burst_cap
        self.min_burst_cap = min_burst_cap
        self.now = now or time.monotonic
        self.last_drip_at = self.now()
        self.burst_window_start = 0.0
        self.burst_window_count = 0
        self.clean_windows = 0
        self.calibrated = False

    def _drip(self, now: float) -> None:
        elapsed = now - self.last_drip_at
        if elapsed <= 0:
            return
        self.level = max(0.0, self.level - elapsed * self.drip_rate)
        self.last_drip_at = now

    def delay_for(self, cost: float = 1.0) -> float:
        now = self.now()
        self._drip(now)
        usable = max(1.0, self.capacity - self.headroom)
        bucket_wait = 0.0 if self.level + cost <= usable else (self.level + cost - usable) / self.drip_rate
        window_elapsed = now - self.burst_window_start
        burst_wait = (1.0 - window_elapsed) if window_elapsed < 1.0 and self.burst_window_count >= self.burst_cap else 0.0
        return min(self.MAX_WAIT_S, max(bucket_wait, burst_wait, 0.0))

    def commit(self, cost: float = 1.0) -> None:
        now = self.now()
        self._drip(now)
        self.level += cost
        if now - self.burst_window_start >= 1.0:
            if self.burst_window_count > 0:
                self.clean_windows += 1
                if self.clean_windows >= self.BURST_RECOVERY_WINDOWS:
                    self.burst_cap += 1
                    self.clean_windows = 0
            self.burst_window_start = now
            self.burst_window_count = 0
        self.burst_window_count += 1

    def observe(self, headers) -> None:
        def read(name: str):
            if headers is None:
                return None
            try:
                return headers.get(name) or headers.get(name.lower())
            except AttributeError:
                return None

        try:
            drip = float(read("X-LS-API-Drip-Rate") or "")
            if drip > 0:
                self.drip_rate = drip
        except ValueError:
            pass
        bucket = read("X-LS-API-Bucket-Level")
        if not bucket:
            return
        parts = str(bucket).split("/")
        try:
            level = float(parts[0])
            capacity = float(parts[1])
        except (IndexError, ValueError):
            return
        if capacity <= 0:
            return
        self.capacity = capacity
        self.level = max(0.0, level)
        self.last_drip_at = self.now()
        self.calibrated = True

    def throttle_wait(self, body: str, headers) -> float:
        """Classify a 429 and return how long to wait."""
        self.observe(headers)
        if re.search(r"burst\s+rate\s+limit", body or "", re.IGNORECASE):
            self.burst_cap = max(self.min_burst_cap, self.burst_cap // 2)
            self.clean_windows = 0
            return 1.0
        usable = max(1.0, self.capacity - self.headroom)
        if self.level >= usable:
            deficit = self.level - usable + 1
            return min(self.MAX_WAIT_S, deficit / self.drip_rate)
        return min(self.MAX_WAIT_S, 1.0 / self.drip_rate)


def _retry_after(value) -> float | None:
    try:
        seconds = float(value)
        return max(0.5, min(seconds, 24 * 3600))
    except (TypeError, ValueError):
        return None


class LightspeedClient:
    def __init__(self, configuration: dict, tokens: TokenSupply | None = None, origin: str | None = None,
                 governor: RateGovernor | None = None, sleep=None):
        # `lightspeed_origin` exists for local debugging against a mock only.
        self.origin = (origin or (configuration.get("lightspeed_origin") or "").strip() or API_ORIGIN).rstrip("/")
        self.tokens = tokens or TokenSupply(configuration)
        self.governor = governor or RateGovernor()
        self.sleep = sleep or time.sleep
        self.calls = 0

    @property
    def account_id(self) -> str | None:
        return self.tokens.account_id

    def account_path(self, path: str) -> str:
        if path.startswith("/"):
            return path
        # The Account resource is the one endpoint that lives above the account
        # path (GET /API/V3/Account.json lists the accounts a token can see).
        if path == "Account.json":
            return "/API/V3/Account.json"
        if not self.tokens.account_id:
            self.tokens.token()
        if not self.tokens.account_id:
            raise TokenBrokerError("no Lightspeed account id: the token broker did not return one")
        return f"/API/V3/Account/{urllib.parse.quote(str(self.tokens.account_id), safe='')}/{path}"

    def discover_account(self) -> dict:
        """GET /API/V3/Account.json — the R-Series variant check and account identity."""
        _, body = self.get_json("/API/V3/Account.json")
        account = (body or {}).get("Account")
        if isinstance(account, list):
            account = account[0] if account else {}
        if isinstance(account, dict) and account.get("accountID") and not self.tokens.account_id:
            self.tokens.account_id = str(account["accountID"])
        return account if isinstance(account, dict) else {}

    def get_json(self, path: str, params: dict | None = None):
        """
        GET a JSON document under the account (or an absolute /API path).
        Returns (status, body). Raises NotAvailable on 403/404.
        """
        query = urllib.parse.urlencode(params or {}, quote_via=urllib.parse.quote)
        url = f"{self.origin}{self.account_path(path)}" + (f"?{query}" if query else "")
        force_refresh = False
        for attempt in range(MAX_ATTEMPTS):
            token = self.tokens.token(force=force_refresh)
            force_refresh = False
            wait = self.governor.delay_for(1.0)
            if wait > 0:
                self.sleep(wait)
            self.governor.commit(1.0)
            self.calls += 1
            request = urllib.request.Request(
                url,
                headers={"accept": "application/json", "authorization": f"Bearer {token}", "user-agent": USER_AGENT},
                method="GET",
            )
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    self.governor.observe(response.headers)
                    raw = response.read()
                    if not raw:
                        return response.status, {}
                    return response.status, json.loads(raw.decode("utf-8"))
            except urllib.error.HTTPError as error:
                status = error.code
                body = error.read().decode("utf-8", "replace")
                self.governor.observe(error.headers)
                if status == 401:
                    if attempt >= 1:
                        raise LightspeedError(f"Lightspeed rejected the access token twice for {path}")
                    force_refresh = True
                    continue
                if status in (403, 404):
                    raise NotAvailable(f"{status} for {path}: {body[:160]}")
                if status == 429:
                    wait = _retry_after(error.headers.get("Retry-After")) or self.governor.throttle_wait(body, error.headers)
                    _log(f"Lightspeed 429 on {path}; sleeping {wait:.1f}s", "WARNING")
                    self.sleep(wait)
                    continue
                if status >= 500 or status == 408:
                    self.sleep(min(60, 2 ** attempt))
                    continue
                raise LightspeedError(f"Lightspeed {status} for {path}: {body[:200]}")
            except (urllib.error.URLError, TimeoutError) as error:
                self.sleep(min(60, 2 ** attempt))
                if attempt == MAX_ATTEMPTS - 1:
                    raise LightspeedError(f"Lightspeed unreachable for {path}: {error}")
            except json.JSONDecodeError as error:
                raise LightspeedError(f"Lightspeed returned non-JSON for {path}: {error}")
        raise LightspeedError(f"Lightspeed gave up after {MAX_ATTEMPTS} attempts for {path}")
